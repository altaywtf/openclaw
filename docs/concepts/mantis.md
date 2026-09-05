---
summary: "Mantis captures and audits visual end-to-end evidence for live transport comparisons and focused browser proofs, then attaches artifacts to PRs."
title: "Mantis"
read_when:
  - Building or running live visual QA for OpenClaw bugs
  - Adding before and after verification for a pull request
  - Adding Discord, Slack, WhatsApp, or other live transport scenarios
  - Running focused Control UI browser proof for a candidate ref
  - Auditing recordings for transient streaming or rendering defects
  - Debugging QA runs that need screenshots, browser automation, or VNC access
---

Mantis publishes visual CI evidence and a PR comment for OpenClaw behavior.
Live transport scenarios compare a known-bad baseline with a candidate ref;
focused browser lanes may instead prove one candidate against a deterministic
mocked transport. Discord shipped first with real bot auth, guild channels, reactions, threads,
and a browser witness. Slack and focused Control UI chat lanes exist too;
WhatsApp and Matrix are unimplemented.

Recorded desktop and Control UI flows also run a video audit with Gemini 3.8
Flash agentic video understanding. The audit checks transitions across the recording,
reports timestamped findings, and distinguishes observed defects from
unverified causal hypotheses.

## Ownership

- OpenClaw (`extensions/qa-lab/src/mantis/*`): scenario runtime, `pnpm openclaw qa mantis <command>` CLI, evidence schema.
- QA Lab (`extensions/qa-lab/src/live-transports/*`): live transport harness, driver/SUT bots, report/evidence writers.
- Crabbox (`openclaw/crabbox`): warmed Linux machines, leases, VNC, `crabbox media preview`.
- GitHub Actions (`.github/workflows/mantis-*.yml`): remote entrypoints, artifact retention.
- ClawSweeper: parses maintainer PR commands, dispatches workflows, posts the final PR comment.

## CLI commands

All commands are `pnpm openclaw qa mantis <command>`, defined in
`extensions/qa-lab/src/mantis/cli.ts`. Requires `OPENCLAW_ENABLE_PRIVATE_QA_CLI=1`
at build/run time (bundled workflows set `OPENCLAW_BUILD_PRIVATE_QA=1` and
`OPENCLAW_ENABLE_PRIVATE_QA_CLI=1` before building).

| Command                         | Purpose                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `discord-smoke`                 | Verify the Mantis Discord bot can see the guild/channel, post, and react.                                                         |
| `run`                           | Run a before/after scenario against baseline and candidate refs (Discord only).                                                   |
| `desktop-browser-smoke`         | Lease/reuse a Crabbox desktop, open a visible browser, capture screenshot + video.                                                |
| `slack-desktop-smoke`           | Lease/reuse a Crabbox desktop, run Slack QA inside it, open Slack Web, capture evidence.                                          |
| `visual-task` / `visual-driver` | Capture a desktop flow, check its screenshot, and audit the finalized video; `visual-driver` runs under `crabbox record --while`. |
| `audit-video`                   | Audit an existing finalized recording with Gemini 3.8 Flash agentic video understanding.                                          |
| `audit-evidence`                | Audit full recordings in an evidence bundle and write a new manifest with the combined verdict.                                   |

Every command accepts `--repo-root <path>`. All except `audit-evidence` accept
`--output-dir <path>`; Crabbox commands also accept `--crabbox-bin`, `--provider`, `--machine-class`/`--class`,
`--lease-id`, `--idle-timeout`, `--ttl`, and `--keep-lease`. Local CLI defaults
for provider/class are `hetzner`/`beast` unless noted otherwise; CI workflows
usually override both.

### `audit-video`

