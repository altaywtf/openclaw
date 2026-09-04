import { describe, expect, it } from "vitest";
import { resolveFastModeCapability } from "./provider-policy-api.js";

describe("OpenAI fast-mode capability", () => {
  it.each([
    { overrides: {}, expected: true },
    { overrides: { api: "openai-completions" }, expected: false },
    { overrides: { baseUrl: "https://proxy.example/v1" }, expected: false },
    { overrides: { params: { serviceTier: "flex" } }, expected: false },
    { overrides: { params: { serviceTier: "invalid" } }, expected: true },
    { overrides: { agentRuntime: "codex" }, expected: true },
    { overrides: { agentRuntime: "codex", api: "openai-completions" }, expected: false },
    {
      overrides: { agentRuntime: "codex", requestTransportOverrides: "present" as const },
      expected: false,
    },
    {
      overrides: { agentRuntime: "codex", requestTransportOverrides: undefined },
      expected: undefined,
    },
    { overrides: { agentRuntime: undefined }, expected: undefined },
  ])(
    "publishes fast capability for the resolved transport $overrides",
    ({ overrides, expected }) => {
      expect(
        resolveFastModeCapability({
          provider: "openai",
          modelId: "gpt-5.4",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          agentRuntime: "openclaw",
          requestTransportOverrides: "none",
          ...overrides,
        }),
      ).toBe(expected);
    },
  );
});
