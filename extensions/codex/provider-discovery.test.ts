import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveCodexNativeAuth = vi.hoisted(() => vi.fn());

vi.mock("./src/app-server/native-auth.js", () => ({ resolveCodexNativeAuth }));

import provider from "./provider-discovery.js";

const LOGGED_IN = {
  apiKey: "codex-app-server",
  source: "Codex CLI native auth",
  mode: "oauth",
} as const;

describe("Codex provider discovery", () => {
  let codexHome: string;

  beforeEach(() => {
    resolveCodexNativeAuth.mockReset();
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-discovery-"));
    vi.stubEnv("CODEX_HOME", codexHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  it("publishes the runtime-owned marker for an authenticated canonical provider", () => {
    resolveCodexNativeAuth.mockReturnValue(LOGGED_IN);

    expect(provider.resolveSyntheticAuth?.({ provider: "openai" })).toEqual({
      ...LOGGED_IN,
      runtime: "codex",
    });
    expect(provider.resolveSyntheticAuth?.({ provider: "codex" })).toEqual({
      ...LOGGED_IN,
      runtime: "codex",
    });
    expect(provider.resolveSyntheticAuth?.({ provider: "other" })).toBeUndefined();
    expect(resolveCodexNativeAuth).toHaveBeenCalledOnce();
  });

  it("re-probes only when the Codex auth file changes", () => {
    resolveCodexNativeAuth.mockReturnValue(undefined);
    expect(provider.resolveSyntheticAuth?.({ provider: "openai" })).toBeUndefined();
    // A logged-out probe is memoized like a positive one; re-probing would respawn
    // `codex login status` (3s timeout) on every synthetic-auth pass.
    expect(provider.resolveSyntheticAuth?.({ provider: "codex" })).toBeUndefined();
    expect(resolveCodexNativeAuth).toHaveBeenCalledOnce();

    // Login writes auth.json; the next pass must see it without a restart.
    resolveCodexNativeAuth.mockReturnValue(LOGGED_IN);
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}", "utf8");
    expect(provider.resolveSyntheticAuth?.({ provider: "openai" })).toMatchObject({
      mode: "oauth",
      runtime: "codex",
    });
    expect(resolveCodexNativeAuth).toHaveBeenCalledTimes(2);

    // Logout removes auth.json; the marker must disappear on the next pass.
    resolveCodexNativeAuth.mockReturnValue(undefined);
    fs.rmSync(path.join(codexHome, "auth.json"));
    expect(provider.resolveSyntheticAuth?.({ provider: "openai" })).toBeUndefined();
    expect(resolveCodexNativeAuth).toHaveBeenCalledTimes(3);
  });
});
