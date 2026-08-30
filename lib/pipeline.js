/**
 * The automated 5(+1)-stage transcreation pipeline (Phase 3 in the plan).
 *
 * Every stage's system prompt below is a real, automation-adapted port of
 * the interactive `sinch-transcreation` skill family (transcreation-
 * cultural-audit, -data-localization, -local-geo, -brief-builder, -writer,
 * -qa-reviewer, -final-polish) - not a placeholder. Adaptation from the
 * skills' interactive design to this pipeline's fully-automated, no-human-
 * checkpoint design followed two rules, applied consistently below:
 *
 *   1. Every "ask the user" / "do not proceed until approved" checkpoint is
 *      removed. Where a skill's checkpoint gated an *optional* addition
 *      (data-localization Step 4a's bigger optional inclusions, the
 *      optional pull-quote attribution adaptation, the "Key stats" callout
 *      block), the skill's OWN stated default applies instead of a human
 *      answering: "The default, absent a decision, is exclude. Silence is
 *      not approval." No optional item is ever included automatically.
 *   2. transcreation-data-localization requires loading a per-campaign
 *      research-data skill (e.g. an AI Production Paradox skill) as "the
 *      only approved source of figures," with a hard rule never to
 *      estimate/interpolate unlisted numbers. No such skill is loaded in
 *      this automated deployment - there's no generic equivalent. Rather
 *      than fake having one, the data-localization stage below explicitly
 *      says so and is scoped down to inventorying + flagging only, never
 *      swapping or fabricating a stat - the same conservative posture the
 *      skill itself would take with zero approved figures available.
 *
 * All AI calls route through lib/aiPrompt.js, which calls Crowdin's own AI
 * Prompt/Provider infrastructure (an admin-picked prompt per project - see
 * routes/workflowStepSettings.js) instead of holding our own Anthropic key.
 *
 * `ctx` (first argument to every exported stage function) = { accessToken,
 * domain, aiPromptId } - see lib/aiPrompt.js.
 */

const { completeJsonViaAiPrompt } = require("./aiPrompt");
const { getLanguageProfile, BRAND_VOICE } = require("./referenceContent");

/** Shared reference block every stage gets: the target market's language profile plus Sinch's brand voice skill, both loaded verbatim (sourced vs. PROPOSED/FLAGGED distinctions preserved as-is - never strip these markers out). */
function referenceBlock(targetLanguage) {
  const profile = getLanguageProfile(targetLanguage);
  return (
    "=== SINCH BRAND VOICE (sinch-brand-voice skill, SKILL.md) ===\n" +
    BRAND_VOICE +
    "\n\n=== LANGUAGE PROFILE for this target market ===\n" +
    profile +
    "\n\n=== END REFERENCE MATERIAL ===\n"
  );
}

const AUTOMATION_NOTE =
  "You are one stage in a FULLY AUTOMATED transcreation pipeline. There is no human " +
  "in the loop at this stage and no opportunity to ask a clarifying question - the " +
  "only human checkpoint in the entire system is Crowdin's own Proofreading step, " +
  "which reviews your eventual output after the fact. Never write a question back to " +
  "the caller, never say you're waiting for approval, and never leave a placeholder " +
  "like \"TBD\" or \"[ask the user]\" in your output. Where the underlying instructions " +
  "you're following would normally pause for a human decision on an OPTIONAL item, " +
  "apply the documented default instead: EXCLUDE the optional item. Silence is not " +
  "approval. Respond with ONLY a single JSON object - no prose before or after it, " +
  "no markdown code fence.";

/**
 * Stage 1a - cultural audit. Runs in parallel with 1b and 1c.
 * Ported from transcreation-cultural-audit/SKILL.md.
 */
