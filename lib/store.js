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
const STEP_SETTINGS_KEY = "transcreation-pipeline:step-settings";
const ORG_DOMAIN_MAP_KEY = "transcreation-pipeline:org-domain-map";

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

/**
 * Workflow-step settings (the "AI prompt" an admin picked in the step's
 * settings iframe - see routes/workflowStepSettings.js). Keyed by
 * `${domain}:${projectId}` rather than the full (workflowId, stepId) tuple
 * Crowdin's updateSettingsUrl payload technically carries - a deliberate
 * simplification, since in practice this app installs at most one
 * Transcreation Pipeline step per project, and keying this way lets both
 * routes/webhook.js (which only ever sees projectId, not a settings-page
 * context) and routes/regenerate.js (same - projectId, no stepId) look up
 * the same setting without needing to know which step wrote it. If a
 * project ever needs more than one step with independently-configured
 * prompts, this key needs to widen to include workflowId/stepId - flagging
 * that here rather than pretending it's already handled.
 */
function stepSettingsKey(domain, projectId) {
  return `${domain}:${projectId}`;
}

async function getAllStepSettings() {
  const all = await redis.get(STEP_SETTINGS_KEY);
  return all || {};
}

async function saveStepSettings(domain, projectId, settings) {
  const all = await getAllStepSettings();
  const key = stepSettingsKey(domain, projectId);
  all[key] = { ...all[key], ...settings, domain, projectId, updatedAt: Date.now() };
  await redis.set(STEP_SETTINGS_KEY, all);
  return all[key];
}

async function getStepSettings(domain, projectId) {
  const all = await getAllStepSettings();
  return all[stepSettingsKey(domain, projectId)] || null;
}

async function deleteStepSettings(domain, projectId) {
  const all = await getAllStepSettings();
  delete all[stepSettingsKey(domain, projectId)];
  await redis.set(STEP_SETTINGS_KEY, all);
}

/**
 * Maps a Crowdin organizationId (numeric, as sent on the workflow-step
 * settings update/delete callbacks per Crowdin's docs) to the org's
 * Enterprise domain (string, used everywhere else in this app - installs,
 * webhooks, the API client). Populated defensively at install time if the
 * `installed` webhook payload happens to include an organizationId
 * (unconfirmed whether it always does - see routes/install.js); if a
 * lookup here comes up empty, the caller should log a clear, actionable
 * error rather than guessing, per this codebase's established practice for
 * unverified integration points.
 */
async function saveOrganizationDomainMapping(organizationId, domain) {
  if (!organizationId) return;
  const all = (await redis.get(ORG_DOMAIN_MAP_KEY)) || {};
  all[String(organizationId)] = domain;
  await redis.set(ORG_DOMAIN_MAP_KEY, all);
}

async function getDomainForOrganizationId(organizationId) {
  const all = (await redis.get(ORG_DOMAIN_MAP_KEY)) || {};
  return all[String(organizationId)] || null;
}

module.exports = {
  getInstallations,
  saveInstallation,
  getInstallation,
  removeInstallation,
  claimRecalculationEvent,
  saveStepSettings,
  getStepSettings,
  deleteStepSettings,
  saveOrganizationDomainMapping,
  getDomainForOrganizationId,
};
