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

  // Dynamic, per-project label lookup - the "Transcreation" label's id is
  // NOT a constant (production project 9 = 160, test project 52 = 162,
  // confirmed different since Crowdin labels are project-scoped).
  const labelId = await crowdinApi.getTranscreationLabelId(accessToken, domain, projectId);

  // Phase 3.2 - belt-and-suspenders label check before spending any AI budget.
  const stringObj = await crowdinApi.getString(accessToken, domain, projectId, stringId);
  if (!crowdinApi.stringHasTranscreationLabel(stringObj, labelId)) {
    console.warn(`[webhook] stringId=${stringId} reached the transcreation step without the Transcreation label - routing via the untranslated port (into the normal AI Pre-translation chain) without calling the pipeline.`);
    await crowdinApi.reportWorkflowStepOutput(accessToken, domain, projectId, workflowStepId, languageId, stringId, "untranslated");
    return;
  }

  // The AI prompt an admin picked in this step's settings iframe (see
  // routes/workflowStepSettings.js) - required, since the pipeline no
  // longer holds its own ANTHROPIC_API_KEY and routes every AI call through
  // this prompt instead.
  const stepSettings = await store.getStepSettings(domain, projectId);
  if (!stepSettings?.aiPromptId) {
    console.error(
      `[webhook] No AI prompt configured for project ${projectId} on domain ${domain} - ` +
        "an admin needs to open the Transcreation Pipeline step's settings in the workflow " +
        "editor, pick an AI prompt, and save. Routing this string to the untranslated port " +
        "rather than failing silently."
    );
    await crowdinApi.reportWorkflowStepOutput(accessToken, domain, projectId, workflowStepId, languageId, stringId, "untranslated").catch(() => {});
    return;
  }
  const ctx = { accessToken, domain, aiPromptId: stepSettings.aiPromptId };

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

    // Real extracted source content - every string's text, joined in
    // document order (allStringsInFile is already fetched above in source
    // order). Replaces the earlier `file.name` placeholder, which sent the
    // pipeline the filename instead of any actual content.
    const sourceText = allStringsInFile.map((s) => s.text).join("\n\n");

    let brief = existingBrief;
    let finalOutput;
    if (!brief) {
      const result = await pipeline.runFullPipeline(ctx, {
        sourceText,
        targetLanguage: languageId,
        strings: allStringsInFile.map((s) => ({ id: s.id, text: s.text })),
      });
      brief = result.brief;
      finalOutput = result.finalOutput;
      console.log(`[webhook] QA result (logged only, non-blocking) for file=${fileId} lang=${languageId}:`, JSON.stringify(result.qaResult));
      await crowdinApi.saveBrief(accessToken, domain, projectId, fileId, languageId, brief);
    } else {
      // Brief already exists for this (file, language) from an earlier
      // string in the same file - PLACEHOLDER: still need to derive this
      // string's specific text from a stored finalOutput or re-run just the
      // writer+QA+polish stages for this string using the existing brief.
      // Wiring this properly is part of the short-circuit fix flagged
      // below (this file still re-runs the full pipeline once per string
      // if events for the same file arrive close together).
      const writerOutput = await pipeline.writeFull(ctx, {
        brief,
        targetLanguage: languageId,
        strings: [{ id: stringObj.id, text: stringObj.text }],
      });
      const qaResult = await pipeline
        .automatedQa(ctx, { brief, targetLanguage: languageId, sourceText: stringObj.text, transcreatedText: writerOutput })
        .catch((err) => ({ error: err.message, scores: null, fixList: [], passed: false }));
      finalOutput = await pipeline.finalPolish(ctx, {
        brief,
        targetLanguage: languageId,
        strings: [{ id: stringObj.id, text: stringObj.text }],
        writerOutput,
        qaResult,
      });
    }

    const newText = finalOutput[stringId] ?? finalOutput[String(stringId)];
    if (!newText) {
      throw new Error(`Final-polish output did not include text for stringId=${stringId}`);
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