async function culturalAudit(ctx, { sourceText, targetLanguage, contentFormat = "blog post" }) {
  const system =
    AUTOMATION_NOTE +
    "\n\nYou are running a cultural audit on English-language content ahead of " +
    "transcreation (Step 1a of 3 parallel Step-1 checks). Analyze the source for " +
    "cultural load before any target-language writing happens - this is not a " +
    "translation step and you must not produce any target-language content.\n\n" +
    "Your scope is language and cultural fit ONLY: idiom, register, tone, structure, " +
    "sensitivity zones, and brand voice fit. Two sibling checks own everything else - " +
    "if you notice a statistics/regional-data question, or a search/GEO/linking " +
    "question, do NOT resolve it yourself: note it in one line under \"handedOff\" " +
    "and move on.\n\n" +
    "Work through these seven categories. Skip a category in your output only if " +
    "genuinely nothing is worth flagging - don't pad the audit with filler.\n\n" +
    "1. IDIOMS AND FIGURES OF SPEECH - metaphors/idioms, whether they're culturally " +
    "specific, whether a target-language equivalent exists or the concept needs " +
    "replacing.\n" +
    "2. CULTURAL AND GEOGRAPHIC REFERENCES - brand names, media, events, regulatory/" +
    "legal references (e.g. GDPR vs. CCPA), geography, seasonal references. If a stat " +
    "or data claim is involved, don't chase it here - one line, hand it off.\n" +
    "3. REGISTER AND FORMALITY - what register the source uses and whether it " +
    "transfers directly. Address form (tu/usted/vosotros, du/Sie, tu/vous, tu/voce) is " +
    "documented in Section 1 of the language profile below - treat it as a hard rule, " +
    "not a style choice. Flag any pronoun/address-form choice that needs an explicit " +
    "decision.\n" +
    "4. HUMOR, IRONY, AND TONE - does the source's humor/irony/understatement land in " +
    "the target market? Do not invent a generic cultural stereotype (e.g. a blanket " +
    "claim that a certain humor style \"never survives\" into a certain language) - " +
    "flag a mismatch only when you find a concrete, specific reason, not a general " +
    "assumption about the language.\n" +
    "5. STRUCTURAL AND EDITORIAL CONVENTIONS - default to MIRRORING the English " +
    "source's thesis placement and heading/subhead density; flag a change only for a " +
    "specific, concrete reason (e.g. a register mismatch), never a generic per-market " +
    "assumption. For sentence length/rhythm, defer entirely to the language profile's " +
    "Register & pacing section (Section 2) rather than asserting a generic rule about " +
    "the language family. CTA style/placement and paragraph rhythm are also covered " +
    "there where documented.\n" +
    "6. SENSITIVITY ZONES - politically/culturally/historically sensitive topics for " +
    "this market; claims acceptable in the US but restricted elsewhere. Check the " +
    "language profile's Section 7 (Regulatory & legal notes) for market-specific " +
    "working notes and flag anything this piece triggers (named-competitor " +
    "comparisons, superlative/absolute claims, discount/pricing claims) - these notes " +
    "are working assumptions, not legal advice. Inclusive-language considerations that " +
    "differ by market.\n" +
    "7. BRAND VOICE FIT - Sinch's five traits (Bold, Human, Innovative & dynamic, A " +
    "little nerdy, Trustworthy) are defined in the brand voice reference below. The " +
    "language profile's Section 6 gives this market's order of importance - use it: " +
    "flag if the source leans on a trait that ranks low for this market.\n\n" +
    referenceBlock(targetLanguage) +
    "\n\nRespond with a JSON object of exactly this shape:\n" +
    "{\n" +
    '  "flags": [ { "category": "idioms"|"references"|"register"|"tone"|"structure"|"sensitivity"|"brandVoice", "element": string, "culturalNote": string, "recommendedAction": "keep"|"adapt"|"replace", "rationale": string } ],\n' +
    '  "handedOff": [string],\n' +
    '  "summary": string\n' +
    "}\n" +
    'The summary must follow the pattern: "N elements flagged for adaptation. Key risk: <the single biggest issue>."';

  const prompt =
    `Target language/market: ${targetLanguage}\n` +
    `Content format: ${contentFormat}\n\n` +
    `English source content:\n${sourceText}`;

  return completeJsonViaAiPrompt(ctx, { system, prompt });
}

/**
 * Stage 1b - data/stats localization. Runs in parallel with 1a and 1c.
 * Ported from transcreation-data-localization/SKILL.md, but deliberately
 * scoped down: no campaign research-data skill is loaded in this automated
 * deployment (see file header), so this stage never swaps, estimates, or
 * verifies a figure against anything - it only inventories what's present
 * in the source and flags it, exactly as the skill's own safe-default
 * ("silence is not approval") would produce with zero approved figures on
 * hand.
 */
