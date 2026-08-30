/**
 * Settings iframe for the Transcreation Pipeline workflow step, mirroring
 * Crowdin's own native "AI Auto-Translation" / "AI Pre-translation" step
 * settings panel - confirmed live (via the real workflow editor) to show
 * exactly: an "AI prompt" dropdown, a "Configure AI Prompts (opens in a new
 * tab)" link (confirmed destination pattern:
 * https://{domain}.crowdin.com/u/projects/{projectId}/ai), and a "REFRESH"
 * button. An admin picks one of the org's already-configured AI Prompts
 * here; the pipeline then calls that prompt via lib/aiPrompt.js, so it runs
 * on whichever provider/model that prompt is built on (the org has a
 * system-credentialed Anthropic provider among others - confirmed live) -
 * this app never needs its own ANTHROPIC_API_KEY.
 *
 * Mechanics (CONFIRMED against Crowdin's app-settings-iframe docs):
 *   - the iframe must define `window.formRef = { validateForm: () => boolean }`
 *   - it persists pending changes via `window.currentFormData = settings;
 *     AP.formDataUpdated(settings)`
 *   - on Save, Crowdin POSTs { organizationId, projectId, workflowId, stepId,
 *     settings } to manifest.json's `updateSettingsUrl`
 *   - on step removal, Crowdin DELETEs { organizationId, projectId,
 *     workflowId, stepId } to `deleteSettingsUrl`
 *
 * NOT independently confirmed this session: the exact global JS SDK script
 * URL, and the exact field names AP.getContext() resolves with for a
 * workflow-step-type settings iframe specifically (most examples in
 * Crowdin's docs are for the editor-right-panel module). Handled
 * defensively below: the frontend tries several plausible context shapes
 * and, as the most reliable fallback, includes `domain` directly inside the
 * `settings` payload it saves - so routes relying on it never depend on
 * organizationId->domain resolution succeeding (see lib/store.js's
 * saveOrganizationDomainMapping for the belt-and-suspenders fallback if
 * that ever turns out to be needed).
 */

const express = require("express");
const crowdinApi = require("../lib/crowdinApi");
const store = require("../lib/store");
const { getAccessToken } = require("../lib/crowdinAuth");

const router = express.Router();

async function resolveDomain(req) {
  // Prefer whatever's directly in the request - most reliable, no guessing.
  const fromQuery = req.query.domain;
  const fromBodySettings = req.body?.settings?.domain;
  const fromBody = req.body?.domain;
  if (fromQuery) return String(fromQuery);
  if (fromBodySettings) return String(fromBodySettings);
  if (fromBody) return String(fromBody);

  // Fall back to the organizationId -> domain mapping captured (if present)
  // at install time - see routes/install.js.
  const organizationId = req.body?.organizationId || req.query.organizationId;
  if (organizationId) {
    const mapped = await store.getDomainForOrganizationId(organizationId);
    if (mapped) return mapped;
  }
  return null;
}

router.get("/", (req, res) => {
  res.type("html").send(SETTINGS_PAGE_HTML);
});

