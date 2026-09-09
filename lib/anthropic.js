/**
 * Thin wrapper around the Anthropic Messages API. Every pipeline stage in
 * lib/pipeline.js goes through this - keeps API key access, model
 * selection, and error handling in one place.
 *
 * RESTORED 2026-09-09: this file previously existed, was deleted when the
 * pipeline was switched to route through Crowdin's own AI Prompt system
 * instead (see git history: "Add Anthropic Messages API wrapper" then
 * "Delete lib/anthropic.js"), and is now restored because that Crowdin-AI-
 * Prompt approach turned out not to work - Crowdin's AI Prompt Completion
 * endpoint (POST /users/{userId}/ai/prompts/{aiPromptId}/completions) only
 * accepts prompts with action `pre_translate` or `qa_check` (confirmed
 * against Crowdin's own OpenAPI spec), each with a fixed, translate-shaped
 * request schema - not the freeform multi-stage reasoning this pipeline
 * needs. Every attempt in the live test (project 52, file 16868) failed
 * with a 404 from that endpoint. See the plan doc / conversation history
 * for the full investigation.
 *
 * SECURITY: ANTHROPIC_API_KEY lives ONLY in Render's environment variable
 * panel (see render.yaml's `sync: false` entry and .env.example) - never in
 * this repo, which is public. Never log the raw error object from a failed
 * call here (only `err.message` / `err.status` / `err.error`, matching the
 * discipline lib/crowdinApi.js's withDetailedErrors already uses) - the
 * Anthropic SDK's own errors don't carry the key, but staying disciplined
 * about what gets logged is what keeps that true through future edits.
 */

const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-5";

async function withDetailedErrors(label, fn) {
  try {
    return await fn();
  } catch (err) {
    const detail = err?.error ? JSON.stringify(err.error) : err?.message || String(err);
    const status = err?.status ? ` (status ${err.status})` : "";
    throw new Error(`${label} failed${status}: ${detail}`);
  }
}

async function complete({ system, prompt, maxTokens = 4096, model = DEFAULT_MODEL }) {
  return withDetailedErrors("anthropic.complete", async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set - see .env.example / render.yaml");
    }
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
  });
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1] : trimmed;
}

async function completeJson(args) {
  const text = await complete(args);
  const candidate = stripCodeFence(text);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new Error(`Expected JSON from Anthropic, got unparseable text (first 800 chars): ${candidate.slice(0, 800)}`);
  }
}

module.exports = { complete, completeJson, DEFAULT_MODEL };
