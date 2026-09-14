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
 * Per-(file, language) lock guarding the full pipeline run (Phase 3.5 fix -
 * previously flagged in the README as a known gap, now fixed). Several
 * strings from the same file can land on the workflow step at nearly the
 * same time (a real multi-paragraph file will do this on first import), and
 * without a lock each one's naive "does a brief already exist?" check can
 * come back empty and each independently kick off a full, duplicate 5-stage
 * pipeline run for the same file+language - wasteful and can also produce
 * two different briefs for the same file (whichever saveBrief call lands
 * last wins, silently).
 *
 * Phase 3.5.1 fix (2026-09-14) - the original design used a flat 5-minute
 * TTL with no renewal, sized as "generous for one full pipeline run". Real
 * multi-string files proved that wrong: `runFullPipeline` for a ~78-string
 * page runs audit/data/geo, a brief compile, AND a writer+finalPolish pass
 * over every string in the file (see routes/webhook.js) - multiple
 * sequential Gemini calls over real content, which routinely took longer
 * than 5 minutes end-to-end. The old TTL expired mid-run, so every other
 * string waiting on the same file+language gave up (their own fixed 6-minute
 * poll timeout) before the brief was ever saved - in production project 52's
 * first real multi-string test, 100% of the strings that reached the
 * pipeline failed this way, none from an actual pipeline error.
 *
 * Fix: the lock holder now renews (`renewFileLanguageLock`) on a heartbeat
 * while `runFullPipeline` is running (see webhook.js), so a lock in active
 * use is kept alive well past this base TTL - the TTL here is now just the
 * dead-man's-switch ceiling for a crashed/hung process that stops renewing,
 * not a bound on real runtime. Waiters no longer wait out a fixed timer
 * either; they poll for the brief AND check whether the lock is still being
 * held (`isFileLanguageLockHeld`) - a genuinely still-running process keeps
 * them waiting indefinitely (bounded only by the absolute safety cap in
 * webhook.js), while a lock that has disappeared (released or expired
 * without a brief ever being saved - a real failure) fails them fast instead
 * of after a multi-minute timer.
 */
const FILE_LOCK_PREFIX = "transcreation-pipeline:filelock:";
const FILE_LOCK_TTL_SECONDS = 10 * 60; // dead-man's-switch ceiling only - see comment above; kept alive by heartbeat renewal for as long as the run is genuinely still going.

function fileLockKey(domain, projectId, fileId, languageId) {
  return `${FILE_LOCK_PREFIX}${domain}:${projectId}:${fileId}:${languageId}`;
}

/** Returns true if the lock was acquired (caller should run the pipeline), false if someone else already holds it (caller should wait for the brief instead). */
async function acquireFileLanguageLock(domain, projectId, fileId, languageId) {
  const key = fileLockKey(domain, projectId, fileId, languageId);
  const result = await redis.set(key, Date.now(), { nx: true, ex: FILE_LOCK_TTL_SECONDS });
  return result !== null;
}

/**
 * Heartbeat renewal for a lock this process already holds - called
 * periodically (see webhook.js's HEARTBEAT_INTERVAL_MS) while
 * `runFullPipeline` is still actively running, so a legitimately slow run
 * never loses its lock to the TTL. Deliberately a plain `expire` (no
 * ownership/fencing token check) - matches this codebase's existing
 * lightweight-lock philosophy (see the module comment above); the failure
 * mode of a missed renewal is bounded by FILE_LOCK_TTL_SECONDS, not
 * unbounded, so this stays a pragmatic self-healing design rather than a
 * strict distributed lock.
 */
async function renewFileLanguageLock(domain, projectId, fileId, languageId) {
  const key = fileLockKey(domain, projectId, fileId, languageId);
  await redis.expire(key, FILE_LOCK_TTL_SECONDS);
}

/** Returns true if the file+language lock is still held (i.e. the run is still going, or at least its heartbeat hasn't lapsed) - used by waiters to distinguish "still working" from "died without releasing". */
async function isFileLanguageLockHeld(domain, projectId, fileId, languageId) {
  const key = fileLockKey(domain, projectId, fileId, languageId);
  const val = await redis.get(key);
  return val !== null && val !== undefined;
}

async function releaseFileLanguageLock(domain, projectId, fileId, languageId) {
  const key = fileLockKey(domain, projectId, fileId, languageId);
  await redis.del(key);
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
  acquireFileLanguageLock,
  renewFileLanguageLock,
  isFileLanguageLockHeld,
  releaseFileLanguageLock,
  saveStepSettings,
  getStepSettings,
  deleteStepSettings,
  saveOrganizationDomainMapping,
  getDomainForOrganizationId,
};
