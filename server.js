require("dotenv").config();

const express = require("express");
const path = require("path");

const installRoutes = require("./routes/install");
const webhookRoutes = require("./routes/webhook");
const regenerateRoutes = require("./routes/regenerate");

const app = express();
app.use(express.json());

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

app.get("/", (req, res) => {
  res.send("crowdin-transcreation-pipeline is running. See /manifest.json.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`crowdin-transcreation-pipeline listening on port ${PORT}`);
});