Configure Google API-key auth, such as `GEMINI_API_KEY`, through the existing
[provider setup](/concepts/model-providers#google-gemini-api-key), then audit a
completed recording:

```bash
pnpm openclaw qa mantis audit-video --json \
  --file .artifacts/qa-e2e/streaming/recording.mp4 \
  --output-dir .artifacts/qa-e2e/mantis/streaming \
  --prompt "Check whether streamed text disappears or repeats before the response completes."
```

Mantis pins `google/gemini-3.8-flash` through the existing
[media-understanding](/nodes/media-understanding) auth path. The
`generateContent` request sets `mediaProcessing: "AGENTIC"` on the video part;
the response must include a `MEDIA_PROCESSING` tool call and result. See
Google's [agentic video guide](https://ai.google.dev/gemini-api/docs/generate-content/video-understanding#agentic-video-understanding).

The finalized recording must be nonempty and at most **50 MiB**, leaving
base64 and prompt headroom under Google's
[100 MB inline payload limit](https://ai.google.dev/gemini-api/docs/file-input-methods#input-method-comparison).
Requests time out after **180 seconds**; `--prompt` accepts up to 512 characters.
`--repo-root` defaults to the current directory; relative input paths resolve
from that root. Recordings and output directories must stay inside the repository
without traversing symlinks. `--output-dir` defaults to `.artifacts/qa-e2e/mantis`.

Each invocation preserves earlier evidence in a new `video-audit-*` directory
containing `video-audit.json` and `video-audit.md`. Completed reports include
coverage, the recording's SHA-256, and up to eight findings with millisecond
offsets from the recording start. Causes remain explicitly unverified hypotheses.

| Outcome | Meaning                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pass`  | Agentic navigation was verified, the model reported complete coverage, and no defects were reported.                                       |
| `fail`  | The audit reported one or more visible defects.                                                                                            |
| `error` | The audit could not establish a result, including API/auth failure, missing navigation evidence, malformed output, or incomplete coverage. |

Only `pass` exits successfully. Inspect errors in the report, correct provider
access or input problems, and rerun. Shorten recordings that exceed limits.

### `audit-evidence`

Use the same Google auth setup to audit the `fullVideo` artifacts in a schema
version 2 evidence bundle:

```bash
pnpm openclaw qa mantis audit-evidence --json \
  --repo-root . \
  --manifest .artifacts/qa-e2e/mantis/streaming/mantis-evidence.json
```

The command audits at most eight recordings within the repository's evidence
bundle. It writes a new `mantis-evidence-audited-<id>.json` beside the original,
with audit reports and metadata, preserving earlier evidence. Standard output
is JSON with `outputDir`, `manifestPath`, `reportPath`, and `status`; publish the
returned manifest.

A passing result requires the original functional expectations and clean
candidate video audits. Baseline defects remain reproduction evidence.
Candidate defects produce `fail`; unavailable audits or missing required
recordings produce `blocked`. Candidate video is required, plus baseline video
when the manifest includes a baseline. Only `pass` exits successfully.

Trusted desktop workflows reuse completed audits with `--smoke-results '<json>'`
instead of another model call. Supply an array of at most eight objects with
`lane` (`baseline` or `candidate`), repository-relative `summaryPath`, and the
capture command's `exitCode`. All referenced reports must remain in the evidence
bundle. An explicit `[]` records an optional capture skip and claims functional
evidence only. Nonempty batches require a candidate review. Candidate-provided
bundles use the default fresh audit path.

### `visual-task` / `visual-driver`

`visual-task` defaults to `--vision-mode image-describe`: the driver captures
and checks a screenshot while the recording runs, then the parent audits the
video after `crabbox record --while` finishes and the MP4 is finalized. Both
the screenshot check and video audit must pass. `--vision-model` chooses the
screenshot model; the video audit remains pinned to Gemini 3.8 Flash with
agentic processing. `--vision-prompt` also supplies the video audit task and
must fit its 512-character limit.

Use `--vision-mode metadata` explicitly for capture only. That mode records
artifacts without claiming visual model verification. `visual-driver` is the
recording's child process; run `visual-task` for the complete audit flow.

### `discord-smoke`

```bash
pnpm openclaw qa mantis discord-smoke \
  --output-dir .artifacts/qa-e2e/mantis/discord-smoke
```

Calls the Discord REST API (`https://discord.com/api/v10`) to fetch the bot
user, the guild, the guild's channels, and the target channel, asserts the
channel belongs to the guild, then (unless `--skip-post`) posts a message and
adds a `👀` reaction. Writes `mantis-discord-smoke-summary.json` and
`mantis-discord-smoke-report.md`.

Token resolution order: `--token-file` value, then `OPENCLAW_QA_DISCORD_MANTIS_BOT_TOKEN`
(override with `--token-env`), then a file named by `OPENCLAW_QA_DISCORD_MANTIS_BOT_TOKEN_FILE`
(override with `--token-file-env`). Guild/channel ids come from
`OPENCLAW_QA_DISCORD_GUILD_ID` / `OPENCLAW_QA_DISCORD_CHANNEL_ID` (override with
`--guild-id` / `--channel-id`) and must be 17-20 digit Discord snowflakes. Set
`OPENCLAW_QA_REDACT_PUBLIC_METADATA=1` to replace bot/guild/channel/message ids
and names with `<redacted>` in the published summary and report.

### `run`

```bash
pnpm openclaw qa mantis run \
  --transport discord \
  --scenario discord-status-reactions-tool-only \
  --baseline origin/main \
  --candidate HEAD \
  --output-dir .artifacts/qa-e2e/mantis/local-discord-status-reactions
```

`--transport` currently only accepts `discord`. `--scenario` is one of two
built-in ids, each with its own default baseline ref and expected before/after
labels (`extensions/qa-lab/src/mantis/run.runtime.ts`):

| Scenario                                   | Default baseline                           | Baseline expects                         | Candidate expects            |
| ------------------------------------------ | ------------------------------------------ | ---------------------------------------- | ---------------------------- |
| `discord-status-reactions-tool-only`       | `0bf06e953fdda290799fc9fb9244a8f67fdae593` | `queued-only`                            | `queued -> thinking -> done` |
| `discord-thread-reply-filepath-attachment` | `81349cdc2a9d5143fd0991ed858b739e7d96e05c` | thread reply omits `filePath` attachment | thread reply includes it     |

`--candidate` defaults to `HEAD`. Other flags: `--credential-source`
(default `convex`), `--credential-role` (default `ci`), `--provider-mode`
(default `live-frontier`), `--fast` (default on), `--skip-install`, `--skip-build`.

The runner creates detached `git worktree` checkouts for baseline and
candidate under `<output-dir>/worktrees/`, runs `pnpm install`/`pnpm build` in
each (unless skipped), then runs
`pnpm openclaw qa discord --scenario <id> --model openai/gpt-5.4 --alt-model openai/gpt-5.4 --allow-failures`
against each worktree. Each lane writes `discord-qa-reaction-timelines.json`
plus a `<scenario-id>-timeline.html`/`.png` pair; the runner copies this
evidence back under `baseline/`/`candidate/`, writes `comparison.json`,
`mantis-report.md`, and `mantis-evidence.json` in the output directory, and
exits nonzero if the comparison did not pass (baseline `fail` and candidate
`pass`).

The second Discord scenario (`discord-thread-reply-filepath-attachment`) posts
a parent message with the driver bot, creates a real thread, calls the SUT's
`message.thread-reply` action with a repo-local `filePath`, then polls the
thread for the reply and the attachment filename. It expects an attachment
named `mantis-thread-report.md`.

### `desktop-browser-smoke`

```bash
pnpm openclaw qa mantis desktop-browser-smoke \
  --output-dir .artifacts/qa-e2e/mantis/desktop-browser
```

Leases or reuses a Crabbox desktop, launches a browser inside the VNC session
pointed at `--browser-url` (default `https://openclaw.ai`) or a rendered
`--html-file`, waits, screenshots with `scrot`, optionally records an MP4 with
`ffmpeg`, and rsyncs `desktop-browser-smoke.png` / `.mp4` / `remote-metadata.json`
back to `--output-dir`.

After copying the finalized MP4, the command runs the video audit described
above. Its result covers browser launch and page rendering visible in that
recording. A missing recording or unsuccessful audit prevents a passing
smoke result.

Flags:

- `--lease-id <cbx_...>` reuses a warmed desktop instead of creating one.
- `--browser-profile-dir <remote-path>` reuses a remote Chrome user-data-dir so a persistent desktop stays logged in between runs (used for a long-lived Discord Web viewer profile).
- `--browser-profile-archive-env <name>` restores a base64 `.tgz` Chrome profile archive from that env var before launch (default `OPENCLAW_MANTIS_BROWSER_PROFILE_TGZ_B64`); used for logged-in witnesses like Discord Web.
- `--video-duration <seconds>` controls MP4 capture length (default 10s).
- `--keep-lease` (or `OPENCLAW_MANTIS_KEEP_VM=1`) keeps a lease this run created open for VNC inspection; failed runs that created a lease also keep it by default.

For Discord Web evidence, Mantis uses a dedicated viewer account, not a bot
token. The Discord REST oracle (via `qa discord`) remains authoritative; when
`OPENCLAW_QA_DISCORD_CAPTURE_UI_METADATA=1` is set, the scenario also writes a
Discord Web URL artifact, and `OPENCLAW_QA_DISCORD_KEEP_THREADS=1` leaves the
thread open long enough for the browser to open it.

The GitHub workflow prefers a persistent viewer profile via
`MANTIS_DISCORD_VIEWER_CHROME_PROFILE_DIR` (full profile archives can outgrow
GitHub's secret size limit); for small/bootstrap profiles it can restore a
base64 `.tgz` from `MANTIS_DISCORD_VIEWER_CHROME_PROFILE_TGZ_B64` instead. With
neither source configured, the workflow still publishes the deterministic
baseline/candidate screenshots and logs that the logged-in witness was
skipped.

### `slack-desktop-smoke`

```bash
pnpm openclaw qa mantis slack-desktop-smoke \
  --output-dir .artifacts/qa-e2e/mantis/slack-desktop \
  --gateway-setup \
  --scenario slack-canary \
  --keep-lease
```

Leases or reuses a Crabbox desktop, syncs the checkout into the VM, runs
`pnpm openclaw qa slack` inside it, opens Slack Web in the VNC browser,
captures the desktop, and copies both the Slack QA artifacts (`slack-qa/`) and
the VNC screenshot/video back locally. This is the only Mantis shape where the
SUT gateway and the browser both run inside the same VM.

With `--gateway-setup`, the command creates a persistent disposable OpenClaw
home at `$HOME/.openclaw-mantis/slack-openclaw` in the VM, patches Slack
Socket Mode config for the target channel, starts
`openclaw gateway run --dev --allow-unconfigured --port 38973`, and leaves
Chrome running in the VNC session; omitting `--gateway-setup` runs the normal
bot-to-bot Slack QA lane instead.

Required env for `--credential-source env` (local default is `env`; role
default is `maintainer`):

- `OPENCLAW_QA_SLACK_CHANNEL_ID`
- `OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN`
- `OPENCLAW_QA_SLACK_SUT_BOT_TOKEN`
- `OPENCLAW_QA_SLACK_SUT_APP_TOKEN`
- `OPENCLAW_LIVE_OPENAI_KEY` for the remote model lane (if only `OPENAI_API_KEY`
  is set locally, Mantis copies it to `OPENCLAW_LIVE_OPENAI_KEY` before
  invoking Crabbox)

With `--credential-source convex`, Mantis leases the Slack SUT credential from
the shared pool before creating the VM and forwards channel id, app token, and
bot token into the VM as `OPENCLAW_MANTIS_SLACK_*` env vars, so GitHub
workflows only need the Convex broker secret, not raw Slack tokens.

Other flags: `--slack-url <url>` opens a specific URL (otherwise Mantis derives
`https://app.slack.com/client/<team>/<channel>` from `auth.test`);
`--slack-channel-id <id>` sets the gateway allowlist channel;
`OPENCLAW_MANTIS_SLACK_BROWSER_PROFILE_DIR` controls the persistent Chrome
profile inside the VM (default `$HOME/.config/openclaw-mantis/slack-chrome-profile`);
`--approval-checkpoints` runs the native Slack approval scenarios
(`slack-approval-exec-native`, `slack-approval-plugin-native`) and renders
pending/resolved checkpoint screenshots instead of gateway setup (mutually
exclusive with `--gateway-setup`); `--hydrate-mode source|prehydrated`,
`--provider-mode`, `--model`, `--alt-model`, and `--fast` pass through to the
Slack live lane.

Approval checkpoint screenshots are rendered from the Slack API message the
scenario observed, not the live Slack UI; `slack-desktop-smoke.png` is only
proof of Slack Web itself when the lease's browser profile was already logged
in.

The Slack desktop recording starts after hydration and captures at 30 FPS.
The timed QA process waits for the first recorded frame, records the selected
gateway setup or QA flow, then finalizes the MP4 on completion or failure.
The audit covers the visible desktop during that interval. Headless approval
checkpoint screenshots remain separate evidence. Missing or incomplete
recordings and unsuccessful audits prevent a passing smoke result.

## Evidence manifest

The publisher and `audit-evidence` consume a schema version 2 manifest next
to its report. Capture workflows use `mantis-evidence.json`; an evidence
audit writes a new manifest as described above:

```json
{
  "schemaVersion": 2,
  "id": "discord-status-reactions",
  "title": "Mantis Discord Status Reactions QA",
  "summary": "Human-readable top summary for the PR comment.",
  "scenario": "discord-status-reactions-tool-only",
  "comparison": {
    "baseline": {
      "sha": "...",
      "status": "fail",
      "expected": "queued-only",
      "expectationMet": true
    },
    "candidate": {
      "sha": "...",
      "status": "pass",
      "expected": "queued -> thinking -> done",
      "expectationMet": true
    },
    "pass": true
  },
  "artifacts": [
    {
      "kind": "timeline",
      "lane": "baseline",
      "label": "Baseline queued-only",
      "path": "baseline/timeline.png",
      "targetPath": "baseline.png",
      "alt": "Baseline Discord timeline",
      "width": 420
    }
  ]
}
```

Artifact `path` is relative to the manifest's directory; `targetPath` is
relative to the configured R2/S3 artifact prefix. `scripts/mantis/publish-pr-evidence.mjs`
rejects path traversal and skips entries with `"required": false` when the
file is missing.

Artifact kinds: `timeline` (deterministic before/after screenshot),
`desktopScreenshot` (VNC/browser screenshot), `motionPreview` (inline animated
GIF from the recording), `motionClip` (motion-trimmed MP4), `fullVideo` (full
recording), `metadata` (JSON/log sidecar), `report` (Markdown report).

A run's on-disk artifact layout:

```text
.artifacts/qa-e2e/mantis/<run-id>/
  mantis-report.md
  mantis-evidence.json
  baseline/
  candidate/
  comparison.json
```

Screenshots are evidence, not secrets, but still need redaction discipline:
private channel names, usernames, or message content may appear. Set
`OPENCLAW_QA_REDACT_PUBLIC_METADATA=1` for public artifact uploads; it is
enabled by default in the Discord and Slack GitHub workflows.

## GitHub automation

`scripts/mantis/publish-pr-evidence.mjs` is the reusable publisher. Workflows
call it with the manifest, target PR, artifact target root, comment marker,
artifact URL, run URL, and request source. It uploads declared artifacts to
the Mantis R2 bucket, builds a summary-first PR comment with inline
images/previews and linked videos, then updates the existing marker comment or
creates a new one. Required env:

- `MANTIS_ARTIFACT_R2_ACCESS_KEY_ID`
- `MANTIS_ARTIFACT_R2_SECRET_ACCESS_KEY`
- `MANTIS_ARTIFACT_R2_BUCKET` (workflows set `openclaw-crabbox-artifacts`)
- `MANTIS_ARTIFACT_R2_ENDPOINT`
- `MANTIS_ARTIFACT_R2_REGION` (workflows set `auto`)
- `MANTIS_ARTIFACT_R2_PUBLIC_BASE_URL` (workflows set `https://artifacts.openclaw.ai`)

Comments post through the Mantis GitHub App (`MANTIS_GITHUB_APP_ID` /
`MANTIS_GITHUB_APP_PRIVATE_KEY`), not `github-actions[bot]`, using a hidden
marker comment as the upsert key.

| Workflow                          | Trigger         | What it does                                                                                                                                                                                                                                                                     |
| --------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Mantis Discord Smoke`            | manual dispatch | Runs `discord-smoke` against a chosen ref.                                                                                                                                                                                                                                       |
| `Mantis Discord Status Reactions` | manual dispatch | Builds separate baseline/candidate worktrees, runs `discord-status-reactions-tool-only` on each, renders each lane's timeline in a Crabbox desktop browser, generates motion-trimmed GIF/MP4 previews with `crabbox media preview`, uploads artifacts, posts inline PR evidence. |
| `Mantis Scenario`                 | manual dispatch | Generic dispatcher: takes `scenario_id` (`discord-status-reactions-tool-only`, `discord-thread-reply-filepath-attachment`, `slack-desktop-smoke`, `web-ui-chat-proof`), `baseline_ref`, `candidate_ref`, `pr_number`, and forwards to the matching scenario workflow.            |
| `Mantis Slack Desktop Smoke`      | manual dispatch | Leases a Crabbox Linux desktop (defaults to `aws`, choice of `hetzner`), runs `slack-desktop-smoke --gateway-setup` against the candidate, records the desktop, generates a motion preview, uploads artifacts, posts PR evidence when a PR number is given.                      |
| `Mantis Web UI Chat Proof`        | manual dispatch | Runs the focused Control UI chat Playwright proof against the candidate, captures screenshots/video, audits the recording with Gemini in a separate trusted job, and posts combined PR evidence. This lane covers web chat, not WinUI/native-app or arbitrary visual proof.      |

The Control UI candidate job runs without provider credentials. A separate
audit job checks out the trusted workflow SHA, builds the QA runtime, and
downloads the captured bundle. Only its audit step receives the existing
`GEMINI_API_KEY` secret through `qa-live-shared`. The job retains artifacts
even when the audit fails; publishing uses the exact returned audited
manifest, so missing video, unavailable audits, or candidate defects cannot
produce a passing PR verdict.

`Mantis Discord Status Reactions` accepts `baseline_ref`/`candidate_ref` and
validates that the resolved SHA is either an
ancestor of `origin/main`, a release tag (`v*`), or the head of an open PR
before running with secret-bearing credentials.

The Discord and Slack capture workflows retain the persisted video audit
reports without another model call. Candidate visual defects veto a pass;
baseline visual defects remain reproduction evidence. The thread-attachment
workflow can skip its optional logged-in viewer capture, in which case it
explicitly reports functional evidence without a video audit.

The scenario workflows remain available through manual Actions dispatch.

ClawSweeper can also dispatch a scenario directly:

```text
@clawsweeper mantis discord discord-status-reactions-tool-only
```

## Machines and secrets

Local CLI Crabbox defaults are `--provider hetzner --class beast`; override
with `--provider`, `--class`/`--machine-class`, or
`OPENCLAW_MANTIS_CRABBOX_PROVIDER` / `OPENCLAW_MANTIS_CRABBOX_CLASS`. GitHub
workflows commonly override both (for example `--class standard`, and the
Slack workflow's `aws`/`hetzner` provider choice input). If a provider is too
slow or unavailable, add it behind the same Crabbox interface rather than
hardcoding a fallback.

VM baseline: Linux with a desktop-capable Chrome/Chromium, CDP access, VNC/
noVNC, Node 22.22.3+, 24.15+, or 25.9+ and pnpm, an OpenClaw checkout, and
outbound access to the target transport, GitHub, model providers, and the
credential broker.

Credential and environment names used across Mantis commands and workflows:

- `OPENCLAW_QA_DISCORD_MANTIS_BOT_TOKEN`
- `OPENCLAW_QA_DISCORD_GUILD_ID`
- `OPENCLAW_QA_DISCORD_CHANNEL_ID`
- Local `qa mantis run --credential-source env` also requires
  `OPENCLAW_QA_DISCORD_DRIVER_BOT_TOKEN`, `OPENCLAW_QA_DISCORD_SUT_BOT_TOKEN`,
  and `OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID`. GitHub workflows normally use
  `--credential-source convex` and the broker credentials below instead of raw
  Discord bot tokens.
- `OPENCLAW_QA_REDACT_PUBLIC_METADATA=1` for public artifact uploads
- `OPENCLAW_QA_CONVEX_SITE_URL`, `OPENCLAW_QA_CONVEX_SECRET_CI`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY` for video audits; the Control UI audit job uses the existing GitHub secret of the same name.
- `CRABBOX_COORDINATOR` / `CRABBOX_COORDINATOR_TOKEN` (workflows also accept
  `OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR` / `_TOKEN` as a fallback and map
  them onto the plain names before invoking Crabbox)
- `CRABBOX_ACCESS_CLIENT_ID`, `CRABBOX_ACCESS_CLIENT_SECRET`
- `MANTIS_GITHUB_APP_ID`, `MANTIS_GITHUB_APP_PRIVATE_KEY`

The Mantis runner must never print Discord or Slack bot tokens,
provider API keys, browser cookies, auth profile contents, VNC passwords, or
raw credential payloads. If a token leaks into an issue, PR, chat, or log,
rotate it after the replacement secret is stored.

## Run outcomes

Before/after transport scenarios distinguish these outcomes so a flaky
environment does not read as a product regression:

- **Bug reproduced**: baseline failed the way the scenario expects.
- **Harness failure**: environment setup, credentials, transport API, browser,
  or provider failed before the oracle was meaningful.

Candidate-only browser proof combines the mocked Gateway and visible UI
assertions with the recording's video audit; it does not claim baseline
reproduction. Missing visual coverage or an unavailable audit blocks a
passing result.

## Adding a scenario

Live transport scenarios are TypeScript-defined per transport (see
`MANTIS_SCENARIO_CONFIGS` in `extensions/qa-lab/src/mantis/run.runtime.ts` for
the Discord before/after shape), not a standalone declarative file format.
Each scenario needs: id and title, transport, required credentials, baseline
ref policy, candidate ref policy, OpenClaw config patch, setup/stimulus steps,
expected baseline and candidate oracle, visual capture targets, timeout
budget, and cleanup steps.

Focused candidate-only browser proof can use a dedicated deterministic E2E test
and workflow. Keep its scope explicit, validate the candidate ref before
execution, isolate secret-backed publishing, and emit the same evidence
manifest contract.

Prefer small, typed oracles over vision checks: Discord reaction state or
message references, Slack thread `ts`/reaction API state, email message ids
and headers. Use browser screenshots when UI is the only reliable observable,
and keep vision checks additive to a platform-API oracle where one exists.

After Discord and Slack, the same runner shape extends to WhatsApp (QR login,
re-identification, delivery, media, reactions) and Matrix (encrypted rooms,
thread/reply relations, restart resume); neither is implemented yet.

## Open questions

- Which Discord bot should be the driver vs. the SUT when the existing Mantis
  bot is reused?
- How long should GitHub retain Mantis artifacts for PRs?
- When should ClawSweeper automatically recommend a Mantis scenario instead of
  waiting for a maintainer command?
- Should screenshots be redacted or cropped before upload for public PRs?
