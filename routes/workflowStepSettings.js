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
 * Domain/project resolution: Crowdin appends a signed JWT to this iframe's
 * URL on every load (?jwtToken=...&tokenJwt=...) carrying { domain, context:
 * { project_id, workflow_step_id, ... } } in its payload - confirmed live by
 * inspecting the real network request. The frontend decodes that JWT
 * directly (no signature verification needed - we only use it to pick which
 * org/project's AI prompts to list) rather than relying on AP.getContext(),
 * which was observed to hang indefinitely for this module type against a
 * real install and left the "AI prompt" dropdown stuck on "Loading AI
 * prompts..." forever. AP.getContext() is kept as a fallback in case the JWT
 * query params are ever absent.
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
                    <option value="">Loading AI prompts...</option>
                    </select>
                    <div class="row">
                    <a class="configure-link" id="configure-link" href="#" target="_blank" rel="noopener">Configure AI Prompts -&gt;</a>
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

                    function decodeJwtPayload(token) {
                    try {
                    var parts = token.split(".");
                    if (parts.length < 2) return null;
                    var b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
                    while (b64.length % 4) b64 += "=";
                    var raw = atob(b64);
                    var json = decodeURIComponent(
                    raw
                    .split("")
                    .map(function (c) {
                    return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
                    })
                    .join("")
                    );
                    return JSON.parse(json);
                    } catch (e) {
                    return null;
                    }
                    }

function updateFormData() {
var settings = { aiPromptId: selectedPromptId, domain: domain };
window.currentFormData = settings;
return settings;
}

// Only call AP.formDataUpdated() in response to the user actually
// touching OUR field (the select's change handler below) - never on
// load/refresh. Crowdin's workflow-step settings panel appears to treat
// any formDataUpdated() call from this iframe as "the step's settings
// changed", and refreshes the whole panel (including its own native,
// not-yet-saved "Select languages" field) from the last-saved snapshot
// in response - which wipes out an in-progress language selection that
// hasn't been saved yet. Calling this automatically after every
// loadPrompts() (which runs on initial mount AND on REFRESH) was exactly
// that: a spurious "changed" signal fired on load, not on a real change.
// window.currentFormData is still kept up to date via updateFormData()
// so Crowdin can read our pending value directly when Save is clicked.
function notifyFormDataUpdated() {
var settings = updateFormData();
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
                    placeholder.textContent = "Select an AI prompt...";
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
                                        selectEl.innerHTML = "<option value=''>Loading AI prompts...</option>";
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
                    updateFormData();
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
                    notifyFormDataUpdated();
                    });

                    refreshBtn.addEventListener("click", function () {
                    loadPrompts();
                    });

                    var qDomain = getQueryParam("domain");
                    var qProjectId = getQueryParam("projectId") || getQueryParam("project_id");
                    var qJwt = getQueryParam("jwtToken") || getQueryParam("tokenJwt");
                    var jwtPayload = qJwt ? decodeJwtPayload(qJwt) : null;
                    var jwtDomain = jwtPayload && (jwtPayload.domain || (jwtPayload.context && jwtPayload.context.organization_domain));
                    var jwtProjectId = jwtPayload && jwtPayload.context && jwtPayload.context.project_id;

                    if (jwtDomain && jwtProjectId) {
                    init({ domain: jwtDomain, projectId: jwtProjectId });
                    } else if (qDomain && qProjectId) {
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