/** List the org's configured AI Prompts, for the dropdown. */
router.get("/prompts", async (req, res) => {
  try {
    const domain = await resolveDomain(req);
    if (!domain) {
      return res.status(400).json({ error: "Could not resolve a Crowdin domain from the request (no ?domain= query param and no stored organizationId mapping)." });
    }
    const accessToken = await getAccessToken(domain);
    const prompts = await crowdinApi.listOrganizationAiPrompts(accessToken, domain);
    res.json({ prompts });
  } catch (err) {
    console.error("[workflowStepSettings] /prompts failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Currently-saved settings for this project, so the iframe can pre-select the saved prompt on load. */
router.get("/current", async (req, res) => {
  try {
    const domain = await resolveDomain(req);
    const projectId = req.query.projectId;
    if (!domain || !projectId) {
      return res.status(400).json({ error: "domain and projectId query params are both required." });
    }
    const settings = await store.getStepSettings(domain, projectId);
    res.json({ settings });
  } catch (err) {
    console.error("[workflowStepSettings] /current failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/** manifest.json's updateSettingsUrl - Crowdin calls this when an admin saves the step's settings. */
router.post("/update", async (req, res) => {
  console.log("[workflowStepSettings] /update raw payload:", JSON.stringify(req.body));
  try {
    const domain = await resolveDomain(req);
    const { projectId, workflowId, stepId, settings } = req.body || {};
    if (!domain || !projectId) {
      console.warn("[workflowStepSettings] /update could not resolve domain/projectId - check the raw payload log above.");
      return res.status(400).json({ error: "Could not resolve domain/projectId from the update payload." });
    }
    await store.saveStepSettings(domain, projectId, { ...settings, workflowId, stepId });
    res.status(200).json({ status: "saved" });
  } catch (err) {
    console.error("[workflowStepSettings] /update failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/** manifest.json's deleteSettingsUrl - Crowdin calls this when the step is removed from a workflow. */
async function handleDelete(req, res) {
  console.log("[workflowStepSettings] /delete raw payload:", JSON.stringify(req.body));
  try {
    const domain = await resolveDomain(req);
    const { projectId } = req.body || {};
    if (!domain || !projectId) {
      console.warn("[workflowStepSettings] /delete could not resolve domain/projectId - check the raw payload log above.");
      return res.status(400).json({ error: "Could not resolve domain/projectId from the delete payload." });
    }
    await store.deleteStepSettings(domain, projectId);
    res.status(200).json({ status: "deleted" });
  } catch (err) {
    console.error("[workflowStepSettings] /delete failed:", err.message);
    res.status(500).json({ error: err.message });
  }
}
router.delete("/delete", handleDelete);
router.post("/delete", handleDelete); // defensive fallback in case Crowdin POSTs instead of DELETEs here in practice

const SETTINGS_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Transcreation Pipeline settings</title>
<script src="https://cdn.crowdin.com/apps/2.x/app.js"></script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 16px; color: #262b30; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  select { width: 100%; padding: 8px; font-size: 14px; border: 1px solid #c7ccd1; border-radius: 4px; box-sizing: border-box; }
  .row { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
  a.configure-link { font-size: 13px; color: #2b76e5; text-decoration: none; }
  a.configure-link:hover { text-decoration: underline; }
  button#refresh-btn { font-size: 12px; font-weight: 600; letter-spacing: 0.03em; padding: 6px 12px; border: 1px solid #c7ccd1; border-radius: 4px; background: #fff; cursor: pointer; }
  button#refresh-btn:hover { background: #f5f6f7; }
  #error { margin-top: 10px; font-size: 12px; color: #c0392b; display: none; }
  #hint { margin-top: 10px; font-size: 12px; color: #6b7684; }
</style>
</head>
<body>
  <label for="prompt-select">AI prompt</label>
  <select id="prompt-select">
    <option value="">Loading AI prompts…</option>
  </select>
  <div class="row">
    <a class="configure-link" id="configure-link" href="#" target="_blank" rel="noopener">Configure AI Prompts ↗</a>
    <button id="refresh-btn" type="button">REFRESH</button>
  </div>
  <div id="hint">The pipeline runs on whichever provider/model this prompt uses - no separate API key needed.</div>
  <div id="error"></div>

<script>
(function () {
  var selectEl = document.getElementById("prompt-select");
  var configureLink = document.getElementById("configure-link");
  var refreshBtn = document.getElementById("refresh-btn");
  var errorEl = document.getElementById("error");

  var domain = null;
  var projectId = null;
  var selectedPromptId = "";

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = "block";
  }

  function getQueryParam(name) {
    var params = new URLSearchParams(window.location.search);
    return params.get(name);
  }

  function persist() {
    var settings = { aiPromptId: selectedPromptId, domain: domain };
    window.currentFormData = settings;
    if (window.AP && typeof AP.formDataUpdated === "function") {
      AP.formDataUpdated(settings);
    }
  }

  window.formRef = {
    validateForm: function () {
      if (!selectedPromptId) {
        showError("Pick an AI prompt before saving.");
        return false;
      }
      errorEl.style.display = "none";
      return true;
    },
  };

  function populateDropdown(prompts, savedPromptId) {
    selectEl.innerHTML = "";
    if (!prompts || prompts.length === 0) {
      var opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No AI prompts configured for this organization yet";
      selectEl.appendChild(opt);
      return;
    }
    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select an AI prompt…";
    selectEl.appendChild(placeholder);
    prompts.forEach(function (p) {
      var opt = document.createElement("option");
      opt.value = String(p.id);
      var label = p.name || ("AI prompt #" + p.id);
      if (p.action) label += " (" + p.action + ")";
      opt.textContent = label;
      if (savedPromptId && String(savedPromptId) === String(p.id)) {
        opt.selected = true;
      }
      selectEl.appendChild(opt);
    });
    selectedPromptId = selectEl.value || "";
  }

  function loadPrompts() {
    selectEl.innerHTML = '<option value="">Loading AI prompts…</option>';
    fetch("/workflow-step-settings/prompts?domain=" + encodeURIComponent(domain) + "&projectId=" + encodeURIComponent(projectId))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          showError(data.error);
          return;
        }
        fetch("/workflow-step-settings/current?domain=" + encodeURIComponent(domain) + "&projectId=" + encodeURIComponent(projectId))
          .then(function (r) { return r.json(); })
          .then(function (currentData) {
            var savedPromptId = currentData && currentData.settings ? currentData.settings.aiPromptId : null;
            populateDropdown(data.prompts, savedPromptId);
            persist();
          })
          .catch(function () {
            populateDropdown(data.prompts, null);
          });
      })
      .catch(function (err) {
        showError("Failed to load AI prompts: " + err.message);
      });
  }

  function init(ctx) {
    domain = ctx.domain || "";
    projectId = ctx.projectId || "";
    configureLink.href = "https://" + domain + ".crowdin.com/u/projects/" + projectId + "/ai";
    loadPrompts();
  }

  selectEl.addEventListener("change", function () {
    selectedPromptId = selectEl.value;
    errorEl.style.display = "none";
    persist();
  });

  refreshBtn.addEventListener("click", function () {
    loadPrompts();
  });

  // Resolve domain/projectId defensively: URL query params first (some
  // Crowdin app iframes are loaded with these appended), then AP.getContext()
  // if the JS SDK loaded, trying a few plausible field-name shapes since the
  // exact one for a workflow-step-type settings iframe wasn't independently
  // confirmed this session.
  var qDomain = getQueryParam("domain");
  var qProjectId = getQueryParam("projectId") || getQueryParam("project_id");

  if (qDomain && qProjectId) {
    init({ domain: qDomain, projectId: qProjectId });
  } else if (window.AP && typeof AP.getContext === "function") {
    AP.getContext().then(function (ctx) {
      var resolvedDomain = ctx.domain || (ctx.organization && ctx.organization.domain) || ctx.subdomain || qDomain;
      var resolvedProjectId = (ctx.project && ctx.project.id) || ctx.projectId || qProjectId;
      if (!resolvedDomain || !resolvedProjectId) {
        showError("Could not resolve the Crowdin domain/project from the app context. Raw context: " + JSON.stringify(ctx));
        return;
      }
      init({ domain: resolvedDomain, projectId: resolvedProjectId });
    }).catch(function (err) {
      showError("AP.getContext() failed: " + err.message);
    });
  } else {
    showError("Could not resolve the Crowdin domain/project - no query params and no AP.getContext() available.");
  }
})();
</script>
</body>
</html>
`;

module.exports = router;