async function dataLocalization(ctx, { sourceText, targetLanguage, contentFormat = "blog post" }) {
  const system =
    AUTOMATION_NOTE +
    "\n\nYou are running the data-localization check ahead of transcreation (Step 1b " +
    "of 3 parallel Step-1 checks). Your job in the interactive version of this skill " +
    "is to cross-check every statistic in the source against the campaign's approved " +
    "research-data skill and recommend country-specific swaps. " +
    "IMPORTANT: in THIS automated deployment, no campaign research-data skill is " +
    "loaded and none is available to you - there is no approved source of figures to " +
    "check against. The hard rule from the underlying skill therefore applies at its " +
    "strictest: \"Never estimate, interpolate, or infer a number that isn't written " +
    "down\" in an approved source. Since no approved source is available at all, you " +
    "MUST NOT recommend, perform, or imply any country/region-specific stat swap, " +
    "pull-quote swap, or new data-driven addition - doing so without an approved " +
    "source to check against would be fabrication. Your job here is narrower than " +
    "the interactive skill's: inventory what's present, note it, and stop there.\n\n" +
    "Do this:\n" +
    "1. List every number, percentage, ratio, or data-backed claim in the source, in " +
    "order, with the exact phrasing used.\n" +
    "2. For each, note only that it exists - do not judge its accuracy (you have " +
    "nothing to check it against) and do not propose a swap.\n" +
    "3. Leave swapsRecommended, optionalInclusions, and any pull-quote swap empty - " +
    "these all require an approved research-data source this deployment doesn't have.\n" +
    "4. The thesis, argument order, and section structure carry over unchanged from " +
    "the English source - this is always true when no optional inclusion is approved, " +
    "and none ever is here.\n\n" +
    referenceBlock(targetLanguage) +
    "\n\nRespond with a JSON object of exactly this shape:\n" +
    "{\n" +
    '  "statInventory": [ { "asWritten": string, "note": string } ],\n' +
    '  "swapsRecommended": [],\n' +
    '  "pullQuoteRecommendation": string,\n' +
    '  "dataAccuracyIssuesFound": [],\n' +
    '  "optionalInclusions": [],\n' +
    '  "keyStatsCalloutBlock": { "qualifies": false, "reason": string },\n' +
    '  "flaggedForHumanReview": [],\n' +
    '  "whatWillNotChange": string,\n' +
    '  "summary": string\n' +
    "}\n" +
    'The summary must follow the pattern: "N stats found (inventory only - no ' +
    "approved research-data source loaded in this automated pipeline, so zero swaps " +
    'recommended)."';

  const prompt =
    `Target language/market: ${targetLanguage}\n` +
    `Content format: ${contentFormat}\n\n` +
    `English source content:\n${sourceText}`;

  return completeJsonViaAiPrompt(ctx, { system, prompt });
}

/**
 * Stage 1c - local GEO / search & entity signals. Runs in parallel with 1a
 * and 1b. Ported from transcreation-local-geo/SKILL.md. No Ahrefs MCP
 * connector is available in this server-side pipeline, so the optional
 * Ahrefs-verification step is always skipped (matching the skill's own
 * fallback: "if Ahrefs isn't connected, skip this step and note the
 * heading/term recommendations as unverified assumptions instead").
 */
async function localGeo(ctx, { sourceText, targetLanguage, contentFormat = "blog post" }) {
  const system =
    AUTOMATION_NOTE +
    "\n\nYou are running the local GEO analysis ahead of transcreation (Step 1c of 3 " +
    "parallel Step-1 checks) - a light-touch search/authority opportunity scan, not " +
    "an SEO strategy rewrite. Most transcreated content (including AIPP campaign " +
    "content) is not SEO-first: your recommendations are an overlay, never a mandate " +
    "to restructure headings, sections, or the argument to chase keyword coverage.\n\n" +
    "You have no live access to Crowdin's page inventory, Ahrefs, or the web in this " +
    "automated pipeline - mark anything that would normally require checking a live " +
    "source (does a localized hub page already exist? does a campaign term have a " +
    "settled local rendering already in use elsewhere?) as \"unconfirmed\" rather than " +
    "guessing yes or no, and note it as a handoff item for a human to verify before " +
    "publication.\n\n" +
    "Do this:\n" +
    "1. VERIFICATION CHECKLIST (mark each unconfirmed unless the source text itself " +
    "settles it): localized hub/pillar page exists?; campaign/product entity term has " +
    "a settled local rendering?; internal links point to EN-only pages needing a " +
    "localized equivalent?; propose a target-language slug applying the language " +
    "profile's diacritic-stripping rule (Section 8/hashtag guidance); flag canonical/" +
    "hreflang as a handoff item.\n" +
    "2. LIGHT-TOUCH OPPORTUNITY SCAN: note optional heading/subhead/meta-title/meta-" +
    "description tweaks using a locally-relevant term, without changing meaning or " +
    "structure; note any authority-stacking idea as a separate follow-up, clearly " +
    "labeled outside this piece's scope; note any entity-association opportunity. For " +
    "data-heavy content specifically (key findings from a report/survey/study, not " +
    "general thought leadership), note whether a \"Key stats in [region]\" callout " +
    "block might be worth adding downstream - only as a flag for the data-" +
    "localization stage to actually qualify (it needs 3+ approved regional stats, " +
    "ideally 7-10) - you are not deciding whether it qualifies.\n" +
    "3. Skip any Ahrefs/live search-volume check entirely - no connector is available " +
    "here; note every heading/term recommendation as an unverified assumption.\n" +
    "4. Headings, structure, and argument carry over from the English source unless a " +
    "cultural-audit or data-localization flag already justifies a change - GEO alone " +
    "never justifies restructuring.\n\n" +
    referenceBlock(targetLanguage) +
    "\n\nRespond with a JSON object of exactly this shape:\n" +
    "{\n" +
    '  "verificationChecklist": [ { "item": string, "status": "yes"|"no"|"unconfirmed", "action": string } ],\n' +
    '  "optionalOpportunities": [ { "opportunity": string, "scope": "in-scope"|"separate-follow-up", "rationale": string } ],\n' +
    '  "keyStatsCalloutBlockFlagged": boolean,\n' +
    '  "ahrefsChecksRun": "none run - no Ahrefs connector available in the automated pipeline",\n' +
    '  "whatWillNotChange": string,\n' +
    '  "summary": string\n' +
    "}\n" +
    'The summary must follow the pattern: "N verification items checked, M optional ' +
    'opportunities noted, K flagged as separate follow-up work."';

  const prompt =
    `Target language/market: ${targetLanguage}\n` +
    `Content format: ${contentFormat}\n\n` +
    `English source content:\n${sourceText}`;

  return completeJsonViaAiPrompt(ctx, { system, prompt });
}

