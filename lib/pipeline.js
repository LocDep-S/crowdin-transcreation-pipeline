/**
 * The automated 5-stage transcreation pipeline (Phase 3 in the plan).
 *
 * THIS FILE IS A SCAFFOLD, NOT FINISHED PHASE 3 WORK. The actual prompts
 * need to be ported from the interactive `sinch-transcreation` skill family
 * (transcreation-cultural-audit, -data-localization, -local-geo,
 * -brief-builder, -writer, -qa-reviewer, -final-polish) - that porting is
 * real Phase 3 content work, not something to fabricate here. What's real
 * in this file: the orchestration shape (parallel Stage 1 -> brief -> write
 * -> QA, straight through with no approval wait - the locked decision from
 * the plan), and the brief-persistence contract with lib/crowdinApi.js.
 *
 * Also used by routes/regenerate.js (Phase 4) - `writeParagraphs` is called
 * directly for the amendment loop, reusing the same writer stage with a
 * narrower selection + an explicit PM instruction instead of a fresh brief.
 */

const { complete, completeJson } = require("./anthropic");

/** Stage 1a - cultural audit. Runs in parallel with 1b and 1c. */
async function culturalAudit({ sourceText, targetLanguage }) {
  // TODO(Phase 3): port sinch-transcreation:transcreation-cultural-audit's
  // actual instructions into this system prompt.
  return completeJson({
    system: "You are running a cultural audit ahead of transcreation. TODO: port the real cultural-audit skill instructions here.",
    prompt: `Target language: ${targetLanguage}\n\nSource text:\n${sourceText}`,
  });
}

/** Stage 1b - data/stats localization. Runs in parallel with 1a and 1c. */
async function dataLocalization({ sourceText, targetLanguage }) {
  // TODO(Phase 3): port sinch-transcreation:transcreation-data-localization,
  // including its dependency on the AI Production Paradox research skill
  // for approved regional stat swaps.
  return completeJson({
    system: "You are checking statistics/data claims for regional localization ahead of transcreation. TODO: port the real data-localization skill instructions here.",
    prompt: `Target language: ${targetLanguage}\n\nSource text:\n${sourceText}`,
  });
}

/** Stage 1c - local GEO / search & entity signals. Runs in parallel with 1a and 1b. */
async function localGeo({ sourceText, targetLanguage }) {
  // TODO(Phase 3): port sinch-transcreation:transcreation-local-geo.
  return completeJson({
    system: "You are reviewing local search/GEO opportunities ahead of transcreation. TODO: port the real local-geo skill instructions here.",
    prompt: `Target language: ${targetLanguage}\n\nSource text:\n${sourceText}`,
  });
}

/** Stage 2 - brief compilation from the three Stage 1 outputs. */
async function buildBrief({ sourceText, targetLanguage, auditResult, dataResult, geoResult }) {
  // TODO(Phase 3): port sinch-transcreation:transcreation-brief-builder.
  return completeJson({
    system: "You are compiling a transcreation brief from three inputs. TODO: port the real brief-builder skill instructions here.",
    prompt: JSON.stringify({ targetLanguage, sourceText, auditResult, dataResult, geoResult }),
  });
}

/**
 * Stage 3 - native-language writing for the WHOLE file (automated first
 * pass, Phase 3). Requests a structured stringId -> text map so it maps
 * back onto Crowdin's per-string suggestions unambiguously.
 */
async function writeFull({ brief, targetLanguage, strings }) {
  // TODO(Phase 3): port sinch-transcreation:transcreation-writer.
  return completeJson({
    system: "You are writing transcreated content natively in the target language, following an approved brief. Respond with a JSON object mapping each input stringId to its transcreated text. TODO: port the real writer skill instructions here.",
    prompt: JSON.stringify({ brief, targetLanguage, strings }),
  });
}

/**
 * Stage 3 variant used by the Regenerate panel (Phase 4) - a narrower
 * selection of strings plus one paragraph of surrounding *unselected*
 * context on each side, plus the PM's free-text instruction. Same writer
 * stage, different scope - reuses the brief already stored for this
 * (file, language) rather than rebuilding it.
 */
async function writeParagraphs({ brief, targetLanguage, selectedStrings, boundaryContext, instruction }) {
  // TODO(Phase 3/4): port the real writer skill instructions here too - same
  // prompt family as writeFull, extended with `instruction` and
  // `boundaryContext` so the model can keep transitions coherent without
  // touching the unselected neighboring strings.
  return completeJson({
    system: "You are revising a specific selection of already-transcreated paragraphs per a PM's instruction, keeping them coherent with the surrounding (unchanged) content. Respond with a JSON object mapping each input stringId to its revised text. TODO: port the real writer skill instructions here.",
    prompt: JSON.stringify({ brief, targetLanguage, selectedStrings, boundaryContext, instruction }),
  });
}

/**
 * Stage 4 - automated QA (back-translation + scoring). Per the locked
 * decision: logged for visibility only, NEVER blocking - the only human
 * checkpoint is Crowdin's native Proofreading step.
 */
async function automatedQa({ brief, targetLanguage, sourceText, transcreatedText }) {
  // TODO(Phase 3): port sinch-transcreation:transcreation-qa-reviewer.
  return completeJson({
    system: "You are QA-reviewing a transcreated piece against its brief via back-translation. TODO: port the real qa-reviewer skill instructions here.",
    prompt: JSON.stringify({ brief, targetLanguage, sourceText, transcreatedText }),
  });
}

/**
 * Full automated pipeline for one file, one target language (Phase 3.3).
 * Stage 1's three checks run in parallel; everything else is sequential;
 * QA result is returned for logging only and never gates the suggestion
 * submission in routes/webhook.js.
 */
async function runFullPipeline({ sourceText, targetLanguage, strings }) {
  const [auditResult, dataResult, geoResult] = await Promise.all([
    culturalAudit({ sourceText, targetLanguage }),
    dataLocalization({ sourceText, targetLanguage }),
    localGeo({ sourceText, targetLanguage }),
  ]);

  const brief = await buildBrief({ sourceText, targetLanguage, auditResult, dataResult, geoResult });
  const writerOutput = await writeFull({ brief, targetLanguage, strings });
  const qaResult = await automatedQa({
    brief,
    targetLanguage,
    sourceText,
    transcreatedText: writerOutput,
  }).catch((err) => ({ error: err.message })); // QA failure must never block the suggestion - log and move on

  return { brief, writerOutput, qaResult };
}

module.exports = {
  culturalAudit,
  dataLocalization,
  localGeo,
  buildBrief,
  writeFull,
  writeParagraphs,
  automatedQa,
  runFullPipeline,
};
