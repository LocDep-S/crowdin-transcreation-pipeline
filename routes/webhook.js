/**
 * Handler for `string.status_on_step.recalculation_triggered` - this is the
 * ONLY way Crowdin delivers work to a workflow-step-type app (the paired
 * `webhook` module in manifest.json is required, not optional).
 *
 * Phase 3.1: acknowledge immediately, process in the background - never let
 * Crowdin wait on the full 5-stage pipeline synchronously.
 *
 * NOT YET VERIFIED: the exact payload shape for this event (field names for
 * projectId/workflowStepId/languageId/stringId(s), and how the org's
 * Enterprise domain is identified - by a header like the `x-crowdin-id`
 * pattern seen in the org's existing crowdin-auto-task-creator app, by a
 * field in the body, or both). Logging the raw payload below on every
 * delivery is deliberate for the first real install - trim once confirmed.
 */

const express = require("express");
const crowdinApi = require("../lib/crowdinApi");
const pipeline = require("../lib/pipeline");
const store = require("../lib/store");
const { getAccessToken } = require("../lib/crowdinAuth");

const router = express.Router();

router.post("/recalculation", async (req, res) => {
  console.log("[webhook] raw payload:", JSON.stringify(req.body));
  console.log("[webhook] headers:", JSON.stringify(req.headers));

  // Acknowledge immediately - Crowdin expects a fast 2xx.
  res.status(200).json({ status: "received" });

  const events = req.body?.events || [req.body]; // defensive - some Crowdin webhooks batch, some don't; confirm shape on first real delivery
  for (const event of events) {
    processRecalculationEvent(event).catch((err) => {
      console.error("[webhook] processing failed:", err.message, err.stack);
    });
  }
});

async function processRecalculationEvent(event) {
  // Field names below are best-guesses pending the real payload - adjust
  // once the console.log above shows the actual shape.
  const domain = event.domain || event.organization?.domain;
  const projectId = event.projectId || event.project?.id;
  const workflowStepId = event.workflowStepId || event.workflowStep?.id;
  const languageId = event.languageId || event.language?.id;
  const stringId = event.stringId || event.string?.id;
  const fileId = event.fileId || event.string?.fileId || event.file?.id;

  if (!domain || !projectId || !workflowStepId || !languageId || !stringId) {
    console.warn("[webhook] Could not resolve required fields from event - check the raw payload log above.", { domain, projectId, workflowStepId, languageId, stringId });
    return;
  }

  // Phase 3.7 idempotency guard against duplicate deliveries for the same string.
  const isNew = await store.claimRecalculationEvent(stringId, workflowStepId);
  if (!isNew) {
    console.log(`[webhook] Duplicate delivery for stringId=${stringId} step=${workflowStepId} - skipping.`);
    return;
  }

  const accessToken = await getAccessToken(domain);

  // Phase 3.2 - belt-and-suspenders label check before spending any AI budget.
  const stringObj = await crowdinApi.getString(accessToken, domain, projectId, stringId);
  if (!crowdinApi.stringHasTranscreationLabel(stringObj)) {
    console.warn(`[webhook] stringId=${stringId} reached the transcreation step without the Transcreation label - routing via the untranslated port (into the normal AI Pre-translation chain) without calling the pipeline.`);
    await crowdinApi.reportWorkflowStepOutput(accessToken, domain, projectId, workflowStepId, languageId, stringId, "untranslated");
    return;
  }

  try {
    const file = await crowdinApi.getFile(accessToken, domain, projectId, fileId);
    const allStringsInFile = await crowdinApi.listSourceStrings(accessToken, domain, projectId, fileId);

    // NOTE: this currently re-runs the full pipeline (all Stage 1 checks +
    // brief + writer) once per (file, language) the first time any of its
    // strings hits this step - not once per individual string. If multiple
    // strings from the same file arrive as separate webhook events close
    // together, this will currently redo the work per string. Phase 3 needs
    // a real "has this file+language already got a brief+full draft"
    // short-circuit (check crowdinApi.getBrief first) before this scales
    // past the pilot's single-file test - flagging here rather than
    // pretending the naive version is production-ready.
    const existingBrief = await crowdinApi.getBrief(accessToken, domain, projectId, fileId, languageId);

    let brief = existingBrief;
    let writerOutput;
    if (!brief) {
      const result = await pipeline.runFullPipeline({
        sourceText: file.name, // PLACEHOLDER - should be the actual extracted source content, not the filename; wire up real content extraction in Phase 3
        targetLanguage: languageId,
        strings: allStringsInFile.map((s) => ({ id: s.id, text: s.text })),
      });
      brief = result.brief;
      writerOutput = result.writerOutput;
      console.log(`[webhook] QA result (logged only, non-blocking) for file=${fileId} lang=${languageId}:`, JSON.stringify(result.qaResult));
      await crowdinApi.saveBrief(accessToken, domain, projectId, fileId, languageId, brief);
    } else {
      // Brief already exists for this (file, language) from an earlier
      // string in the same file - PLACEHOLDER: still need to derive this
      // string's specific text from a stored writerOutput or re-run just
      // the writer stage for this string using the existing brief. Wiring
      // this properly is part of the short-circuit fix noted above.
      const singleResult = await pipeline.writeFull({
        brief,
        targetLanguage: languageId,
        strings: [{ id: stringObj.id, text: stringObj.text }],
      });
      writerOutput = singleResult;
    }

    const newText = writerOutput[stringId] ?? writerOutput[String(stringId)];
    if (!newText) {
      throw new Error(`Writer output did not include text for stringId=${stringId}`);
    }

    await crowdinApi.addSuggestion(accessToken, domain, projectId, stringId, languageId, newText);
    await crowdinApi.reportWorkflowStepOutput(accessToken, domain, projectId, workflowStepId, languageId, stringId, "translated");
    console.log(`[webhook] Submitted transcreated suggestion for stringId=${stringId} lang=${languageId}`);
  } catch (err) {
    console.error(`[webhook] Pipeline failed for stringId=${stringId}:`, err.message);
    // Failure-routing (decided): route to the "untranslated" port - the only
    // valid Crowdin port name for this case (its ports are a fixed enum, not
    // free-form; "fallback" doesn't exist and was rejected on first install
    // attempt) - which the workflow editor wires into the existing AI
    // Pre-translation step, so a failed/untranslated string still gets a
    // normal shot at translation via the standard chain instead of being
    // parked.
    await crowdinApi.reportWorkflowStepOutput(accessToken, domain, projectId, workflowStepId, languageId, stringId, "untranslated").catch(() => {});
  }
}

module.exports = router;