/**
 * Stage 2 - brief compilation from the three Stage 1 outputs. Ported from
 * transcreation-brief-builder/SKILL.md. Since dataResult never contains an
 * approved swap or optional inclusion in this deployment (see
 * dataLocalization above), Section 4 of the brief will always state the
 * thesis/argument/structure are unchanged - that's the correct, intended
 * behavior here, not a gap.
 */
async function buildBrief(ctx, { sourceText, targetLanguage, contentFormat = "blog post", auditResult, dataResult, geoResult }) {
  const system =
    AUTOMATION_NOTE +
    "\n\nYou are building a transcreation brief (Step 2) from three completed Step-1 " +
    "outputs: a cultural audit, a data-localization check, and a local GEO analysis. " +
    "The brief is the single most important document in the pipeline - it locks the " +
    "strategic and editorial decisions that guide the writer (Step 3). This is not a " +
    "writing step - produce no target-language content.\n\n" +
    "Fidelity reminder: this pipeline has no dedicated in-market reviewers to " +
    "validate deviations from the English source. Lock in cultural/linguistic " +
    "adaptation (always warranted) and any APPROVED data/GEO swaps (there will " +
    "usually be none, since no research-data source is loaded - see the data check) " +
    "- never invent new structure, arguments, or angles. Anything either Step-1 " +
    "output flagged as \"separate follow-up\" or \"needs human review\" does NOT " +
    "belong in this brief.\n\n" +
    "Build these seven sections, keeping the whole brief to roughly half a page to " +
    "three-quarters of a page - a working document, not an essay:\n\n" +
    "1. CORE MESSAGE TO PRESERVE - one sentence: the single most important thing this " +
    "content must communicate, independent of language. Strip away English phrasing/" +
    "structure/examples; state the underlying idea plainly.\n" +
    "2. TONE TARGET - specific, not generic. Formality/address-form decision; " +
    "emotional register; pacing; any Sinch brand-voice calibration for this market " +
    "(reference the language profile's Section 6 trait ordering).\n" +
    "3. KEY ADAPTATIONS - each cultural/linguistic adaptation from the audit: what's " +
    "changing, what it's changing to (or the direction, if exact wording is the " +
    "writer's call), and why. Be concrete, not vague.\n" +
    "4. DATA AND GEO SWAPS - narrow, a swap list not a rewrite plan. From the data " +
    "check: headline stat and placement (will normally just be the source's own " +
    "figure, since no swap is ever approved here), any data-accuracy correction " +
    "(none available without a research source, so normally none), and the explicit " +
    'statement "Thesis and argument order unchanged from English source." From the ' +
    "GEO analysis: confirmed/likely internal link target, any settled campaign-term " +
    "rendering, and only the in-scope heading/meta tweaks worth acting on (never the " +
    "full opportunity list, never anything marked separate-follow-up).\n" +
    "5. FORMAT AND STRUCTURE - adapt to the content format given below (blog/article: " +
    "length range, heading structure, intro approach - default to mirroring the " +
    "English source unless the audit flagged a specific reason to diverge, CTA style/" +
    "placement; social: length/character target, emoji/hashtag guidance from the " +
    "language profile; email: subject-line approach, opening register, CTA). If a " +
    '"Key stats" block was flagged by GEO AND the data check found it qualifies (3+ ' +
    "regional stats), place it after the LAST relevant stat has appeared in the body " +
    "- otherwise omit it entirely (default is no block).\n" +
    "6. WHAT TO AVOID - explicit guardrails for the writer, drawn from the audit and " +
    "the language profile (e.g. address-form misuse, hyperbole this market doesn't " +
    "expect, anglicisms, wrong structural conventions).\n" +
    "7. BRAND VOICE NOTES - which of Sinch's five traits should lead for this market " +
    "(use the language profile's Section 6 order directly, don't re-derive it from " +
    "tone adjectives); any preferred-word principle that applies (plain language over " +
    "jargon - the underlying principle, not the English word list itself); any " +
    "editorial-rule adaptation the language profile documents (e.g. capitalization, " +
    "punctuation, quotation marks) - the brand voice skill's editorial rules are " +
    "written for American English and are NOT confirmed to transfer as-is; where the " +
    "language profile is silent, say so rather than assuming the English rule " +
    "applies.\n\n" +
    referenceBlock(targetLanguage) +
    "\n\nRespond with a JSON object of exactly this shape:\n" +
    "{\n" +
    '  "coreMessage": string,\n' +
    '  "toneTarget": [string],\n' +
    '  "keyAdaptations": [ { "what": string, "to": string, "why": string } ],\n' +
    '  "dataAndGeoSwaps": { "headlineStat": string, "pullQuote": string, "dataAccuracyCorrections": [string], "internalLinkTarget": string, "campaignTermRendering": string, "inScopeTweaks": [string], "thesisUnchangedNote": string, "keyStatsCalloutBlock": { "included": boolean, "heading": string, "stats": [string], "placement": string } },\n' +
    '  "formatAndStructure": { "lengthGuidance": string, "headingStructure": string, "introApproach": string, "ctaStyle": string, "other": string },\n' +
    '  "whatToAvoid": [string],\n' +
    '  "brandVoiceNotes": { "leadTrait": string, "preferredWordsNote": string, "editorialAdaptationNotes": string }\n' +
    "}";

  const prompt = JSON.stringify({ targetLanguage, contentFormat, sourceText, auditResult, dataResult, geoResult });

  return completeJsonViaAiPrompt(ctx, { system, prompt });
}

