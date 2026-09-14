/**
 * Thin wrapper around the Vertex AI Gemini API. Every pipeline stage in
 * lib/pipeline.js goes through this - keeps credential handling, model
 * selection, and error handling in one place.
 *
 * SWITCHED 2026-09 from the Anthropic Messages API (lib/anthropic.js,
 * removed - see git history) to Vertex AI's Gemini API, authenticated via a
 * GCP service account rather than a plain API key. This is Vertex AI (part
 * of Google Cloud, authenticated with a service account and billed to a GCP
 * project), NOT the separate Gemini Developer API / Google AI Studio (which
 * uses a simple `AIza...` key) - the two are different products with
 * different auth and different endpoints, and are not interchangeable.
 *
 * SECURITY: the service account's full JSON keyfile lives ONLY in Render's
 * Secret Files (mounted at /etc/secrets/<filename> at runtime, never
 * committed to this repo, which is public). GOOGLE_APPLICATION_CREDENTIALS
 * points at that mounted path and google-auth-library reads it directly -
 * no key material is ever typed into code, checked into git, or logged.
 * Never log the raw error/response object from a failed call here (only
 * status/message, matching the discipline lib/crowdinApi.js's
 * withDetailedErrors already uses) - Vertex AI error bodies don't carry the
 * credential, but staying disciplined about what gets logged is what keeps
 * that true through future edits.
 */

const axios = require("axios");
const { GoogleAuth } = require("google-auth-library");

// google-auth-library reads GOOGLE_APPLICATION_CREDENTIALS (a filesystem
// path to the service account JSON keyfile - see file header) on its own;
// no key material is referenced directly anywhere in this file.
const auth = new GoogleAuth({
  scopes: "https://www.googleapis.com/auth/cloud-platform",
});

// Both required for the Vertex AI endpoint URL below. Deliberately NOT
// defaulted (unlike DEFAULT_MODEL) - guessing a project/region wrong would
// silently point this at the wrong GCP project, which is worse than a loud
// startup-time error.
const PROJECT_ID = process.env.GCP_PROJECT_ID;
const LOCATION = process.env.GCP_LOCATION || "us-central1";

// Per-stage model tier is an explicitly "still open" decision in the plan
// (cost ownership/budget) - flagged to Daniel, not decided unilaterally here.
// Defaulting every stage to the same model for now; revisit once that's
// confirmed - a cheaper/faster model may be fine for the more mechanical
// stages (data localization inventory, GEO checklist) vs. the creative
// writing/QA stages, which likely want the strongest available model.
// "-preview" models can change or be retired with less notice than a GA
// model - gemini-2.5-pro is the stable fallback if that becomes a problem.
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";

function endpointFor(model) {
  return `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${model}:generateContent`;
}

/** Wrap a Vertex AI call so a failure surfaces a clean, safe message - never the raw error/response object (see file header re: logging discipline). */
async function withDetailedErrors(label, fn) {
  try {
    return await fn();
  } catch (err) {
    const detail = err?.response?.data?.error?.message || err?.message || String(err);
    const status = err?.response?.status ? ` (status ${err.response.status})` : "";
    throw new Error(`${label} failed${status}: ${detail}`);
  }
}

async function complete({ system, prompt, maxTokens = 4096, model = DEFAULT_MODEL }) {
  return withDetailedErrors("gemini.complete", async () => {
    if (!PROJECT_ID) {
      throw new Error("GCP_PROJECT_ID is not set - see .env.example / render.yaml");
    }
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) {
      throw new Error(
        "Could not obtain a Vertex AI access token - check GOOGLE_APPLICATION_CREDENTIALS and the service account's IAM role"
      );
    }
    const response = await axios.post(
      endpointFor(model),
      {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: system }] },
        generationConfig: { maxOutputTokens: maxTokens },
      },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
    const parts = response.data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text || "").join("");
    if (!text) {
      throw new Error("Gemini response contained no text");
    }
    return text;
  });
}

/** Strip a ```json ... ``` (or bare ```) fence if the model wrapped its JSON output in one. */
function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1] : trimmed;
}

/** Same as `complete`, but parses the result as JSON and throws with the raw text included if parsing fails - every structured pipeline stage should use this rather than hand-rolling JSON.parse. */
async function completeJson(args) {
  const text = await complete(args);
  const candidate = stripCodeFence(text);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new Error(
      `Expected JSON from Gemini, got unparseable text (first 800 chars): ${candidate.slice(0, 800)}`
    );
  }
}

module.exports = { complete, completeJson, DEFAULT_MODEL };
