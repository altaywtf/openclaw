import { beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn, spawnSync }));

import provider from "../../provider-discovery.js";

function result(status: string, code = 0) {
  return {
    error: undefined,
    status: code,
    stdout: status,
    stderr: "",
  };
}

describe("Codex native login discovery", () => {
  beforeEach(() => {
    spawnSync.mockReset();
  });

  it.each([
    ["Logged in using ChatGPT", "oauth"],
    ["Logged in using an API key - ***", "api-key"],
    ["Logged in using personal access token", "token"],
  ])("accepts Codex status %s", (status, mode) => {
    spawnSync.mockReturnValue(result(status));

    expect(provider.resolveSyntheticAuth?.({ provider: "openai" })).toEqual({
      apiKey: "codex-app-server",
      source: "Codex CLI native auth",
      mode,
      runtime: "codex",
    });
    expect(spawnSync).toHaveBeenCalledWith(
      "codex",
      ["login", "status"],
      expect.objectContaining({ timeout: 3_000 }),
    );
  });

  it("reflects standalone Codex login and logout without caching", () => {
    spawnSync.mockReturnValue(result("Not logged in", 1));
    expect(provider.resolveSyntheticAuth?.({ provider: "codex" })).toBeUndefined();

    spawnSync.mockReturnValue(result("Logged in using ChatGPT"));
    expect(provider.resolveSyntheticAuth?.({ provider: "codex" })).toMatchObject({
      mode: "oauth",
      runtime: "codex",
    });

    spawnSync.mockReturnValue(result("Not logged in", 1));
    expect(provider.resolveSyntheticAuth?.({ provider: "codex" })).toBeUndefined();
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it("does not inspect native login for an unrelated provider", () => {
    expect(provider.resolveSyntheticAuth?.({ provider: "other" })).toBeUndefined();
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