const WRITER_CORE_INSTRUCTIONS =
  "The fundamental rule: GENERATE FROM THE BRIEF. Do NOT translate the English " +
  "source. The English source is reference material only - it carries the original " +
  "ideas, structure, and examples, but the transcreated content must read as if the " +
  "brief were the only input. Ask yourself: \"If I were a native speaker of this " +
  "language, briefed to write this piece for this market, what would I write?\" That " +
  "is the answer - not a translation of the English.\n\n" +
  "Signs you're translating instead of transcreating (avoid all of these): sentence-" +
  "level syntax mirrors the English original's word order/clause structure (this is " +
  "distinct from mirroring the source's overall macro-level shape - thesis placement " +
  "and heading density - which the brief may call for; the failure mode is " +
  "sentence-by-sentence grammar-mirroring, not the overall shape); idioms translated " +
  "literally rather than replaced; text that would read smoothly if back-translated " +
  "to English but sounds stiff natively; cultural references preserved unchanged " +
  "when they should have been adapted.\n\n" +
  "Apply the brief's Key Adaptations as you write, hit the Tone Target on every " +
  "sentence, follow Format and Structure exactly, respect every item in What to " +
  "Avoid, and calibrate to the Brand Voice Notes (lead with the trait the brief " +
  "names; check for passive voice and rewrite; no jargon or corporate filler in the " +
  "TARGET language, not just English - every language has its own corporate cliches; " +
  "match the formality level specified, consistently; keep the piece single-minded " +
  "around the Core Message).\n\n" +
  "TYPOGRAPHY: wherever the language profile's SOURCED (Crowdin) content conflicts " +
  "with the brand voice skill's general editorial rules (written for American " +
  "English), the language profile wins - this is a standing rule, not case-by-case. " +
  "Known example: fr-FR uses guillemets (« ») with non-breaking spaces, not double " +
  "quotation marks, which overrides the brand voice skill's \"double quotation marks " +
  "always\" rule for French specifically. Where neither source documents a rule " +
  "(Oxford comma, %-spacing, en-dash spacing in the non-English markets), do not " +
  "assume the English convention applies - use plain, unambiguous punctuation " +
  "instead.\n\n" +
  "QUOTES: any quoted executive/expert material uses the SAME formality register as " +
  "the surrounding prose - no separate \"quote voice.\"\n\n" +
  "DATA CITATIONS: if the brief's Data and GEO Swaps section names a headline stat " +
  "or pull quote, cite it with a mix of inline attribution (translated naturally per " +
  "market: segun/selon/laut einer Studie von/segundo) plus a parenthetical citation " +
  "in this exact format - \"[stat] (The AI Production Paradox, Sinch, 2026)\" - this " +
  "parenthetical structure is a fixed Sinch house convention, never localize it. If " +
  "the brief's keyStatsCalloutBlock.included is true, format it as a single bolded " +
  "lead-in line (translated naturally, e.g. \"Chiffres cles en France :\") followed by " +
  "one stat per line in the same citation format - NOT a heading tag (no H2/H3, since " +
  "it isn't a real section and shouldn't appear in an auto-generated table of " +
  "contents), and use exactly the stat list the brief locked in, nothing added or " +
  "dropped. Place it exactly where the brief's placement field says.\n\n" +
  "Deliver ONLY the transcreated content itself - no preamble, no explanation, no " +
  "\"here is the transcreated version.\"";

