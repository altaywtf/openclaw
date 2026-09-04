import { afterEach, describe, expect, it, vi } from "vitest";
import * as authProfiles from "../agents/auth-profiles/store.js";
import type { PreparedStatusModelFacts } from "../agents/model-auth-label.js";
import * as modelAuth from "../agents/model-auth.js";
import * as providerUsage from "../infra/provider-usage.js";
import { buildStatusMessageParts } from "./status-message.js";
import { buildStatusText } from "./status-text.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function renderStatus(overrides: Partial<Parameters<typeof buildStatusText>[0]> = {}) {
  return buildStatusText({
    cfg: {},
    sessionKey: "agent:main:main",
    statusChannel: "webchat",
    provider: "demo",
    model: "selected",
    resolvedHarness: "openclaw",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => "off",
    isGroup: false,
    defaultGroupActivation: () => "mention",
    skipDefaultTaskLookup: true,
    taskLineOverride: "",
    pluginHealthLineOverride: "",
    includeTranscriptUsage: false,
    ...overrides,
  });
}

describe("status auth formatting", () => {
  const facts: PreparedStatusModelFacts = {
    selected: {
      provider: "demo",
      model: "selected",
      label: "demo/selected",
      auth: { kind: "unknown" },
    },
    active: {
      provider: "other",
      model: "active",
      label: "other/active",
      auth: {
        kind: "prepared",
        evaluation: {
          availability: true,
          routeResolution: null,
          selectedAuthMode: "api_key",
          selectedProfileId: "other:work",
        },
      },
    },
    activeDiffers: true,
  };

  it("does not discover provider credentials when exact model auth is unknown", () => {
    const discoverAuth = vi.spyOn(modelAuth, "resolveModelAuthMode").mockReturnValue("api-key");

    const reply = buildStatusMessageParts({
      agent: { model: { primary: "demo/absent" } },
      config: {},
      modelAuth: undefined,
      activeModelAuth: undefined,
      includeTranscriptUsage: false,
    });

    expect(reply.text).not.toContain("🔑 Auth:");
    expect(discoverAuth).not.toHaveBeenCalled();
  });

  it("keeps explicitly supplied legacy auth labels without discovering credentials", () => {
    const discoverAuth = vi.spyOn(modelAuth, "resolveModelAuthMode").mockReturnValue("api-key");

    const reply = buildStatusMessageParts({
      agent: { model: { primary: "demo/chat" } },
      modelAuth: "oauth (demo:work)",
      activeModelAuth: "oauth (demo:work)",
      includeTranscriptUsage: false,
    });

    expect(reply.text).toContain("🔑 Auth: oauth (demo:work)");
    expect(discoverAuth).not.toHaveBeenCalled();
  });

  it("does not borrow active credentials to fill unknown selected auth", async () => {
    const discoverAuth = vi.spyOn(modelAuth, "resolveModelAuthMode").mockReturnValue("oauth");
    const text = await renderStatus({ modelAuthFacts: facts });

    expect(text).toContain("Model: demo/selected");
    expect(text).not.toContain("🔑 Auth:");
    expect(discoverAuth).not.toHaveBeenCalled();
  });

  it("renders captured auth instead of fresh provider-wide modes", () => {
    const discoverAuth = vi.spyOn(modelAuth, "resolveModelAuthMode").mockReturnValue("api-key");
    const reply = buildStatusMessageParts({
      agent: { model: { primary: "demo/stale" } },
      modelAuthFacts: {
        ...facts,
        selected: {
          ...facts.selected,
          auth: {
            kind: "prepared",
            evaluation: {
              availability: false,
              routeResolution: null,
              unavailableReason: "auth-failed",
              selectedAuthMode: "oauth",
            },
          },
        },
      },
      includeTranscriptUsage: false,
    });

    expect(reply.text).toContain("Model: demo/selected");
    expect(reply.text).toContain("🔑 Auth: unavailable (auth-failed)");
    expect(discoverAuth).not.toHaveBeenCalled();
  });

  it.each([
    { displayOverride: undefined, availability: true, lockedProfileId: undefined },
    {
      displayOverride: { label: "custom account" },
      availability: false,
      lockedProfileId: "openai:selected",
    },
  ])(
    "forwards the prepared usage profile with display override %j without reading credentials",
    async ({ displayOverride, availability, lockedProfileId }) => {
      const readAuth = vi.spyOn(authProfiles, "ensureAuthProfileStore").mockImplementation(() => {
        throw new Error("formatter must not read credentials");
      });
      const loadUsage = vi
        .spyOn(providerUsage, "loadProviderUsageSummary")
        .mockResolvedValue({ updatedAt: 1, providers: [] });
      const selected: PreparedStatusModelFacts["selected"] = {
        provider: "openai",
        model: "gpt-5.4",
        label: "openai/gpt-5.4",
        runtime: { id: "codex", source: "auth" },
        auth: {
          kind: "prepared",
          ...(displayOverride ? { displayOverride } : {}),
          evaluation: {
            availability,
            routeResolution: null,
            selectedAuthMode: "oauth",
            selectedProfileId: "openai:selected",
          },
        },
      };

      const text = await renderStatus({
        provider: "openai",
        model: "gpt-5.4",
        modelAuthFacts: { selected, active: selected, activeDiffers: false, lockedProfileId },
        resolvedHarness: "codex",
      });

      expect(loadUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          providers: ["openai"],
          auth: [expect.objectContaining({ authProfileId: "openai:selected" })],
        }),
      );
      expect(readAuth).not.toHaveBeenCalled();
      if (displayOverride) {
        expect(text).toContain(`Auth: ${displayOverride.label}`);
      }
    },
  );

  it("keeps provider compatibility for legacy runtime overrides without auth facts", async () => {
    const text = await renderStatus({
      resolvedHarness: undefined,
      sessionEntry: { sessionId: "legacy", updatedAt: 1, agentRuntimeOverride: "codex" },
    });

    expect(text).toContain("Runtime: OpenClaw Default");
    expect(text).not.toContain("Runtime: OpenAI Codex");
  });

  it("does not query a different account when a provided label has an unresolved profile lock", async () => {
    const loadUsage = vi
      .spyOn(providerUsage, "loadProviderUsageSummary")
      .mockResolvedValue({ updatedAt: 1, providers: [] });
    const selected: PreparedStatusModelFacts["selected"] = {
      provider: "openai",
      model: "absent",
      label: "openai/absent",
      auth: { kind: "provided", label: "oauth (requested account)" },
      runtime: { id: "codex", source: "session" },
    };

    await renderStatus({
      provider: "openai",
      model: "absent",
      resolvedHarness: "codex",
      modelAuthFacts: {
        selected,
        active: selected,
        activeDiffers: false,
        lockedProfileId: "openai:requested",
      },
    });

    expect(loadUsage).not.toHaveBeenCalled();
  });
});
