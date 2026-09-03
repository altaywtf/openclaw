/** Codex native-login discovery descriptor for static model and auth surfaces. */
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveCodexNativeAuth } from "./src/app-server/native-auth.js";

// Codex persists login state in `$CODEX_HOME/auth.json` (codex-rs/login/src/auth/storage.rs).
// Keying the probe memo on that file's identity re-probes exactly when a login or logout
// rewrites it, so auth refreshes see the new state without a Gateway restart, while a
// logged-out host does not re-spawn the 3s `codex login status` probe on every synthetic-auth
// pass. Env-only API-key logins are not observed through the file; a restart picks those up.
let probed: { key: string; auth: ReturnType<typeof resolveCodexNativeAuth> } | undefined;

function codexAuthFileKey(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const authFile = path.join(codexHome, "auth.json");
  try {
    const stats = statSync(authFile);
    return `${authFile}:${stats.mtimeMs}:${stats.size}`;
  } catch {
    return `${authFile}:absent`;
  }
}

function resolveCodexSyntheticAuth() {
  const key = codexAuthFileKey();
  if (probed?.key !== key) {
    probed = { key, auth: resolveCodexNativeAuth() };
  }
  return probed.auth ? { ...probed.auth, runtime: "codex" } : undefined;
}

const codexProviderDiscovery: ProviderPlugin = {
  id: "codex",
  aliases: ["openai"],
  label: "Codex",
  docsPath: "/providers/models",
  auth: [],
  resolveSyntheticAuth: ({ provider }) =>
    provider === "codex" || provider === "openai" ? resolveCodexSyntheticAuth() : undefined,
};

export default codexProviderDiscovery;