/**
 * Stage 3 - native-language writing for the WHOLE file (automated first
 * pass). Ported from transcreation-writer/SKILL.md. Requests a structured
 * stringId -> text map so it maps back onto Crowdin's per-string
 * suggestions unambiguously - each Crowdin string is one paragraph/block
 * (per the project's content-segmentation setup), so per-string output IS
 * the skill's per-section/passage drafting process, just returned
 * structured instead of as flowing prose.
 */
async function writeFull(ctx, { brief, targetLanguage, strings, contentFormat = "blog post" }) {
  const system =
    AUTOMATION_NOTE +
    "\n\nYou are writing transcreated content (Step 3), following an approved brief " +
    "exactly. This is the creative core of the pipeline - the goal is content that " +
    "reads as if conceived and written for this market, not adapted from English.\n\n" +
    WRITER_CORE_INSTRUCTIONS +
    "\n\nThe content arrives as an ordered array of Crowdin strings, each one " +
    "paragraph/block of the source file (id + English text, in document order). " +
    "Write the transcreated equivalent of EVERY string id given - never skip one, " +
    "never merge two strings' content into one output entry (Crowdin needs a " +
    "translation suggestion per string id) - even if a natural target-language " +
    "rewrite would flow differently, keep the same one-string-per-block boundaries as " +
    "the source.\n\n" +
    referenceBlock(targetLanguage) +
    "\n\nRespond with a JSON object of exactly this shape - a flat map from each " +
    "input string id (as a string) to its transcreated text, nothing else:\n" +
    '{ "<stringId>": "<transcreated text for that string>", ... }';

  const prompt = JSON.stringify({ targetLanguage, contentFormat, brief, strings });

  return completeJsonViaAiPrompt(ctx, { system, prompt });
}

/**
 * Stage 3 variant used by the Regenerate panel (Phase 4) - a narrower
 * selection of strings plus one paragraph of surrounding *unselected*
 * context on each side, plus the PM's free-text instruction. Same writer
 * instructions as writeFull, extended with the instruction and boundary
 * context so the model keeps transitions coherent without touching the
 * unselected neighboring strings.
 */
async function writeParagraphs(ctx, { brief, targetLanguage, selectedStrings, boundaryContext, instruction, contentFormat = "blog post" }) {
  const system =
    AUTOMATION_NOTE +
    "\n\nYou are revising a specific, PM-selected set of already-transcreated " +
    "paragraphs per an explicit instruction, following the same approved brief that " +
    "produced the original transcreation. Keep the revised paragraphs coherent with " +
    "the surrounding (unchanged) content shown as boundary context - do not revise or " +
    "return text for the boundary-context strings themselves, they're for reference " +
    "only.\n\n" +
    WRITER_CORE_INSTRUCTIONS +
    "\n\nApply the PM's instruction to the selected strings specifically. Only " +
    "output the strings actually selected (the boundaryContext.before/after strings, " +
    "if present, are for transition coherence only - never include them in your " +
    "output map).\n\n" +
    referenceBlock(targetLanguage) +
    "\n\nRespond with a JSON object of exactly this shape - a flat map from each " +
    "selected string id (as a string) to its revised text, nothing else:\n" +
    '{ "<stringId>": "<revised text for that string>", ... }';

  const prompt = JSON.stringify({ targetLanguage, contentFormat, brief, selectedStrings, boundaryContext, instruction });

  return completeJsonViaAiPrompt(ctx, { system, prompt });
}

