---
summary: "Canonical credential eligibility and resolution semantics for auth profiles"
title: "Auth credential semantics"
read_when:
  - Working on auth profile resolution or credential routing
  - Debugging model auth failures or profile order
---

These semantics keep selection-time and runtime auth behavior aligned. They are shared by:

- `resolveAuthProfileOrder` (profile ordering)
- `resolveApiKeyForProfile` (runtime credential resolution)
- `openclaw models status --probe`
- `openclaw doctor` auth checks (`doctor-auth`)

## Stable probe reason codes

Probe results carry a `status` bucket (`ok`, `auth`, `rate_limit`, `billing`, `timeout`, `format`, `unknown`, `no_model`) plus a stable `reasonCode` when the probe never reached a model call:

| `reasonCode`             | Meaning                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| `excluded_by_auth_order` | Profile omitted from the explicit auth order for its provider.               |
| `missing_credential`     | No inline credential or SecretRef is configured.                             |
| `expired`                | Token `expires` is in the past.                                              |
| `invalid_expires`        | `expires` is not a valid positive Unix ms timestamp.                         |
| `unresolved_ref`         | Configured SecretRef could not be resolved.                                  |
| `ineligible_profile`     | Profile is incompatible with provider config (includes malformed key input). |
| `no_model`               | Credentials exist but no probeable model candidate resolved.                 |

Eligibility checks report `ok` as the reason code for usable credentials.

## Token credentials

Token credentials (`type: "token"`) support inline `token` and/or `tokenRef`.

### Eligibility rules

1. A token profile is ineligible when both `token` and `tokenRef` are absent (`missing_credential`).
2. `expires` is optional. When present it must be a finite number of Unix epoch milliseconds greater than `0` and no larger than the maximum JavaScript `Date` timestamp (8640000000000000).
3. If `expires` is invalid (wrong type, `NaN`, `0`, negative, non-finite, or beyond that maximum), the profile is ineligible with `invalid_expires`.
4. If `expires` is in the past, the profile is ineligible with `expired`.
5. `tokenRef` does not bypass `expires` validation.

### Resolution rules

1. Resolver semantics match eligibility semantics for `expires`.
2. For eligible profiles, token material may be resolved from the inline value or `tokenRef`.
3. Unresolvable refs produce `unresolved_ref` in `models status --probe` output.

## Saved setup replacements

Model Setup saves a core-owned replacement credential before testing the selected
model. It assigns a separate profile identity and keeps that credential pending.
The existing credential, default model, and automatic profile order remain
unchanged during the test.

- A first sign-in for a provider becomes active immediately. Normal `/login`
  also keeps its immediate-use behavior; it does not use this pending workflow.
- A pending replacement is excluded from automatic selection, ordinary model
  catalogs, active-profile status, and agent credential copies.
- The confirmation turn explicitly selects the saved candidate. OAuth refresh
  updates that candidate in its pending owner, not the active credential store.
- A failed or cancelled confirmation keeps the candidate pending. Open Model
  Setup and select **Saved … sign-in** to retry without signing in again.
  The saved choice retains the provider connection settings needed for retry.
- `openclaw models auth list` lists saved pending sign-ins separately.
  `openclaw models auth logout <profile-id>` removes a saved candidate.
- A successful confirmation writes the selected default with its exact profile
  binding before activating the replacement. Gateway setup also waits for that
  exact configuration to become active. This prevents a connection-specific key
  from being sent through the previous endpoint.
- A failed config write or runtime application leaves the replacement pending
  and the previous credential available. The file may already contain the new
  settings; check Model Setup instead of assuming the default stayed unchanged.
- A restart-required result does not promise automatic credential activation.
  Restart the Gateway, then choose the saved sign-in in Model Setup to verify
  and activate it.

This protection applies to credentials owned by OpenClaw. Native external CLI
sign-in can change the external account immediately; OpenClaw does not represent
that external account change as an inactive replacement.

