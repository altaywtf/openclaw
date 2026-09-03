import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveCodexNativeAuth = vi.hoisted(() => vi.fn());

vi.mock("./src/app-server/native-auth.js", () => ({ resolveCodexNativeAuth }));

import provider from "./provider-discovery.js";

const LOGGED_IN = {
  apiKey: "codex-app-server",
  source: "Codex CLI native auth",
  mode: "oauth",
} as const;

describe("Codex provider discovery", () => {
  beforeEach(() => {
    resolveCodexNativeAuth.mockReset();
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
    expect(resolveCodexNativeAuth).toHaveBeenCalledTimes(2);
  });

  it("reflects login and logout on the next pass without a restart", () => {
    resolveCodexNativeAuth.mockReturnValue(undefined);
    expect(provider.resolveSyntheticAuth?.({ provider: "openai" })).toBeUndefined();

    resolveCodexNativeAuth.mockReturnValue(LOGGED_IN);
    expect(provider.resolveSyntheticAuth?.({ provider: "openai" })).toMatchObject({
      mode: "oauth",
      runtime: "codex",
    });

    resolveCodexNativeAuth.mockReturnValue(undefined);
    expect(provider.resolveSyntheticAuth?.({ provider: "openai" })).toBeUndefined();
    expect(resolveCodexNativeAuth).toHaveBeenCalledTimes(3);
  });
});
