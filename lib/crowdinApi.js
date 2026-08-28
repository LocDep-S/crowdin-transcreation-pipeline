/**
 * Thin wrapper around the parts of the Crowdin REST API this app needs.
 * Docs: https://developer.crowdin.com/api/v2/
 *
 * Domain-scoped API host handling copied from the Subtitle Video & Timing
 * Editor precedent - Crowdin Enterprise orgs are NOT on api.crowdin.com.
 */

const axios = require("axios");

const TRANSCREATION_LABEL_ID = 160; // "Transcreation" label, project 9 - see plan doc. Per-project; project 21 will need its own when onboarded.
const BRIEF_FIELD_SLUG = "transcreation-brief"; // file-scoped custom Field, JSON blob keyed by target language ID

function client(accessToken, domain) {
  const baseURL = domain ? `https://${domain}.api.crowdin.com/api/v2` : "https://api.crowdin.com/api/v2";
  return axios.create({
    baseURL,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** Wrap any Crowdin API call so the real error detail isn't lost to a truncated console.error. */
async function withDetailedErrors(label, fn) {
  try {
    return await fn();
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`${label} failed: ${detail}`);
  }
}

async function getFile(accessToken, domain, projectId, fileId) {
  return withDetailedErrors("getFile", async () => {
    const api = client(accessToken, domain);
    const { data } = await api.get(`/projects/${projectId}/files/${fileId}`);
    return data.data;
  });
}

/** List source strings for a file, in source order. */
async function listSourceStrings(accessToken, domain, projectId, fileId) {
  return withDetailedErrors("listSourceStrings", async () => {
    const api = client(accessToken, domain);
    const results = [];
    let offset = 0;
    const limit = 500;
    for (;;) {
      const { data } = await api.get(`/projects/${projectId}/strings`, {
        params: { fileId, limit, offset },
      });
      results.push(...data.data.map((d) => d.data));
      if (data.data.length < limit) break;
      offset += limit;
    }
    return results;
  });
}

async function getString(accessToken, domain, projectId, stringId) {
  return withDetailedErrors("getString", async () => {
    const api = client(accessToken, domain);
    const { data } = await api.get(`/projects/${projectId}/strings/${stringId}`);
    return data.data;
  });
}

/**
 * Belt-and-suspenders label check (Phase 3.2) - confirm the string's file
 * actually carries the Transcreation label before spending any AI budget,
 * independent of how/why the workflow step was entered.
 */
function stringHasTranscreationLabel(stringObj) {
  return Array.isArray(stringObj.labelIds) && stringObj.labelIds.includes(TRANSCREATION_LABEL_ID);
}

/** Idempotent "ensure the brief Field exists" - see crowdin-fields-api.md trap 1. Safe to call on every install and defensively before every write. */
async function ensureBriefFieldExists(accessToken, domain) {
  return withDetailedErrors("ensureBriefFieldExists", async () => {
    const api = client(accessToken, domain);
    const { data } = await api.get("/fields", { params: { entity: "file" } });
    const existing = data.data.find((f) => f.data.slug === BRIEF_FIELD_SLUG);
    if (existing) return existing.data;

    const { data: created } = await api.post("/fields", {
      name: "Transcreation Brief",
      slug: BRIEF_FIELD_SLUG,
      type: "textarea",
      entities: ["file"],
      config: { locations: [] }, // REQUIRED even though never shown in Crowdin's UI
      description: "App-managed. JSON blob keyed by target language ID, written by the Transcreation Pipeline app and read by the Regenerate panel. Do not hand-edit.",
    });
    return created.data;
  });
}

/** Defensive reader - entity.fields shape has not been consistent across Crowdin versions. */
function readField(entity, slug) {
  const fields = entity.fields;
  if (!fields) return null;
  let raw;
  if (Array.isArray(fields)) {
    raw = fields.find((f) => f.slug === slug || f.fieldSlug === slug)?.value;
  } else if (typeof fields === "object") {
    raw = fields[slug];
  }
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

/** Read the stored brief blob for one file, one language. Returns null if none yet. */
async function getBrief(accessToken, domain, projectId, fileId, languageId) {
  const file = await getFile(accessToken, domain, projectId, fileId);
  const all = readField(file, BRIEF_FIELD_SLUG) || {};
  return all[languageId] ?? null;
}

/**
 * Read-merge-write the brief blob for one (file, language) - never blind-
 * overwrite the whole blob, since other languages' briefs live in the same
 * Field value (crowdin-fields-api.md, "per-language data" section). Fetches
 * a FRESH copy of the file immediately before merging on every call, to
 * minimize the window for a lost update from a concurrent write for a
 * different language on the same file.
 */
async function saveBrief(accessToken, domain, projectId, fileId, languageId, briefPayload) {
  return withDetailedErrors("saveBrief", async () => {
    const api = client(accessToken, domain);
    const fresh = await getFile(accessToken, domain, projectId, fileId);
    const all = readField(fresh, BRIEF_FIELD_SLUG) || {};
    all[languageId] = briefPayload;
    await api.patch(`/projects/${projectId}/files/${fileId}`, [
      { op: "add", path: `/fields/${BRIEF_FIELD_SLUG}`, value: JSON.stringify(all) }, // "add" not "replace" - see crowdin-fields-api.md trap 2
    ]);
    return all;
  });
}

/** Submit a NEW translation suggestion for a string - never overwrite an existing one (locked decision in the plan). */
async function addSuggestion(accessToken, domain, projectId, stringId, languageId, text) {
  return withDetailedErrors("addSuggestion", async () => {
    const api = client(accessToken, domain);
    const { data } = await api.post(`/projects/${projectId}/translations`, {
      stringId,
      languageId,
      text,
    });
    return data.data;
  });
}

/** Post an audit comment on a string (used by the regenerate flow, Phase 4.4). */
async function addStringComment(accessToken, domain, projectId, stringId, text) {
  return withDetailedErrors("addStringComment", async () => {
    const api = client(accessToken, domain);
    const { data } = await api.post(`/projects/${projectId}/comments`, {
      stringId,
      text,
      type: "comment",
    });
    return data.data;
  });
}

/**
 * Report a workflow step's routing decision for one string (Phase 3.6).
 * `port` should be one of the step's declared output ports in manifest.json:
 * "translated" for success -> straight to Proofreading, or "untranslated"
 * for failure/no-result -> back into the normal AI Pre-translation chain.
 * NOTE: Crowdin's workflow-step-type ports are a fixed enum, not free-form
 * names - confirmed against a live install. "fallback" is NOT a valid port;
 * "untranslated" is the correct port for the failure case (verified via
 * Crowdin's docs after the app's first real install attempt was rejected
 * for exactly this - see README item 3 and the plan doc).
 */
async function reportWorkflowStepOutput(accessToken, domain, projectId, workflowStepId, languageId, stringId, port) {
  return withDetailedErrors("reportWorkflowStepOutput", async () => {
    const api = client(accessToken, domain);
    await api.patch(`/projects/${projectId}/workflow-steps/${workflowStepId}/languages/${languageId}/status`, [
      { op: "replace", path: `/${stringId}/output`, value: port },
    ]);
  });
}

module.exports = {
  TRANSCREATION_LABEL_ID,
  BRIEF_FIELD_SLUG,
  getFile,
  listSourceStrings,
  getString,
  stringHasTranscreationLabel,
  ensureBriefFieldExists,
  readField,
  getBrief,
  saveBrief,
  addSuggestion,
  addStringComment,
  reportWorkflowStepOutput,
};
