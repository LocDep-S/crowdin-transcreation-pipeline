/**
 * TEMPORARY, secret-gated smoke test for the Vertex AI Gemini migration -
 * added 2026-09-14 to confirm GCP_PROJECT_ID / GCP_LOCATION /
 * GOOGLE_APPLICATION_CREDENTIALS (Render Secret File) are wired correctly
 * end-to-end, without Daniel needing to paste the credential anywhere or
 * Claude ever seeing its raw value. Gated behind DIAG_SECRET (a throwaway
 * random value, not a real credential) so this can't be used as an open
 * proxy to spend the org's Vertex AI budget - same pattern used for the
 * earlier Gemini Developer API key check. Remove this route once confirmed
 * working (see git history for the matching removal commit).
 *
 * Only ever returns a safe, whitelisted summary (ok/status/message or the
 * first few chars of a real response) - never the raw error/response
 * object, matching the logging discipline in lib/gemini.js's header.
 */

const express = require("express");
const gemini = require("../lib/gemini");

const router = express.Router();

router.get("/vertex-check", async (req, res) => {
  if (!req.query.secret || req.query.secret !== process.env.DIAG_SECRET) {
    return res.status(404).end();
  }

  try {
    const text = await gemini.complete({
      system: "Reply with exactly one word.",
      prompt: "Reply with the single word: OK",
      maxTokens: 16,
    });
    res.status(200).json({ ok: true, model: gemini.DEFAULT_MODEL, sample: text.slice(0, 40) });
  } catch (err) {
    res.status(200).json({ ok: false, message: err.message });
  }
});

module.exports = router;
