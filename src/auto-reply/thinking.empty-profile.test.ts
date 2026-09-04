import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatThinkingLevels,
  isThinkingLevelSupported,
  listThinkingLevelOptions,
  resolveThinkingProfile,
} from "./thinking.js";

const providerRuntimeMocks = vi.hoisted(() => ({
  resolveProviderThinkingProfile: vi.fn(),
}));

vi.mock("../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: providerRuntimeMocks.resolveProviderThinkingProfile,
}));

beforeEach(() => {
  providerRuntimeMocks.resolveProviderThinkingProfile.mockReset();
});

describe("known-empty provider thinking profiles", () => {
  it.each([
    { reasoning: undefined, api: undefined },
    { reasoning: true, api: "anthropic-messages" },
  ])("preserves known-empty provider levels with catalog context %j", ({ reasoning, api }) => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [],
      defaultLevel: null,
    });
    const catalog = [
      {
        provider: "demo",
        id: "demo-model",
        api,
        reasoning,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        compat: { supportedReasoningEfforts: ["adaptive", "xhigh", "max", "ultra"] },
      },
    ];
    const params = { provider: "demo", model: "demo-model", catalog, agentRuntime: "openclaw" };

    expect(resolveThinkingProfile(params)).toEqual({ levels: [], defaultLevel: undefined });
    expect(listThinkingLevelOptions("demo", "demo-model", catalog, "openclaw")).toEqual([]);
    expect(formatThinkingLevels("demo", "demo-model", ", ", catalog, "openclaw")).toBe("");
    expect(isThinkingLevelSupported({ ...params, level: "off" })).toBe(false);
    expect(isThinkingLevelSupported({ ...params, level: "high" })).toBe(false);
  });

  it.each([
    { reasoning: false, configuredReasoning: undefined, preserve: false },
    { reasoning: false, configuredReasoning: undefined, preserve: true },
    { reasoning: true, configuredReasoning: false, preserve: false },
    { reasoning: true, configuredReasoning: false, preserve: true },
  ])(
    "keeps reasoning opt-out precedence for an empty profile: %j",
    ({ reasoning, configuredReasoning, preserve }) => {
      providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
        levels: [],
        preserveWhenCatalogReasoningFalse: preserve,
      });

      const profile = resolveThinkingProfile({
        provider: "demo",
        model: "demo-model",
        catalog: [{ provider: "demo", id: "demo-model", reasoning }],
        configuredReasoning,
      });

      expect(profile.levels.map(({ id }) => id)).toEqual(preserve ? [] : ["off"]);
      expect(profile.defaultLevel).toBe(preserve ? undefined : "off");
    },
  );
});