Pending credentials use separate reserved payload rows in the existing auth
database tables. They are never stored as active credentials with a flag that
older readers could ignore. See [Database schemas](/reference/database-schemas#pending-setup-credentials).

## Agent copy portability

Agent auth inheritance is read-through. When an agent has no local profile, it resolves profiles from the shared auth store at runtime without copying secret material into its own credential store (`agents/<agentId>/agent/openclaw-agent.sqlite`). The shared store lives in `state/openclaw.sqlite` after `openclaw doctor --fix` performs the one-time relocation. Until then, doctor reports the legacy `agents/main/agent/openclaw-agent.sqlite` owner and leaves that agent undeletable.

Explicit copy flows, such as `openclaw agents add`, use this portability policy:

- `api_key` and `token` profiles are portable unless `copyToAgents: false`.
- `oauth` profiles are not portable by default because refresh tokens can be single-use or rotation-sensitive.
- Provider-owned OAuth flows may opt in with `copyToAgents: true` only when copying refresh material across agents is known safe; the opt-in only applies when the profile carries inline access/refresh material.

Non-portable profiles remain available through the shared read-through base unless the target agent signs in separately and creates its own local profile.

`openclaw agent exec` preserves the original shared-store root when switching to temporary run state. Its bounded credential scope reads portable `api_key` and `token` profiles from that shared store without persisting copies; the configured agent's local profiles still win. Shared OAuth profiles are excluded from this temporary scope, even with `copyToAgents: true`, so the run does not acquire another refresh owner. `--auth-env-only` disables stored credential access entirely.

Auth writes that explicitly select a state directory, including isolated QA staging, use that directory's shared store for ownership and OAuth deduplication. Their runtime publication and rollback retain the same owner; another process-local state root is not an inherited base. An unrelated outer database may be older, newer, or unreadable without blocking an isolated write, but an unreadable or newer database in the selected target still fails closed. Writes without an explicit state directory retain the normal ambient state and agent-directory configuration.

## Config-only auth routes

`auth.profiles` entries with `mode: "aws-sdk"` are routing metadata, not stored credentials. They are valid when the target provider uses `models.providers.<id>.auth: "aws-sdk"`, the route the plugin-owned Amazon Bedrock setup writes. These profile ids may appear in `auth.order` and session overrides even when no matching entry exists in the credential store.

Do not write `type: "aws-sdk"` into the credential store; stored credentials are only `api_key`, `token`, or `oauth`. If a legacy `auth-profiles.json` has such a marker, `openclaw doctor --fix` moves it to `auth.profiles` and removes the marker from the store.

## Explicit auth order filtering

- When `auth.order.<provider>` or the auth-store order override is set for a provider, `models status --probe` only probes profile ids that remain in the resolved auth order for that provider. The stored override wins over `auth.order` config.
- A stored profile for that provider that is omitted from the explicit order is not silently tried later. Probe output reports it with `reasonCode: excluded_by_auth_order` and the detail `Excluded by auth.order for this provider.`
- A valid session user pin is an explicit per-session exception: OpenClaw tries that profile first even when it is omitted from the provider order, then uses the ordered same-provider profiles as retry candidates. A cooldown or disabled window applies only to the affected profile; it does not suppress its eligible siblings.

## Probe target resolution

- Probe targets can come from auth profiles, environment credentials, or `models.json` (result `source`: `profile`, `env`, `models.json`).
- If a provider has credentials but OpenClaw cannot resolve a probeable model candidate for it, `models status --probe` reports `status: no_model` with `reasonCode: no_model`.

## External CLI credential discovery

- Runtime-only credentials owned by external CLIs (Claude CLI for `claude-cli`, Codex CLI for `openai`, MiniMax CLI for `minimax-portal`) are discovered only when the provider, runtime, or auth profile is in scope for the current operation, or when a stored local profile for that external source already exists.
- Auth-store callers choose an explicit external-CLI discovery mode: `none` for persisted/plugin auth only, `existing` for refreshing already stored external CLI profiles, or `scoped` for a concrete provider/profile set.
- Read-only/status paths pass `allowKeychainPrompt: false`; they use file-backed external CLI credentials only and do not read or reuse macOS Keychain results.
- `/models` reuses external login evidence already prepared with its catalog, so those providers remain visible without a second OpenClaw login. Opening the default menu does not repeat external CLI discovery; explicit auth order and route compatibility still apply.

## OAuth SecretRef Policy Guard

SecretRef input is for static credentials only. OAuth credentials are runtime-mutable (refresh flows persist rotated tokens), so SecretRef-backed OAuth material would split mutable state across stores.

- If a profile credential is `type: "oauth"`, SecretRef objects are rejected for any credential material field on that profile.
- If `auth.profiles.<id>.mode` is `"oauth"`, SecretRef-backed `keyRef`/`tokenRef` input for that profile is rejected.
- Violations are hard failures (thrown errors) in startup/reload secret preparation and profile resolution paths.

## Legacy-Compatible Messaging

For script compatibility, probe errors keep this first line unchanged:

`Auth profile credentials are missing or expired.`

Human-friendly detail and the stable reason code follow on subsequent lines in the form `↳ Auth reason [code]: ...`.

## Related

- [Secrets management](/gateway/secrets)
- [Auth storage](/concepts/oauth)
