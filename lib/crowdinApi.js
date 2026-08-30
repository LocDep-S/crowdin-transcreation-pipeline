/**
 * Thin wrapper around the parts of the Crowdin REST API this app needs.
 * Docs: https://developer.crowdin.com/api/v2/
 *
 * Domain-scoped API host handling copied from the Subtitle Video & Timing
 * Editor precedent - Crowdin Enterprise orgs are NOT on api.crowdin.com.
 */

const axios = require("axios");

// "Transcreation" label is per-project (production project 9 = id 160, test
// project 52 = id 162 - confirmed different, as expected since Crowdin
// labels are project-scoped, not org-wide). Never hardcode an id - resolve
// it dynamically per project via getTranscreationLabelId below.
const TRANSCREATION_LABEL_NAME = "Transcreation";
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
 * independent of how/why the workflow step was entered. `labelId` must be
 * resolved first via getTranscreationLabelId (per-project, not a constant).
 */
function stringHasTranscreationLabel(stringObj, labelId) {
  return Array.isArray(stringObj.labelIds) && stringObj.labelIds.includes(labelId);
}

/**
 * Resolve the "Transcreation" label's id for a given project. Labels are
 * project-scoped in Crowdin (confirmed: production project 9 uses id 160,
 * test project 52 uses id 162) - there is no org-wide label, so this must be
 * looked up per project rather than hardcoded. Not cached across calls
 * (labels rarely change and this app's call volume is low - a webhook per
 * string, not per keystroke); add caching later if this becomes a hot path.
 */
async function getTranscreationLabelId(accessToken, domain, projectId) {
  return withDetailedErrors("getTranscreationLabelId", async () => {
    const api = client(accessToken, domain);
    const { data } = await api.get(`/projects/${projectId}/labels`, { params: { limit: 500 } });
    const labels = data.data.map((d) => d.data);
    const label = labels.find((l) => l.title === TRANSCREATION_LABEL_NAME);
    if (!label) {
      throw new Error(
        `No label named "${TRANSCREATION_LABEL_NAME}" found in project ${projectId}. ` +
          `This app cannot route labeled strings until that label exists in this project.`
      );
    }
    return label.id;
  });
}

/** GET /user - resolves the authenticated (agent) user's id, needed to call AI prompt completion endpoints, which are scoped under /users/{userId}/ai/... */
async function getAuthenticatedUserId(accessToken, domain) {
  return withDetailedErrors("getAuthenticatedUserId", async () => {
    const api = client(accessToken, domain);
    const { data } = await api.get("/user");
    return data.data.id;
  });
}

/**
 * List the organization's configured AI Prompts (org-level, not project-
 * scoped - confirmed via live inspection of the real org: 14 prompts
 * configured across 7 providers). Used to populate the workflow step
 * settings iframe's "AI prompt" dropdown, same data source as Crowdin's own
 * native AI Auto-Translation / AI Pre-translation step settings panel.
 */
async function listOrganizationAiPrompts(accessToken, domain) {
  return withDetailedErrors("listOrganizationAiPrompts", async () => {
    const api = client(accessToken, domain);
    const results = [];
    let offset = 0;
    const limit = 500;
    for (;;) {
      const { data } = await api.get("/ai/prompts", { params: { limit, offset } });
      results.push(...data.data.map((d) => d.data));
      if (data.data.length < limit) break;
      offset += limit;
    }
    return results;
  });
}

/**
 * Create an AI Prompt completion job (async - Crowdin's own docs confirm
 * this create->poll pattern via the documented GET .../completions/{id}
 * endpoint, but the exact request/response body shape for this specific
 * pair of calls was NOT independently confirmed against Crowdin's docs
 * (repeated doc-page fetches were blocked in the session that first wired
 * this up - see README). Implemented as the best available analog: an
 * OpenAI-chat-style `messages` array in, an object with at least
 * `identifier`/`status`/`progress` back (matching the one endpoint that
 * *was* confirmed). If Crowdin's real shape differs, this throws loudly
 * with the raw response body rather than silently misbehaving - fix the
 * shape here and in extractCompletionText once a real install surfaces the
 * mismatch.
 */
async function createAiPromptCompletion(accessToken, domain, userId, aiPromptId, messages) {
  return withDetailedErrors("createAiPromptCompletion", async () => {
    const api = client(accessToken, domain);
    const { data } = await api.post(`/users/${userId}/ai/prompts/${aiPromptId}/completions`, {
      stream: false,
      messages,
    });
    return data.data;
  });
}

/** GET /users/{userId}/ai/prompts/{aiPromptId}/completions/{completionId} - CONFIRMED endpoint (api.users.ai.prompts.completions.get in Crowdin's docs). Returns {identifier, status, progress, attributes, createdAt, updatedAt, startedAt, finishedAt, ...}. */
async function getAiPromptCompletion(accessToken, domain, userId, aiPromptId, completionId) {
  return withDetailedErrors("getAiPromptCompletion", async () => {
    const api = client(accessToken, domain);
    const { data } = await api.get(`/users/${userId}/ai/prompts/${aiPromptId}/completions/${completionId}`);
    return data.data;
  });
}

/**
 * Extract the generated text from a finished completion object. The exact
 * field name was NOT independently confirmed (see createAiPromptCompletion)
 * - this checks every plausible shape (OpenAI-style choices[].message, a
 * flatter result/text field) and throws with the full raw object if none
 * match, so a real mismatch is immediately debuggable instead of silently
 * returning undefined/garbage into a downstream JSON.parse.
 */
function extractCompletionText(completion) {
  const candidates = [
    completion?.response?.choices?.[0]?.message?.content,
    completion?.choices?.[0]?.message?.content,
    completion?.response?.choices?.[0]?.text,
    completion?.response?.result,
    completion?.result,
    completion?.text,
  ];
  const found = candidates.find((c) => typeof c === "string" && c.length > 0);
  if (found === undefined) {
    throw new Error(
      "extractCompletionText: could not find completion text in any expected field " +
        "(response.choices[0].message.content, choices[0].message.content, " +
        "response.choices[0].text, response.result, result, text). " +
        `Raw completion object: ${JSON.stringify(completion).slice(0, 2000)}`
    );
  }
  return found;
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
  TRANSCREATION_LABEL_NAME,
  BRIEF_FIELD_SLUG,
  getFile,
  listSourceStrings,
  getString,
  stringHasTranscreationLabel,
  getTranscreationLabelId,
  getAuthenticatedUserId,
  listOrganizationAiPrompts,
  createAiPromptCompletion,
  getAiPromptCompletion,
  extractCompletionText,
  ensureBriefFieldExists,
  readField,
  getBrief,
  saveBrief,
  addSuggestion,
  addStringComment,
  reportWorkflowStepOutput,
};
