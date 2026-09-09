/**
 * Handler for `string.status_on_step.recalculation_triggered` - this is the
 * ONLY way Crowdin delivers work to a workflow-step-type app (the paired
 * `webhook` module in manifest.json is required, not optional).
 *
 * Phase 3.1: acknowledge immediately, process in the background - never let
 * Crowdin wait on the full 5-stage pipeline synchronously.
 *
 * CONFIRMED 2026-09-08 - first real deliveries, project 52, pilot file
 * whats-in-the-cards-for-financial-services-in-2026.html (revision 2, 79
 * block-level strings). Both previously-unconfirmed unknowns are now
 * resolved from an actual captured payload (see Render logs around
 * 11:37 AM that day):
 *
 * 1. The Enterprise domain is NEVER in the body - it's the `x-crowdin-domain`
 *    request header (e.g. "sinch"). `x-crowdin-id` is the numeric
 *    organizationId ("200042876", also mirrored in the body as
 *    stringStatus.organizationId) - that's a different value and NOT what
 *    getAccessToken()/crowdinAuth need.
 * 2. The body shape is `{ events: [{ event: "...", stringStatus: {...} }] }`
 *    - every field lives under `stringStatus`, and the string itself is
 *    called `translation` (its `id` IS the source string id; `text` is the
 *    source text at this early step since no translation exists yet). None
 *    of the old flat guesses (event.domain/projectId/string/language/...)
 *    ever matched anything - every real delivery silently hit the
 *    "Could not resolve required fields" branch and no-opped, leaving
 *    strings stuck at this step with no output ever reported. Fixed below
 *    before this ever produced a working end-to-end run.
 *
 * Raw payload/header logging is left in place (still useful signal), just
 * no longer the only source of truth for the shape.
 */

const express = require("express");
const crowdinApi = require("../lib/crowdinApi");
const pipeline = require("../lib/pipeline");
const store = require("../lib/store");
const { getAccessToken } = require("../lib/crowdinAuth");

const router = express.Router();

// This step's actual registered output ports, per manifest.json's
// workflow-step-type module (boundaries.outputs) - confirmed by fetching the
// LIVE deployed /manifest.json on 2026-09-08 and comparing against this
// file. They are NOT "translated"/"untranslated" - that was this codebase's
// working assumption while investigating Crowdin's general port-name enum,
// but this step's manifest was actually registered with "true" (title
// "Transcreated", -> Proofreading) and "false" (title "Needs Standard
// Translation", -> AI Pre-translation) as its two output ports. Calling
// reportWorkflowStepOutput with "translated"/"untranslated" would be
// rejected by Crowdin's API since those aren't ports this step declares -
// this was caught and fixed before ever running a real webhook delivery.
const OUTPUT_PORT_TRANSCREATED = "true";
const OUTPUT_PORT_NEEDS_STANDARD_TRANSLATION = "false";

router.post("/recalculation", async (req, res) => {
  console.log("[webhook] raw payload:", JSON.stringify(req.body));
  console.log("[webhook] headers:", JSON.stringify(req.headers));

  // Acknowledge immediately - Crowdin expects a fast 2xx.
  res.status(200).json({ status: "received" });

  // CONFIRMED 2026-09-08: the domain is a request header, never in the body -
  // see the top-of-file comment. Resolved once per delivery and passed down,
  // since it's not part of any individual event.
  const domain = req.headers["x-crowdin-domain"];

  const events = req.body?.events || [req.body]; // real deliveries always batch as {events:[...]}; the single-object fallback stays as a defensive no-op for anything that doesn't.
  for (const event of events) {
    processRecalculationEvent(event, domain).catch((err) => {
      console.error("[webhook] processing failed:", err.message, err.stack);
    });
  }
});

