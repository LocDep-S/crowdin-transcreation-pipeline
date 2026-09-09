/**
 * Settings iframe for the Transcreation Pipeline workflow step.
 *
 * SIMPLIFIED 2026-09-09: this used to show an "AI prompt" dropdown so an
 * admin could pick one of the org's Crowdin AI Prompts (the pipeline would
 * then call that prompt's provider/model). That approach didn't work -
 * Crowdin's AI Prompt Completion endpoint only supports translate/QA-shaped
 * prompts, not this pipeline's freeform multi-stage reasoning (confirmed
 * against Crowdin's own OpenAPI spec after every live attempt 404'd - see
 * lib/anthropic.js's header and the plan doc). The pipeline now calls
 * Anthropic directly with a server-side ANTHROPIC_API_KEY (Render env var
 * only), so there is nothing project-specific left to configure here - no
 * dropdown, no per-project settings, nothing this page needs to persist.
 *
 * This page still needs to exist (manifest.json's workflow-step-type module
 * declares `url`/`updateSettingsUrl`/`deleteSettingsUrl` for this step, and
 * changing that module's shape risks re-triggering the catalog-registration
 * fragility documented in the crowdin-workflow-steps skill), but it's now
 * just a static informational panel with no fields to fill in and nothing
 * to fetch - which also means the AP.getContext() hang this file used to
 * work around (see git history) can't recur, since nothing here depends on
 * its response any more.
 *
 * Mechanics preserved from the working version (CONFIRMED against Crowdin's
 * app-settings-iframe docs and hard-won via live debugging - see the
 * crowdin-workflow-steps skill's "Select languages panel reset bug" notes):
 *   - `window.formRef = { validateForm: () => boolean }` must exist.
 *   - `AP.formDataUpdated(settings)` should be called once, on load, to
 *     establish a baseline - NOT repeatedly, and never in a way that fires
 *     after the user has interacted with Crowdin's own native "Select
 *     languages" field on this same panel, or that field's pending
 *     selection can get wiped by Crowdin re-syncing from the last save.
 *     There's nothing left for the user to interact with here, so a single
 *     empty-object baseline call on load is enough.
 */

const express = require("express");

const router = express.Router();

router.get("/", (req, res) => {
  res.type("html").send(SETTINGS_PAGE_HTML);
});

/** manifest.json's updateSettingsUrl - Crowdin calls this when an admin saves the step's settings. Nothing to persist any more; just acknowledge. */
router.post("/update", (req, res) => {
  res.status(200).json({ status: "saved" });
});

/** manifest.json's deleteSettingsUrl - Crowdin calls this when the step is removed from a workflow. Nothing to clean up any more; just acknowledge. */
function handleDelete(req, res) {
  res.status(200).json({ status: "deleted" });
}
router.delete("/delete", handleDelete);
router.post("/delete", handleDelete); // defensive fallback in case Crowdin POSTs instead of DELETEs here in practice

const SETTINGS_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Transcreation Pipeline settings</title>
<script src="https://cdn.crowdin.com/apps/dist/iframe.js"></script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 16px; color: #262b30; font-size: 13px; line-height: 1.5; }
  p { margin: 0 0 8px; }
</style>
</head>
<body>
<p>This step runs the Transcreation Pipeline automatically using Sinch's own Anthropic account - there is no per-project configuration needed here.</p>
<p>Which languages this step handles is set in the "Select languages" field on this same panel, not here.</p>

<script>
(function () {
  window.formRef = { validateForm: function () { return true; } };
  window.currentFormData = {};
  if (window.AP && typeof AP.formDataUpdated === "function") {
    AP.formDataUpdated({});
  }
})();
</script>
</body>
</html>
`;

module.exports = router;


module.exports = router;
