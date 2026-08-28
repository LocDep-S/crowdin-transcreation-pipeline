/**
 * Crowdin auth helper for this app.
 *
 * CONFIRMED against Crowdin's own docs (support.crowdin.com/developer/
 * crowdin-apps-module-workflow-step-type/, "Agent Authentication" section):
 * a workflow-step-type module authenticates as `crowdin_agent`, a DIFFERENT
 * grant type from `crowdin_app` (used by the Subtitle Video & Timing Editor
 * precedent this file's structure was originally copied from). The token
 * exchange is still POST https://accounts.crowdin.com/oauth/token, but with
 * grant_type "crowdin_agent" and one extra required param, agent_id - the
 * numeric `agentId` Crowdin sends on the `installed` webhook only for
 * crowdin_agent apps (see routes/install.js, which now persists it).
 * The resulting access token is issued for the agent/bot user, not the
 * installing user.
 *
 * First real install attempt (before this fix) failed here with a 401 -
 * root cause was exactly this: grant_type was hardcoded to "crowdin_app"
 * and agent_id was never sent at all.
 */

const axios = require("axios");
const jwt = require("jsonwebtoken");
const store = require("./store");

const OAUTH_TOKEN_URL = "https://accounts.crowdin.com/oauth/token";

async function exchangeForAccessToken(installation) {
  const { data } = await axios.post(OAUTH_TOKEN_URL, {
    grant_type: "crowdin_agent", // confirmed via Crowdin's workflow-step-type module docs
    client_id: process.env.CROWDIN_CLIENT_ID || installation.clientId,
    client_secret: process.env.CROWDIN_CLIENT_SECRET,
    app_id: installation.appId,
    app_secret: installation.appSecret,
    domain: installation.domain,
    user_id: installation.userId,
    agent_id: installation.agentId,
  });
  const expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return store.saveInstallation(installation.domain, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessTokenExpiresAt: expiresAt,
  });
}

/** Returns a valid access token for the given domain, refreshing if needed. */
async function getAccessToken(domain) {
  let installation = await store.getInstallation(domain);
  if (!installation) {
    throw new Error(`No installation found for domain "${domain}". Is the app installed?`);
  }
  const isExpired =
    !installation.accessToken ||
    !installation.accessTokenExpiresAt ||
    Date.now() >= installation.accessTokenExpiresAt;

  if (isExpired) {
    installation = await exchangeForAccessToken(installation);
  }
  return installation.accessToken;
}

/**
 * Verify a JWT Crowdin signs and includes on relevant requests (webhook
 * payloads carry org/domain context; the workflow-step-type module doesn't
 * have a browser-facing panel of its own the way the editor-right-panel
 * precedent does, so this is used to validate the webhook sender rather
 * than a panel's iframe query param). Signed with the OAuth Application's
 * static client secret, same as the precedent app.
 */
async function verifyJwt(jwtToken) {
  const secret = process.env.CROWDIN_CLIENT_SECRET;
  if (!secret) {
    throw new Error("Server misconfigured: CROWDIN_CLIENT_SECRET is not set");
  }
  return jwt.verify(jwtToken, secret, { algorithms: ["HS256"] });
}

module.exports = { getAccessToken, verifyJwt, exchangeForAccessToken };
