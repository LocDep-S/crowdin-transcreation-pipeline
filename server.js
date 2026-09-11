require("dotenv").config();

const express = require("express");
const path = require("path");
const axios = require("axios");

const installRoutes = require("./routes/install");
const webhookRoutes = require("./routes/webhook");
const regenerateRoutes = require("./routes/regenerate");
const workflowStepSettingsRoutes = require("./routes/workflowStepSettings");

const app = express();
app.use(express.json());
// Serves /logo.png (used by manifest.json's top-level "logo" and the
// workflow-step-type module's own "logo") so the app doesn't show a broken/
// placeholder icon in Crowdin's Applications list or workflow editor.
app.use(express.static(path.join(__dirname, "public")));

// manifest.json served at a stable URL - this is the only thing registered with Crowdin.
app.get("/manifest.json", (req, res) => {
  const manifest = require("./manifest.json");
  // PUBLIC_BASE_URL overrides the placeholder baseUrl so this doesn't need
  // hand-editing every time the deployed URL changes (same pattern as the
  // Subtitle Video & Timing Editor precedent).
  const baseUrl = process.env.PUBLIC_BASE_URL || manifest.baseUrl;
  res.json({ ...manifest, baseUrl });
});

app.use("/hooks", installRoutes);
app.use("/webhooks", webhookRoutes);
app.use("/api/regenerate", regenerateRoutes);
app.use("/workflow-step-settings", workflowStepSettingsRoutes);

// TEMPORARY - one-off smoke test for the newly-added GEMINI_API_KEY env var.
// Gated behind DIAG_SECRET (a throwaway secret, unrelated to any other app
// credential) so this can't be used as an open proxy against the Gemini API
// by anyone who finds the URL. Never logs or returns the key itself, only
// Google's own status/error fields. Remove this whole route once the key
// has been confirmed working - along with the DIAG_SECRET env var.
app.get("/diagnostics/gemini-key-check", async (req, res) => {
  const diagSecret = process.env.DIAG_SECRET;
  if (!diagSecret || req.query.secret !== diagSecret) {
    return res.status(404).send("Not found");
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return res.status(200).json({ ok: false, error: "GEMINI_API_KEY is not set" });
  }
  try {
    const response = await axios.get(
      "https://generativelanguage.googleapis.com/v1beta/models",
      { params: { key } }
    );
    const models = (response.data.models || []).map((m) => m.name);
    return res.json({ ok: true, modelCount: models.length, sampleModels: models.slice(0, 5) });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      status: err.response ? err.response.status : null,
      message:
        err.response && err.response.data && err.response.data.error
          ? err.response.data.error.message
          : err.message,
    });
  }
});

app.get("/", (req, res) => {
  res.send("crowdin-transcreation-pipeline is running. See /manifest.json.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`crowdin-transcreation-pipeline listening on port ${PORT}`);
});