async function processRecalculationEvent(event, domain) {
  // CONFIRMED 2026-09-08 shape - see top-of-file comment. Everything lives
  // under stringStatus; the string is called `translation`.
  const s = event.stringStatus || {};
  const projectId = s.translation?.project?.id;
  const workflowStepId = s.workflowStep?.id;
  const languageId = s.affectedLanguage?.id;
  const stringId = s.translation?.id;
  const fileId = s.translation?.file?.id;

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
    console.warn(`[webhook] stringId=${stringId} reached the transcreation step without the Transcreation label - routing via the "false" port (into the normal AI Pre-translation chain) without calling the pipeline.`);
    await crowdinApi.reportWorkflowStepOutput(accessToken, domain, projectId, workflowStepId, languageId, stringId, OUTPUT_PORT_NEEDS_STANDARD_TRANSLATION);
    return;
  }

  // Belt-and-suspenders check before spending any AI budget: the pipeline
  // calls Anthropic directly now (see lib/anthropic.js), not Crowdin's own
  // AI Prompt system, so ANTHROPIC_API_KEY (Render env var only - never
  // committed to this public repo) is a hard requirement.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      `[webhook] ANTHROPIC_API_KEY is not set - cannot run the pipeline for project ${projectId} ` +
        `on domain ${domain}. Routing this string to the "false" port rather than failing silently.`
    );
    await crowdinApi.reportWorkflowStepOutput(accessToken, domain, projectId, workflowStepId, languageId, stringId, OUTPUT_PORT_NEEDS_STANDARD_TRANSLATION).catch(() => {});
    return;
  }
  const ctx = { accessToken, domain };

  try {
    const file = await crowdinApi.getFile(accessToken, domain, projectId, fileId);
    const allStringsInFile = await crowdinApi.listSourceStrings(accessToken, domain, projectId, fileId);

    // Real extracted source content - every string's text, joined in
    // document order (allStringsInFile is already fetched above in source
    // order). Replaces the earlier `file.name` placeholder, which sent the
    // pipeline the filename instead of any actual content.
    const sourceText = allStringsInFile.map((s) => s.text).join("\n\n");

    // Phase 3.5 fix: a per-(file, language) lock (store.acquireFileLanguageLock)
    // replaces the old naive "check then run" logic, which had a real race -
    // several strings from the same file landing on this step close together
    // (normal for any multi-paragraph file) could each see "no brief yet" and
    // each kick off a full, duplicate pipeline run. Now: whichever string gets
    // here first acquires the lock and runs the full pipeline once for the
    // whole file+language; every other string either finds the brief already
    // saved (fast path) or, if it arrived while the lock-holder is still
    // running, polls for the brief to appear rather than starting its own run.
    let brief = await crowdinApi.getBrief(accessToken, domain, projectId, fileId, languageId);
    let finalOutput;

    if (!brief) {
      const gotLock = await store.acquireFileLanguageLock(domain, projectId, fileId, languageId);
      if (gotLock) {
        try {
          // Re-check under the lock - another process could have saved the
          // brief between our first getBrief call and acquiring the lock.
          brief = await crowdinApi.getBrief(accessToken, domain, projectId, fileId, languageId);
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
          }
        } finally {
          await store.releaseFileLanguageLock(domain, projectId, fileId, languageId);
        }
      } else {
        // Someone else is running the full pipeline for this file+language
        // right now - poll for the brief to appear instead of starting a
        // second run. The lock's 5-minute TTL bounds the worst case; poll a
        // little past that so a legitimately slow run (a big file) still
        // gets picked up rather than failing right at the TTL boundary.
        const POLL_INTERVAL_MS = 3000;
        const POLL_TIMEOUT_MS = 6 * 60 * 1000;
        const startedAt = Date.now();
        while (!brief) {
          if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
            throw new Error(
              `Timed out after ${POLL_TIMEOUT_MS}ms waiting for another process's pipeline run to save a ` +
                `brief for file=${fileId} lang=${languageId} - it may have failed without releasing its lock.`
            );
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          brief = await crowdinApi.getBrief(accessToken, domain, projectId, fileId, languageId);
        }
      }
    }

    if (!finalOutput) {
      // Brief already exists (either it was there from the start, or another
      // string in this file just produced it) - run only writer+QA+polish for
      // THIS string rather than redoing Stage 1/brief work.
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
    await crowdinApi.reportWorkflowStepOutput(accessToken, domain, projectId, workflowStepId, languageId, stringId, OUTPUT_PORT_TRANSCREATED);
    console.log(`[webhook] Submitted transcreated suggestion for stringId=${stringId} lang=${languageId}`);
  } catch (err) {
    console.error(`[webhook] Pipeline failed for stringId=${stringId}:`, err.message);
    // Failure-routing (decided): route to the "false" port (title "Needs
    // Standard Translation" in this step's manifest) - which the workflow
    // editor wires into the existing AI Pre-translation step, so a
    // failed/untranslated string still gets a normal shot at translation via
    // the standard chain instead of being parked. (Earlier docs in this repo
    // said "untranslated" was the port name, based on Crowdin's general port
    // enum - the actual port this step registered is "false"; see the
    // OUTPUT_PORT_* comment near the top of this file.)
    await crowdinApi.reportWorkflowStepOutput(accessToken, domain, projectId, workflowStepId, languageId, stringId, OUTPUT_PORT_NEEDS_STANDARD_TRANSLATION).catch(() => {});
  }
}

module.exports = router;


module.exports = router;
