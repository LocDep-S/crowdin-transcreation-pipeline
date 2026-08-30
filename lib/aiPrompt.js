/**
 * Replaces lib/anthropic.js as the pipeline's AI-calling layer. Instead of
 * holding our own ANTHROPIC_API_KEY and calling Anthropic directly, every
 * pipeline stage now routes through one of the organization's own
 * already-configured Crowdin AI Prompts (picked by an admin in the
 * Transcreation Pipeline workflow step's settings iframe - see
 * routes/workflowStepSettings.js) - Crowdin then calls whichever provider/
 * model that prompt is built on (the org has a system-credentialed
 * "anthropic" provider among others, confirmed live).
 *
 * This mirrors the org's existing "AI Pipeline" app (aiProviderId 13),
 * which already extends Crowdin's AI Prompt system the same way via
 * `config.mode: "external"` prompts - live precedent that this pattern
 * works, not a novel guess.
 *
 * NOT independently confirmed against Crowdin's docs: the exact request/
 * response shape of the completion create/poll calls themselves (see the
 * detailed comments on lib/crowdinApi.js's createAiPromptCompletion and
 * extractCompletionText). Everything in THIS file just orchestrates those
 * calls (create -> poll -> extract) and stays agnostic to that shape.
 */

const crowdinApi = require("./crowdinApi");

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes - generous for a long writer-stage prompt

const TERMINAL_SUCCESS_STATUSES = ["finished", "success", "succeeded", "done"];
const TERMINAL_FAILURE_STATUSES = ["failed", "error", "cancelled", "canceled"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one prompt through Crowdin's AI Prompt completion system and return
 * the raw generated text.
 *
 * `ctx` = { accessToken, domain, aiPromptId } - the installation's access
 * token, the org's Enterprise domain, and the AI Prompt id an admin picked
 * in the step settings (see lib/store.js's step-settings functions).
 */
async function completeViaAiPrompt(ctx, { system, prompt }) {
  const { accessToken, domain, aiPromptId } = ctx;
  if (!aiPromptId) {
    throw new Error(
      "completeViaAiPrompt: no aiPromptId configured for this project's Transcreation Pipeline " +
        'step. An admin needs to open the step\'s settings in the workflow editor, pick an ' +
        '"AI prompt", and save before the pipeline can run.'
    );
  }

  const userId = await crowdinApi.getAuthenticatedUserId(accessToken, domain);

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const created = await crowdinApi.createAiPromptCompletion(accessToken, domain, userId, aiPromptId, messages);
  const completionId = created?.identifier;
  if (!completionId) {
    throw new Error(
      `completeViaAiPrompt: completion-creation response had no "identifier" field. ` +
        `Raw response: ${JSON.stringify(created).slice(0, 1000)}`
    );
  }

  let completion = created;
  const startedAt = Date.now();
  while (
    !TERMINAL_SUCCESS_STATUSES.includes(completion.status) &&
    !TERMINAL_FAILURE_STATUSES.includes(completion.status)
  ) {
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      throw new Error(
        `completeViaAiPrompt: completion ${completionId} (aiPromptId=${aiPromptId}) did not finish ` +
          `within ${POLL_TIMEOUT_MS}ms - last known status: "${completion.status}"`
      );
    }
    await sleep(POLL_INTERVAL_MS);
    completion = await crowdinApi.getAiPromptCompletion(accessToken, domain, userId, aiPromptId, completionId);
  }

  if (!TERMINAL_SUCCESS_STATUSES.includes(completion.status)) {
    throw new Error(
      `completeViaAiPrompt: completion ${completionId} (aiPromptId=${aiPromptId}) ended with status ` +
        `"${completion.status}", not a success status. Raw completion: ${JSON.stringify(completion).slice(0, 1500)}`
    );
  }

  return crowdinApi.extractCompletionText(completion);
}

/** Strip a ```json ... ``` (or bare ```) fence if the model wrapped its JSON output in one. */
function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1] : trimmed;
}

/** Same as completeViaAiPrompt, but parses the result as JSON - every structured pipeline stage should use this rather than hand-rolling JSON.parse. */
async function completeJsonViaAiPrompt(ctx, args) {
  const text = await completeViaAiPrompt(ctx, args);
  const candidate = stripCodeFence(text);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new Error(`completeJsonViaAiPrompt: expected JSON, got unparseable text (first 800 chars): ${text.slice(0, 800)}`);
  }
}

module.exports = { completeViaAiPrompt, completeJsonViaAiPrompt };
