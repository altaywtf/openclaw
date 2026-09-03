/** Codex native-login discovery descriptor for static model and auth surfaces. */
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveCodexNativeAuth } from "./src/app-server/native-auth.js";

const codexProviderDiscovery: ProviderPlugin = {
  id: "codex",
  aliases: ["openai"],
  label: "Codex",
  docsPath: "/providers/models",
  auth: [],
  // `codex login status` reads whichever credential store Codex is configured with (file,
  // keyring, or auto; codex-rs/login/src/auth/storage.rs), so OpenClaw cannot observe login
  // transitions itself. Every synthetic-auth pass asks Codex again (~30ms) rather than memoize a
  // state that would survive `models.authRefresh` after a login or logout.
  resolveSyntheticAuth: ({ provider }) => {
    if (provider !== "codex" && provider !== "openai") {
      return undefined;
    }
    const auth = resolveCodexNativeAuth();
    return auth ? { ...auth, runtime: "codex" } : undefined;
  },
};

export default codexProviderDiscovery;
