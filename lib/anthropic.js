/**
 * Thin wrapper around the Anthropic Messages API. Every pipeline stage in
 * lib/pipeline.js goes through this - keeps the API key access, model
 * selection, and error handling in one place.
 */

const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Per-stage model tier is an explicitly "still open" decision in the plan
// (cost ownership/budget). Defaulting every stage to the same model for now;
// revisit once that's decided - cheaper/faster models may be fine for the
// mechanical stages (data localization, GEO) vs. the writing/QA stages.
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-5";

async function complete({ system, prompt, maxTokens = 4096, model = DEFAULT_MODEL }) {
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error("Anthropic response contained no text block");
  }
  return textBlock.text;
}

/** Same as `complete`, but parses the result as JSON and throws with the raw text included if parsing fails - every structured pipeline stage should use this rather than hand-rolling JSON.parse. */
async function completeJson(args) {
  const text = await complete(args);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Expected JSON from Anthropic, got unparseable text: ${text.slice(0, 500)}`);
  }
}

module.exports = { complete, completeJson, DEFAULT_MODEL };