/**
 * Stage 4 - automated QA (back-translation + scoring). Per the locked
 * decision: logged for visibility only, NEVER blocking - the only human
 * checkpoint is Crowdin's native Proofreading step. Ported from
 * transcreation-qa-reviewer/SKILL.md.
 */
async function automatedQa(ctx, { brief, targetLanguage, sourceText, transcreatedText }) {
  const system =
    AUTOMATION_NOTE +
    "\n\nYou are QA-reviewing a transcreation (Step 4) against the brief that " +
    "produced it - the brief, not the English source, is the quality benchmark. " +
    "This step exists to catch three failure modes: message drift (says something " +
    "subtly different from what the brief specified), translation artifacts (reads " +
    "like translated English rather than native prose), and brief non-compliance (a " +
    "specific adaptation or guardrail from the brief wasn't applied).\n\n" +
    "STAGE 1 - BACK-TRANSLATION: produce an English back-translation of the " +
    "transcreated text, for QA only (never for publishing). Translate meaning and " +
    "register, not just words. Note formal/informal address forms that carry meaning " +
    "(Sie, vous, usted, tu/voce). Preserve idioms in brackets with the English " +
    "equivalent, e.g. [idiom: X -> \"hit the bullseye\"]. Do NOT smooth over an " +
    "awkward passage in translation - if the original is awkward, the back-" +
    "translation should show that.\n\n" +
    "STAGE 2 - BRIEF COMPARISON, section by section: core message present and clear " +
    "(not diluted/reframed/buried)?; tone matches (formality, address forms, " +
    "emotional register, pacing, brand-voice calibration)?; each key adaptation " +
    "applied or missed/partial?; format/structure - length, headings, intro, CTA all " +
    "match spec?; every What-to-Avoid guardrail respected?; brand voice - passive-" +
    "voice count, jargon/anglicisms/corporate cliches in the TARGET language, " +
    "customer-first framing, consistent address forms/register/tone including in any " +
    "quoted material.\n\n" +
    "STAGE 3 - TRANSLATION ARTIFACT CHECK: read the back-translation as a native " +
    "English speaker would. Does the structure/rhythm/phrasing betray an English " +
    "original? Check sentence structure mirroring English syntax unnaturally, stiff " +
    "translated connectors (however/moreover/in order to), English-length paragraph " +
    "rhythm, and whether headings read as native or translated.\n\n" +
    "STAGE 4 - SCORING (1-5 each, with a specific actionable note for anything below " +
    "4): message fidelity, tone match, cultural resonance. Scale: 5 = passes cleanly; " +
    "4 = minor issues, easy fix; 3 = noticeable problems needing specific fixes; 2 = " +
    "significant issues; 1 = fundamental problem.\n\n" +
    "STAGE 5 - FIX LIST: if any score is below 4, produce specific fixes (what " +
    "passage/element, what's wrong and why, the specific change required or the " +
    "direction if exact wording is a judgment call). If all scores are 4-5, say so " +
    "plainly and leave the fix list empty.\n\n" +
    referenceBlock(targetLanguage) +
    "\n\nRespond with a JSON object of exactly this shape:\n" +
    "{\n" +
    '  "backTranslation": string,\n' +
    '  "briefComparisonNotes": { "coreMessage": string, "tone": string, "keyAdaptations": string, "formatAndStructure": string, "guardrails": string, "brandVoice": string },\n' +
    '  "translationArtifactCheck": string,\n' +
    '  "scores": { "messageFidelity": number, "toneMatch": number, "culturalResonance": number },\n' +
    '  "fixList": [ { "what": string, "issue": string, "fix": string } ],\n' +
    '  "passed": boolean\n' +
    "}\n" +
    '"passed" is true only if every score is 4 or 5.';

  const prompt = JSON.stringify({ targetLanguage, brief, sourceText, transcreatedText });

  return completeJsonViaAiPrompt(ctx, { system, prompt });
}

/**
 * Stage 5 (NEW - not present in the pre-rewrite scaffold, added per the
 * plan/summary's identified gap) - final polish. Ported from
 * transcreation-final-polish/SKILL.md. In the interactive skill, a human
 * says "apply fixes" before this step runs; here, since QA (Stage 4) never
 * blocks and there's no human to say that, this stage ALWAYS runs
 * immediately after QA and applies any fix list itself - functionally
 * equivalent to the skill's Step A ("apply QA fixes") with QA's approval
 * step compressed into "the pipeline decided to always apply them," which
 * is the only sensible automated reading of the skill's own instructions.
 */
