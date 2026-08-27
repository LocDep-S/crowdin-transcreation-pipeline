/**
 * Crowdin auth helper for this app.
 *
 * IMPORTANT / NOT YET VERIFIED: this app authenticates as `crowdin_agent`
 * (required for the workflow-step-type module - a plain `crowdin_app` auth
 * type is not accepted for that module per Crowdin's docs), which is a
 * DIFFERENT authentication type from the Subtitle Video & Timing Editor
 * precedent this file's structure is otherwise copied from (that app uses
 * `crowdin_app`, an editor-right-panel-only app).
 *
 * The token-exchange flow below (`grant_type: crowdin_app`, `app_id`/
 * `app_secret` from the installed webhook, plus a static `client_id`/
 * `client_secret` from a registered Crowdin OAuth Application) is the
 * CONFIRMED-WORKING pattern for `crowdin_app`. Whether `crowdin_agent` uses
 * the identical OAuth token endpoint/grant type, or a different one specific
 * to bot agents, has NOT been confirmed against a live install yet - this is
 * the working assumption to start from, not a verified fact. First real
 * install: log the raw `events.installed` POST body (see routes/install.js)
 * and cross-check against https://developer.crowdin.com/crowdin-apps-security/
 * before trusting this file in production.
 */

const axios = require("axios");
const jwt = require("jsonwebtoken");
const store = require("./store");

const OAUTH_TOKEN_URL = "https://accounts.crowdin.com/oauth/token";

async function exchangeForAccessToken(installation) {
  const { data } = await axios.post(OAUTH_TOKEN_URL, {
    grant_type: "crowdin_app", // ASSUMPTION for crowdin_agent too - verify on first real install
    client_id: process.env.CROWDIN_CLIENT_ID || installation.clientId,
    client_secret: process.env.CROWDIN_CLIENT_SECRET,
    app_id: installation.appId,
    app_secret: installation.appSecret,
    domain: installation.domain,
    user_id: installation.userId,
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
