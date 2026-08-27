/**
 * Storage for Crowdin installation credentials, backed by Upstash Redis.
 * Same pattern as the Subtitle Video & Timing Editor app - see that app's
 * lib/store.js header comment for why (no persistent disk on Render free
 * tier). Key namespace changed so this can safely share the same Upstash
 * database as that app, or use a fresh one - either works.
 */

const { Redis } = require("@upstash/redis");

const redis = Redis.fromEnv();
const KEY = "transcreation-pipeline:installations";
const IDEMPOTENCY_PREFIX = "transcreation-pipeline:recalc:";
const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24; // 24h - long enough to dedupe retried webhook deliveries

async function getInstallations() {
  const all = await redis.get(KEY);
  return all || {};
}

async function saveInstallation(domain, record) {
  const all = await getInstallations();
  all[domain] = { ...all[domain], ...record };
  await redis.set(KEY, all);
  return all[domain];
}

async function getInstallation(domain) {
  const all = await getInstallations();
  return all[domain];
}

async function removeInstallation(domain) {
  const all = await getInstallations();
  delete all[domain];
  await redis.set(KEY, all);
}

/**
 * Idempotency guard for `string.status_on_step.recalculation_triggered`
 * (Phase 3.7 in the plan - Crowdin can redeliver the same webhook event).
 * Returns true if this is the first time we've seen this key (caller should
 * proceed), false if it's a duplicate (caller should skip). Uses Redis SETNX
 * semantics via `set` with `nx: true`.
 */
async function claimRecalculationEvent(stringId, workflowStepId) {
  const key = `${IDEMPOTENCY_PREFIX}${workflowStepId}:${stringId}`;
  const result = await redis.set(key, Date.now(), { nx: true, ex: IDEMPOTENCY_TTL_SECONDS });
  return result !== null; // null means the key already existed - duplicate delivery
}

module.exports = {
  getInstallations,
  saveInstallation,
  getInstallation,
  removeInstallation,
  claimRecalculationEvent,
};
