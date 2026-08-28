# crowdin-transcreation-pipeline

Self-hosted Crowdin App (classic, not serverless) — the automated 5-stage
transcreation pipeline, running as a `workflow-step-type` module for files
carrying the `Transcreation` label. Also exposes `/api/regenerate`, the
endpoint the *separate* serverless Regenerate panel app
(`crowdin-transcreation-panel`) calls into for the manual amendment loop.

See the plan doc (`hazy-stargazing-papert.md`) for full context — this
README covers just this app's setup and what's still genuinely unresolved.

## What's real vs. what's a placeholder in this scaffold

**Real, working patterns** (carried over from the Subtitle Video & Timing
Editor app, already proven in production against this same Crowdin org):
Upstash-backed installation storage, the domain-scoped API host handling,
the custom-Fields idempotent-create + read-merge-write pattern, the
detailed-error-wrapping convention, the Render + GitHub Actions keep-alive
deployment recipe.

**Explicitly NOT yet verified or finished** — do not treat these as done:

1. **`crowdin_agent` authentication mechanics** (`lib/crowdinAuth.js`). The
   token-exchange flow here is copied from the `crowdin_app` pattern that
   works for the precedent app's editor-right-panel. Whether a
   `workflow-step-type` module's `crowdin_agent` auth uses the identical
   OAuth token endpoint/grant type has not been confirmed against a live
   install. **First task on a real install: log the raw `/hooks/installed`
   payload and cross-check against Crowdin's `crowdin-apps-security` docs.**
2. **The `string.status_on_step.recalculation_triggered` payload shape**
   (`routes/webhook.js`). Field names for project/step/language/string IDs
   and how the org's Enterprise domain is identified are best-guesses.
   Logging is deliberately verbose on this route for that reason — trim it
   once confirmed.
3. **Workflow step port names** (`manifest.json`) — **fixed after a rejected
   install attempt.** Crowdin's workflow-step-type ports are a fixed enum
   (`untranslated`, `translated`, `approved`, `all`, `true`, `false`,
   `skipped`, plus `initial` for input only) — NOT free-form names. The
   first real install attempt was rejected outright for unrelated schema
   errors (`authenticationType` should be `authentication.type`, and
   `_comment_*` fields aren't allowed at all — Crowdin's manifest schema is
   strict), and researching the fix surfaced this too: `"fallback"` was
   never a valid port. It's now `"untranslated"` for the failure/no-result
   case, which is both valid and semantically right — the string genuinely
   is still untranslated. Input ports (`"initial"`, `"untranslated"`) and
   the routing model are otherwise unchanged: this step sits FIRST, ahead
   of AI Pre-translation. `"translated"` (success) routes straight to
   Proofreading, skipping the rest of the chain. `"untranslated"`
   (failure/no result) routes into the existing AI Pre-translation step, so
   a miss still gets a normal shot at translation via the standard chain
   rather than being parked. Still to confirm against the real workflow
   editor: that Crowdin actually lets two *different* steps both declare
   `"untranslated"` as an output port without conflict (this step's failure
   path and whatever upstream step already uses it).
4. **The five pipeline stage prompts** (`lib/pipeline.js`). This is real
   Phase 3 content work — porting the actual `sinch-transcreation` skill
   instructions — not something to fabricate in a scaffold.
5. **Per-file/language short-circuit** (`routes/webhook.js`). As written,
   if multiple strings from the same file arrive as separate webhook events
   close together, the naive check-then-run isn't safe against a race where
   two strings both see "no brief yet" and both kick off a full pipeline
   run. Fine for the single-file pilot; needs a real lock (e.g. an Upstash-
   backed per-file mutex, same idea as `store.claimRecalculationEvent`)
   before scaling past it.
6. **The `/api/regenerate` shared-secret auth** (`routes/regenerate.js`).
   Explicitly flagged as a placeholder in the plan (Phase 2b.3) — doesn't
   verify which Crowdin user/project is actually calling. Needs a real
   design before going live, not just before scaling.
7. **Failure-routing port** on pipeline errors — routes to `"untranslated"`
   (see item 3 — `"fallback"` isn't a valid Crowdin port; `"untranslated"`
   is the corrected name), which the workflow editor wires into the
   existing AI Pre-translation step rather than parking the string. This
   was an open decision in the plan; it's now settled this way.

## Setup

```bash
npm install
cp .env.example .env
# fill in real values
npm run dev
```

1. Register a Crowdin OAuth Application (Organization Settings → OAuth
   apps) for "Transcreation Pipeline" — gives you `CROWDIN_CLIENT_ID` /
   `CROWDIN_CLIENT_SECRET`. (Pending item 1 above — confirm this step is
   actually required for a `crowdin_agent` app the same way it was for the
   `crowdin_app` precedent.)
2. Deploy to Render (see `render.yaml`), set all env vars from
   `.env.example` in the Render dashboard.
3. Update `manifest.json`'s `baseUrl` (or just rely on `PUBLIC_BASE_URL`,
   which overrides it at request time — see `server.js`).
4. Install the app in Crowdin via the manifest URL
   (`https://<your-render-url>/manifest.json`).
5. Watch the server logs on first install and first webhook delivery —
   both routes log their raw payloads deliberately, for exactly the reasons
   in items 1–2 above.

## Local testing without a real Crowdin install

There's no dev-harness page in this app (unlike the panel-based precedent)
since a `workflow-step-type` module has no browser UI of its own — the
fastest way to exercise `routes/webhook.js` locally is `curl`-ing it with a
hand-built payload once you've confirmed the real shape from a live log.
