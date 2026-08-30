/**
 * Install/uninstall hooks. Same shape as the Subtitle Video & Timing Editor
 * precedent, plus the "ensure the Field exists" self-heal call from
 * crowdin-fields-api.md, run at install time so a fresh install always has
 * the brief Field without a manual step.
 */

const express = require("express");
const store = require("../lib/store");
const crowdinApi = require("../lib/crowdinApi");
const { getAccessToken } = require("../lib/crowdinAuth");

const router = express.Router();

router.post("/installed", async (req, res) => {
  // Log the raw body on first real install - don't assume field names match
  // the docs or the precedent app exactly (crowdin-app-fundamentals.md's
  // explicit warning). This line is intentionally noisy; trim once the real
  // payload shape is confirmed.
  console.log("[install] raw payload:", JSON.stringify(req.body));

  const { domain, appId, appSecret, userId, clientId, baseUrl, agentId, organizationId } = req.body;
  if (!domain || !appId || !appSecret) {
    console.warn("[install] Missing expected fields in installed payload - check the log above against what Crowdin actually sent.");
    return res.status(400).json({ error: "Missing required installation fields" });
  }

  await store.saveInstallation(domain, { domain, appId, appSecret, userId, clientId, baseUrl, agentId, organizationId });

  // NOT independently confirmed whether the `installed` payload always
  // includes organizationId - captured defensively so
  // routes/workflowStepSettings.js's update/delete handlers (which Crowdin's
  // docs say receive organizationId, not domain) can resolve back to a
  // domain. If it's missing here, that resolution will fail loudly later
  // with an actionable error rather than silently guessing.
  if (organizationId) {
    await store.saveOrganizationDomainMapping(organizationId, domain).catch((err) => {
      console.error("[install] saveOrganizationDomainMapping failed:", err.message);
    });
  }

  try {
    const accessToken = await getAccessToken(domain);
    await crowdinApi.ensureBriefFieldExists(accessToken, domain);
  } catch (err) {
    // Don't fail the install over this - ensureBriefFieldExists is also
    // called defensively before every write, so a transient failure here
    // isn't fatal. But it should be visible.
    console.error("[install] ensureBriefFieldExists failed at install time:", err.message);
  }

  res.status(200).json({ status: "installed" });
});

router.post("/uninstall", async (req, res) => {
  const { domain } = req.body;
  console.log(`[install] uninstall for domain=${domain}`);
  if (domain) await store.removeInstallation(domain);
  res.status(200).json({ status: "uninstalled" });
});

module.exports = router;