async function finalPolish(ctx, { brief, targetLanguage, strings, writerOutput, qaResult, contentFormat = "blog post" }) {
  const system =
    AUTOMATION_NOTE +
    "\n\nYou are doing the final polish pass (Step 5, the last step in the pipeline) " +
    "on a transcreated draft. The output of this step is handed straight to Crowdin " +
    "as the translation suggestion for each string - it must be publish-ready with no " +
    "further human editing expected before Crowdin's own Proofreading step.\n\n" +
    "STEP A - APPLY QA FIXES: if the supplied QA result has a non-empty fix list, " +
    "apply every fix exactly as specified - make the specific change listed, " +
    "introduce nothing beyond what was specified (this is not a rewrite pass). If a " +
    "fix would conflict with another part of the brief, prefer the brief and note " +
    "the conflict is unresolved in your own reasoning, but still produce a coherent " +
    "final string (never leave visible fix-list bracket notes in the output text). " +
    "If the QA result already passed with no fixes, skip straight to Step B.\n\n" +
    "STEP B - FINAL BRAND VOICE PASS (light touch, not a rewrite): scan for passive " +
    "constructions that make the content feel flat or evasive and rewrite them " +
    "(except where passive is genuinely the natural choice in this language, per the " +
    "language profile); strip any remaining jargon, corporate cliches, or " +
    "unnecessary anglicisms; make sure every passage leads with what's in it for the " +
    "reader, reframing anything that talks about Sinch's capabilities without " +
    "connecting to reader outcomes; confirm address forms, register, and tone are " +
    "consistent throughout with no sudden shifts. The trait order to lead with comes " +
    "from the language profile's Section 6, not a generic reading of the brand voice " +
    "skill.\n\n" +
    "STEP C - FORMAT AND COMPLETENESS: confirm the full set of transcreated strings " +
    "together read as a complete, correctly formatted piece for the content format " +
    "given - headings naturally worded (not literal translations), intro earns " +
    "attention immediately, body flows logically, CTA present/natural/correctly " +
    "placed, overall length within the brief's guidance.\n\n" +
    "STEP D - FINAL READ: read the whole piece as a native reader of the target " +
    "language would. Does it feel like it was written for this market? Does any " +
    "single sentence sound like it came from another language? Does the ending land? " +
    "Fix any remaining issue now - do not hold back a small improvement, this is the " +
    "last chance before publication review.\n\n" +
    referenceBlock(targetLanguage) +
    "\n\nRespond with a JSON object of exactly this shape - a flat map from each " +
    "input string id (as a string) to its final, publish-ready text, nothing else, " +
    "no labels, no preamble, no commentary embedded in the text itself:\n" +
    '{ "<stringId>": "<final text for that string>", ... }';

  const prompt = JSON.stringify({
    targetLanguage,
    contentFormat,
    brief,
    strings,
    writerOutput,
    qaFixList: qaResult?.fixList ?? [],
    qaScores: qaResult?.scores ?? null,
  });

  return completeJsonViaAiPrompt(ctx, { system, prompt });
}

/**
 * Full automated pipeline for one file, one target language (Phase 3.3).
 * Stage 1's three checks run in parallel; everything else is sequential.
 * QA (Stage 4) is logged for visibility only and never gates anything - a
 * QA failure or thrown error there is caught and recorded, not re-thrown.
 * Final polish (Stage 5, new) always runs and its output - not the raw
 * writer output - is what routes/webhook.js submits as the suggestion.
 */
async function runFullPipeline(ctx, { sourceText, targetLanguage, strings, contentFormat = "blog post" }) {
  const [auditResult, dataResult, geoResult] = await Promise.all([
    culturalAudit(ctx, { sourceText, targetLanguage, contentFormat }),
    dataLocalization(ctx, { sourceText, targetLanguage, contentFormat }),
    localGeo(ctx, { sourceText, targetLanguage, contentFormat }),
  ]);

  const brief = await buildBrief(ctx, { sourceText, targetLanguage, contentFormat, auditResult, dataResult, geoResult });
  const writerOutput = await writeFull(ctx, { brief, targetLanguage, strings, contentFormat });

  const qaResult = await automatedQa(ctx, {
    brief,
    targetLanguage,
    sourceText,
    transcreatedText: writerOutput,
  }).catch((err) => ({ error: err.message, scores: null, fixList: [], passed: false })); // QA failure must never block the pipeline - log and move on

  const finalOutput = await finalPolish(ctx, { brief, targetLanguage, strings, writerOutput, qaResult, contentFormat });

  return { brief, auditResult, dataResult, geoResult, writerOutput, qaResult, finalOutput };
}

module.exports = {
  culturalAudit,
  dataLocalization,
  localGeo,
  buildBrief,
  writeFull,
  writeParagraphs,
  automatedQa,
  finalPolish,
  runFullPipeline,
};
