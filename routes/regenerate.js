/**
 * Endpoint the SEPARATE serverless Regenerate panel (crowdin-transcreation-panel)
 * calls into (Phase 4). This is where the actual AI call for the regenerate/
 * amendment loop happens - routed through the same Crowdin AI Prompt the
 * automated pipeline step uses (see lib/aiPrompt.js and
 * routes/workflowStepSettings.js) rather than a directly-held Anthropic key,
 * so the panel itself never needs to touch any API key at all.
 *
 * AUTH IS A PLACEHOLDER, NOT A FINISHED DESIGN (Phase 2b.3 in the plan is an
 * explicitly open question). Current scheme: a static shared secret header,
 * which is low-stakes to rotate but does NOT verify which Crowdin user or
 * project is actually calling - anyone with the secret could hit this
 * endpoint for any file. Before this goes live, replace with either (a)
 * whatever the serverless SDK exposes for proving "this is the current
 * Crowdin user, for this project" to an external service, or (b) a scheme
 * that at least binds the secret to a specific project/org. Do not ship the
 * placeholder as-is.
 */

const express = require("express");
const crowdinApi = require("../lib/crowdinApi");
const pipeline = require("../lib/pipeline");
const store = require("../lib/store");
const { getAccessToken } = require("../lib/crowdinAuth");

const router = express.Router();

function requireSharedSecret(req, res, next) {
  const provided = req.headers["x-regenerate-secret"];
  if (!provided || provided !== process.env.REGENERATE_ENDPOINT_SHARED_SECRET) {
    return res.status(401).json({ error: "Invalid or missing shared secret" });
  }
  next();
}

/**
 * Body: { domain, projectId, fileId, languageId, stringIds: number[], instruction: string }
 * `stringIds` is the panel's `AP.editor.getSelectedStrings()` (or the
 * serverless SDK's equivalent) result - the literal "all" case should be
 * rejected by the panel before this call is ever made (Phase 4.2).
 */
router.post("/", requireSharedSecret, async (req, res) => {
  const { domain, projectId, fileId, languageId, stringIds, instruction } = req.body;

  if (!domain || !projectId || !fileId || !languageId || !Array.isArray(stringIds) || stringIds.length === 0 || !instruction) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const accessToken = await getAccessToken(domain);

    const brief = await crowdinApi.getBrief(accessToken, domain, projectId, fileId, languageId);
    if (!brief) {
      return res.status(409).json({ error: "No stored brief found for this file/language - has the automated pipeline run on it yet?" });
    }

    // Same AI prompt the automated pipeline uses for this project (picked
    // by an admin in the Transcreation Pipeline step's settings - see
    // routes/workflowStepSettings.js). Settings are stored per-project, not
    // per-step, specifically so this endpoint (which only ever knows
    // projectId, never a workflow step id) can reuse it directly.
    const stepSettings = await store.getStepSettings(domain, projectId);
    if (!stepSettings?.aiPromptId) {
      return res.status(409).json({ error: "No AI prompt configured for this project's Transcreation Pipeline step - open its settings in the workflow editor and pick one before using Regenerate." });
    }
    const ctx = { accessToken, domain, aiPromptId: stepSettings.aiPromptId };

    const allStrings = await crowdinApi.listSourceStrings(accessToken, domain, projectId, fileId);
    // True document order, not adjacent IDs (Phase 4.3) - allStrings is
    // already in source order per crowdinApi.listSourceStrings.
    const selectedSet = new Set(stringIds.map(Number));
    const selectedIndices = allStrings.map((s, i) => (selectedSet.has(s.id) ? i : -1)).filter((i) => i >= 0);
    const firstIdx = Math.min(...selectedIndices);
    const lastIdx = Math.max(...selectedIndices);

    const selectedStrings = allStrings.slice(firstIdx, lastIdx + 1).map((s) => ({ id: s.id, text: s.text }));
    const boundaryContext = {
      before: firstIdx > 0 ? { id: allStrings[firstIdx - 1].id, text: allStrings[firstIdx - 1].text } : null,
      after: lastIdx < allStrings.length - 1 ? { id: allStrings[lastIdx + 1].id, text: allStrings[lastIdx + 1].text } : null,
    };

    const writerOutput = await pipeline.writeParagraphs(ctx, {
      brief,
      targetLanguage: languageId,
      selectedStrings,
      boundaryContext,
      instruction,
    });

    // Phase 4.5 - all-or-nothing by default (pending the open partial-failure decision in the plan).
    const missing = stringIds.filter((id) => !(id in writerOutput) && !(String(id) in writerOutput));
    if (missing.length > 0) {
      return res.status(502).json({ error: `Writer output missing stringIds: ${missing.join(", ")}` });
    }

    for (const id of stringIds) {
      const text = writerOutput[id] ?? writerOutput[String(id)];
      await crowdinApi.addSuggestion(accessToken, domain, projectId, id, languageId, text); // never overwrite - new suggestion every time
    }

    const auditNote = `Regenerated via Transcreation panel. Instruction: "${instruction}". Strings regenerated together: ${stringIds.join(", ")}.`;
    for (const id of stringIds) {
      await crowdinApi.addStringComment(accessToken, domain, projectId, id, auditNote).catch((err) => {
        console.error(`[regenerate] Failed to post audit comment on stringId=${id}:`, err.message);
      });
    }

    res.status(200).json({ status: "ok", stringIds });
  } catch (err) {
    console.error("[regenerate] failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
