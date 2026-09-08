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

1. **`crowdin_agent` authentication mechanics** (`lib/crowdinAuth.js`) —
   **partially confirmed.** The app has now been through a real install (Sept
   4, 2026, into the Sinch org, project 52 only) using this exact grant type
   (`crowdin_agent` + `agent_id`), and the resulting workflow step correctly
   saves its config (languages, connections) via the live Crowdin API — see
   the plan doc / crowdin-workflow-steps skill for that investigation. What's
   still NOT confirmed: whether `exchangeForAccessToken` itself (the actual
   token exchange this file performs) has ever successfully run, since that
   only happens on `/hooks/installed` or on first API call, not from saving
   the workflow step's config in the UI. Check Render's logs for the
   `[install]` line from the Sept 4 install (or the next one) before assuming
   this is fully proven.
2. **The `string.status_on_step.recalculation_triggered` payload shape**
   (`routes/webhook.js`). Field names for project/step/language/string IDs
   and how the org's Enterprise domain is identified are best-guesses.
   Logging is deliberately verbose on this route for that reason — trim it
   once confirmed. **Still fully unconfirmed as of Sept 2026** — no string
   has ever actually reached this step for real yet (the pilot file hasn't
   been created in project 52 with the label). This, along with the AI
   Prompt completion request/response shape in `lib/crowdinApi.js`
   (`createAiPromptCompletion`/`extractCompletionText`, also unconfirmed),
   is the actual next milestone: a real end-to-end test.
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
4. **The five pipeline stage prompts** (`lib/pipeline.js`) — **DONE.** A real,
   thorough, automation-adapted port of all six `sinch-transcreation` skill
   stages (cultural audit, data localization, local GEO, brief builder,
   writer, QA, plus a final-polish stage the interactive skill family didn't
   originally need since a human normally applies QA fixes). Routes through
   Crowdin's own AI Prompt system (`lib/aiPrompt.js`) rather than holding a
   direct `ANTHROPIC_API_KEY` — see the note in `.env.example`. Not yet
   exercised against a real Crowdin AI Prompt completion call end-to-end —
   see item 2 above.
5. **Per-file/language short-circuit** (`routes/webhook.js`) — **FIXED.** A
   real Upstash-backed lock (`store.acquireFileLanguageLock`/
   `releaseFileLanguageLock`) now guards the full-pipeline-run branch: the
   first string to reach an (file, language) with no brief yet acquires the
   lock and runs the pipeline once; every other string either finds the
   brief already saved, or polls for it if it arrived while the lock-holder
   was still running. Not yet exercised against a real multi-string file —
   the lock/poll logic itself is untested against live concurrent webhook
   deliveries.
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
