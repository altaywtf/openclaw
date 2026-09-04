// @vitest-environment node
// Control UI tests cover chat model select state behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  createModelCatalog,
  createSessionsListResult,
  DEEPSEEK_CHAT_MODEL,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "../../test-helpers/chat-model.ts";
import {
  resolveChatModelUnavailableReason,
  resolveChatFastModeSelectState,
  resolveChatModelOverrideValue,
  resolveChatModelSelectState,
} from "./model-select-state.ts";

type ChatModelStateInput = Parameters<typeof resolveChatModelSelectState>[0];

function createChatModelState(
  params: Partial<Omit<ChatModelStateInput, "sessionKey">> = {},
): ChatModelStateInput {
  const sessionsResult =
    params.sessionsResult ?? createSessionsListResult({ model: null, modelProvider: null });
  return {
    activeSession: params.activeSession ?? sessionsResult.sessions[0],
    sessionKey: "main",
    modelOverrides: {},
    chatModelCatalog: [],
    sessionsResult,
    ...params,
  };
}

function resolveFastModeState(params: {
  provider: string;
  supportsFastMode?: boolean;
  fastMode?: boolean | "auto";
  effectiveFastMode?: boolean | "auto";
}) {
  const sessionsResult = createSessionsListResult({
    model: "model",
    modelProvider: params.provider,
  });
  const session = expectDefined(sessionsResult.sessions[0], "fast-mode session fixture");
  sessionsResult.sessions[0] = {
    ...session,
    ...(params.fastMode === undefined ? {} : { fastMode: params.fastMode }),
    ...(params.effectiveFastMode === undefined
      ? {}
      : { effectiveFastMode: params.effectiveFastMode }),
  };
  return resolveChatFastModeSelectState({
    activeRunId: null,
    catalog: [
      {
        id: "model",
        name: "Model",
        provider: params.provider,
        supportsFastMode: params.supportsFastMode,
      },
    ],
    connected: true,
    currentModelOverride: `${params.provider}/model`,
    fastModeTarget: sessionsResult.sessions[0],
    gatewayAvailable: true,
    loading: false,
    sending: false,
    sessionsResult,
    stream: null,
  });
}

describe("chat-model-select-state", () => {
  it("does not infer fast-mode support from a provider name without capability metadata", () => {
    expect(resolveFastModeState({ provider: "anthropic" })).toMatchObject({
      supported: false,
      disabled: true,
    });
  });

  it.each([
    { reason: "missing-auth", expected: "missing-auth" },
    { reason: "auth-failed", expected: "auth-failed" },
    { reason: "cooldown", expected: "cooldown" },
    { reason: undefined, expected: undefined },
  ] as const)("preserves the recorded $reason availability reason", ({ reason, expected }) => {
    const catalog = [
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        available: false,
        unavailableReason: reason,
      },
    ];
    expect(resolveChatModelUnavailableReason("gpt-5.6-luna", "openai", catalog)).toBe(expected);
    expect(resolveChatModelUnavailableReason("other-model", "openai", catalog)).toBeUndefined();
  });

  it.each([
    { available: true, reason: undefined, expected: undefined },
    { available: undefined, reason: undefined, expected: undefined },
    { available: false, reason: undefined, expected: undefined },
    { available: false, reason: "cooldown", expected: "cooldown" },
    { available: false, reason: "missing-auth", expected: "missing-auth" },
  ] as const)(
    "does not let an auth-failed alias override a $reason/$available route",
    ({ available, reason, expected }) => {
      const catalog = [
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "codex",
          available: false,
          unavailableReason: "auth-failed" as const,
        },
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          available,
          unavailableReason: reason,
        },
      ];
      expect(resolveChatModelUnavailableReason("gpt-5.6-luna", "openai", catalog)).toBe(expected);
      expect(resolveChatModelUnavailableReason("gpt-5.6-luna", "codex", catalog)).toBe(
        "auth-failed",
      );
    },
  );

  it("toggles between Standard and Fast for OpenAI models", () => {
    expect(resolveFastModeState({ provider: "openai", supportsFastMode: true })).toMatchObject({
      active: false,
      currentOverride: "",
      label: "Default",
      nextValue: "on",
      supported: true,
    });
    expect(
      resolveFastModeState({ provider: "openai", supportsFastMode: true, fastMode: true }),
    ).toMatchObject({
      active: true,
      currentOverride: "on",
      label: "Fast",
      nextValue: "off",
    });
    expect(
      resolveFastModeState({ provider: "openai", supportsFastMode: true, effectiveFastMode: true }),
    ).toMatchObject({
      active: true,
      currentOverride: "",
    });
    expect(
      resolveFastModeState({ provider: "openai", supportsFastMode: true, fastMode: "auto" }),
    ).toMatchObject({
      active: true,
      currentOverride: "auto",
      label: "Auto",
      nextValue: "off",
    });
  });

  it("toggles between the inherited default and Fast for other fast-mode providers", () => {
    expect(resolveFastModeState({ provider: "anthropic", supportsFastMode: true })).toMatchObject({
      active: false,
      currentOverride: "",
      label: "Default",
      nextValue: "on",
      supported: true,
    });
    // Turning fast off always writes an explicit off override: the inherited
    // baseline is unknowable while an override exists, and clearing could
    // land on a fast default, turning the click into a visible no-op.
    expect(
      resolveFastModeState({ provider: "anthropic", supportsFastMode: true, fastMode: true }),
    ).toMatchObject({
      active: true,
      label: "Fast",
      nextValue: "off",
    });
    expect(
      resolveFastModeState({
        provider: "anthropic",
        supportsFastMode: true,
        effectiveFastMode: true,
      }),
    ).toMatchObject({
      active: true,
      currentOverride: "",
      nextValue: "off",
    });
    expect(
      resolveFastModeState({ provider: "anthropic", supportsFastMode: true, fastMode: false }),
    ).toMatchObject({
      active: false,
      currentOverride: "off",
      label: "Standard",
      nextValue: "on",
    });
    expect(
      resolveFastModeState({ provider: "anthropic", supportsFastMode: true, fastMode: "auto" }),
    ).toMatchObject({
      active: true,
      currentOverride: "auto",
      label: "Auto",
      nextValue: "off",
    });
  });

  it("finds the active row across the legacy main alias window", () => {
    // Pre-hello (or legacy-alias) states select "main" while the row list
    // already carries the canonical agent:main:main key; a strict compare
    // missed the row and the picker fell back to the agent default.
    const sessionsResult = createSessionsListResult({
      model: "gpt-5.3-codex",
      modelProvider: "openai",
    });
    const session = expectDefined(sessionsResult.sessions[0], "alias fixture row");
    sessionsResult.sessions[0] = { ...session, key: "agent:main:main" };
    const value = resolveChatModelOverrideValue(
      createChatModelState({
        chatModelCatalog: DEFAULT_CHAT_MODEL_CATALOG,
        sessionsResult,
      }),
    );
    expect(value).toBe("openai/gpt-5.3-codex");
  });

  it("uses the server-qualified value when the active session provider is present", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(DEEPSEEK_CHAT_MODEL),
      sessionsResult: createSessionsListResult({
        model: "deepseek-chat",
        modelProvider: "deepseek",
      }),
    });

    expect(resolveChatModelOverrideValue(state)).toBe("deepseek/deepseek-chat");
  });

  it("falls back to the server-qualified value when catalog lookup fails", () => {
    const state = createChatModelState({
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
      }),
    });

    expect(resolveChatModelOverrideValue(state)).toBe("openai/gpt-5-mini");
  });

  it("preserves cached bare overrides without choosing a provider", () => {
    const state = createChatModelState({
      modelOverrides: { main: "gpt-5-mini" },
      chatModelCatalog: createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("gpt-5-mini");
    expect(resolved.options).toEqual([
      { value: "openai/gpt-5", label: "GPT-5" },
      { value: "openai/gpt-5-mini", label: "GPT-5 Mini" },
    ]);
  });

  it("preserves the session provider when another catalog provider has the same model", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(DEEPSEEK_CHAT_MODEL),
      sessionsResult: createSessionsListResult({
        model: "deepseek-chat",
        modelProvider: "zai",
      }),
    });

    expect(resolveChatModelSelectState(state).currentOverride).toBe("zai/deepseek-chat");
  });

  it("keeps the active model value but does not synthesize a picker option when the catalog is empty", () => {
    const state = createChatModelState({
      sessionsResult: createSessionsListResult({
        model: "openai/gpt-5-mini",
        modelProvider: "zai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("zai/openai/gpt-5-mini");
    expect(resolved.options).toEqual([]);
  });

  it("does not synthesize configured models outside catalog results", () => {
    const state = createChatModelState({
      sessionsResult: createSessionsListResult({
        model: "openai/gpt-5-mini",
        modelProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options).toEqual([]);
  });

  it("builds picker options without introducing a bare duplicate", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG),
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options).toEqual([
      { value: "openai/gpt-5", label: "GPT-5" },
      { value: "openai/gpt-5-mini", label: "GPT-5 Mini" },
    ]);
  });

  it("keeps configured unavailable catalog entries visible but disabled", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          available: true,
        },
        {
          id: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          provider: "codex",
          available: false,
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "gpt-5.5",
        modelProvider: "openai",
        defaultsModel: "gpt-5.5",
        defaultsProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.options).toEqual([
      { value: "openai/gpt-5.5", label: "GPT-5.5" },
      {
        value: "codex/gpt-5.3-codex-spark",
        label: "GPT-5.3 Codex Spark",
        disabled: true,
      },
    ]);
  });

  it.each([
    {
      name: "available",
      available: true,
      options: [
        { value: "openai/gpt-5.5", label: "GPT-5.5 · openai" },
        { value: "codex/gpt-5.5", label: "GPT-5.5 · codex", disabled: true },
      ],
    },
    {
      name: "indeterminate",
      available: undefined,
      options: [
        { value: "openai/gpt-5.5", label: "GPT-5.5 · openai" },
        { value: "codex/gpt-5.5", label: "GPT-5.5 · codex", disabled: true },
      ],
    },
    {
      name: "all-cold",
      available: false,
      options: [
        { value: "openai/gpt-5.5", label: "GPT-5.5 · openai", disabled: true },
        { value: "codex/gpt-5.5", label: "GPT-5.5 · codex", disabled: true },
      ],
    },
  ])(
    "preserves $name route labels and options beside a cold legacy alias",
    ({ available, options }) => {
      const state = createChatModelState({
        chatModelCatalog: createModelCatalog(
          {
            id: "gpt-5.5",
            name: "GPT-5.5",
            provider: "openai",
            available,
          },
          {
            id: "gpt-5.5",
            name: "GPT-5.5",
            provider: "codex",
            available: false,
          },
        ),
        sessionsResult: createSessionsListResult({
          model: "gpt-5.5",
          modelProvider: "codex",
          defaultsModel: "gpt-5.5",
          defaultsProvider: "codex",
        }),
      });

      const resolved = resolveChatModelSelectState(state);
      expect(resolved.currentOverride).toBe("codex/gpt-5.5");
      expect(resolved.defaultModel).toBe("codex/gpt-5.5");
      expect(resolved.options).toEqual(options);
    },
  );

  it("preserves an exact available OpenAI route when a legacy route is also available", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          provider: "codex",
          available: true,
        },
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          available: true,
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "gpt-5.5",
        modelProvider: "openai",
        defaultsModel: "gpt-5.5",
        defaultsProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5.5");
    expect(resolved.defaultModel).toBe("openai/gpt-5.5");
  });

  it("keeps an all-cold default identity visible as a disabled option", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          available: false,
          unavailableReason: "missing-auth",
        },
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          available: false,
          unavailableReason: "missing-auth",
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        defaultsModel: "gpt-5.6-sol",
        defaultsProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.defaultLabel).toBe("Default (GPT-5.6 Sol)");
    expect(resolveChatModelUnavailableReason("gpt-5.6-sol", "openai", state.chatModelCatalog)).toBe(
      "missing-auth",
    );
    expect(resolved.options).toEqual([
      {
        value: "openai/gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        disabled: true,
        unavailableReason: "missing-auth",
      },
      {
        value: "openai/gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        disabled: true,
        unavailableReason: "missing-auth",
      },
    ]);
  });

  it.each([true, false, undefined])(
    "uses only the published fast capability %s for a canonical model",
    (supportsFastMode) => {
      expect(resolveFastModeState({ provider: "custom", supportsFastMode })).toMatchObject({
        supported: supportsFastMode === true,
        disabled: supportsFastMode !== true,
        nextValue: supportsFastMode === true ? "on" : "",
      });
    },
  );

  it.each([true, false, "auto"] as const)(
    "keeps a saved %s override clearable without advertising missing support",
    (fastMode) => {
      expect(resolveFastModeState({ provider: "custom", fastMode })).toMatchObject({
        supported: true,
        disabled: false,
        nextValue: "",
      });
    },
  );

  it("does not use another provider or runtime to fill a missing fast capability", () => {
    const sessionsResult = createSessionsListResult({ model: "model", modelProvider: "custom" });
    const input = {
      activeRunId: null,
      catalog: [
        {
          id: "model",
          name: "Model",
          provider: "openai",
          supportsFastMode: true,
          agentRuntime: { id: "openclaw", source: "model" as const },
        },
      ],
      connected: true,
      currentModelOverride: "custom/model",
      fastModeTarget: sessionsResult.sessions[0],
      gatewayAvailable: true,
      loading: false,
      sending: false,
      sessionsResult,
      stream: null,
    };
    expect(resolveChatFastModeSelectState(input).supported).toBe(false);
    expect(
      resolveChatFastModeSelectState({
        ...input,
        currentModelOverride: "openai/model",
        fastModeTarget: {
          model: "model",
          modelProvider: "openai",
          agentRuntime: { id: "other-runtime", source: "model" },
        },
      }).supported,
    ).toBe(false);
  });

  it("uses catalog names for the default label and matching picker options", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog({
        id: "moonshotai/kimi-k2.5",
        alias: "Kimi K2.5 (NVIDIA)",
        name: "Kimi K2.5 (NVIDIA)",
        provider: "nvidia",
      }),
      sessionsResult: createSessionsListResult({
        model: "moonshotai/kimi-k2.5",
        modelProvider: "nvidia",
        defaultsModel: "moonshotai/kimi-k2.5",
        defaultsProvider: "nvidia",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("nvidia/moonshotai/kimi-k2.5");
    expect(resolved.defaultLabel).toBe("Default (Kimi K2.5 (NVIDIA))");
    expect(resolved.options).toEqual([
      {
        value: "nvidia/moonshotai/kimi-k2.5",
        label: "Kimi K2.5 (NVIDIA)",
      },
    ]);
  });

  it("keeps versioned catalog names visible for configured family aliases", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "claude-opus-4-8",
          alias: "opus",
          name: "Opus 4.8",
          provider: "anthropic",
        },
        {
          id: "claude-sonnet-5",
          alias: "sonnet",
          name: "Sonnet 5",
          provider: "anthropic",
        },
        {
          id: "moonshotai/kimi-k2.5",
          alias: "Kimi K2.5 (NVIDIA)",
          name: "Kimi K2.5",
          provider: "nvidia",
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "claude-opus-4-8",
        modelProvider: "anthropic",
        defaultsModel: "claude-opus-4-8",
        defaultsProvider: "anthropic",
      }),
    });

    const resolved = resolveChatModelSelectState(state);

    expect(resolved.defaultLabel).toBe("Default (Opus 4.8 · opus)");
    expect(resolved.options).toEqual([
      { value: "anthropic/claude-opus-4-8", label: "Opus 4.8 · opus" },
      { value: "anthropic/claude-sonnet-5", label: "Sonnet 5 · sonnet" },
      {
        value: "nvidia/moonshotai/kimi-k2.5",
        label: "Kimi K2.5 (NVIDIA)",
      },
    ]);
  });

  it("uses the active agent model for the default label", () => {
    const state = createChatModelState({
      agentDefaultModel: "anthropic/claude-opus-4-5",
      chatModelCatalog: createModelCatalog(
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
        },
        {
          id: "claude-opus-4-5",
          name: "Claude Opus 4.5",
          provider: "anthropic",
        },
      ),
      sessionsResult: createSessionsListResult({
        defaultsModel: "gpt-5.5",
        defaultsProvider: "openai",
        model: "claude-opus-4-5",
        modelProvider: "anthropic",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.defaultModel).toBe("anthropic/claude-opus-4-5");
    expect(resolved.defaultLabel).toBe("Default (Claude Opus 4.5)");
  });

  it("keeps a canonical agent default as one named picker option", () => {
    const state = createChatModelState({
      agentDefaultModel: "openai/gpt-5.6-sol",
      chatModelCatalog: createModelCatalog({
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);

    expect(resolved.defaultLabel).toBe("Default (GPT-5.6 Sol)");
    expect(resolved.options).toEqual([{ value: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol" }]);
  });

  // The session model equals the agent default in every case, so anything other than
  // the recorded marker would have to guess — and would always guess "inherited".
  it.each([
    { name: "inherited default", source: null, expected: null },
    { name: "user pin the default grew into", source: "user" as const, expected: "user" },
    { name: "automatic fallback", source: "auto" as const, expected: "auto" },
  ])("resolves $expected from provenance for $name", ({ source, expected }) => {
    const state = createChatModelState({
      agentDefaultModel: "openai/gpt-5.6-sol",
      chatModelCatalog: createModelCatalog({
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai",
      }),
      sessionsResult: createSessionsListResult({
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        modelOverrideSource: source,
        defaultsModel: "gpt-5.6-sol",
        defaultsProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5.6-sol");
    expect(resolved.modelOverrideSource).toBe(expected);
  });

  it("reads pin provenance from a canonical main row when the route uses the alias key", () => {
    const state = createChatModelState({
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
        modelOverrideSource: "user",
      }),
    });
    // Route key stays the `main` alias while the Gateway reports the canonical row.
    expectDefined(state.sessionsResult?.sessions[0], "main session row").key = "agent:main:main";

    const resolved = resolveChatModelSelectState(state);

    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.modelOverrideSource).toBe("user");
  });

  // `currentOverride` already lets a pending local selection outrank the row, so
  // provenance has to follow it — otherwise the picker would report a model and an
  // origin belonging to two different points in time.
  it("keeps provenance and the effective model on the same in-flight selection", () => {
    const pendingPin = createChatModelState({
      modelOverrides: { main: "openai/gpt-5-mini" },
      sessionsResult: createSessionsListResult({
        model: "gpt-5",
        modelProvider: "openai",
        modelOverrideSource: null,
      }),
    });

    expect(resolveChatModelSelectState(pendingPin).currentOverride).toBe("openai/gpt-5-mini");
    expect(resolveChatModelSelectState(pendingPin).modelOverrideSource).toBe("user");

    const pendingReset = {
      ...pendingPin,
      modelOverrides: { main: null },
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
        modelOverrideSource: "user" as const,
      }),
    };

    expect(resolveChatModelSelectState(pendingReset).currentOverride).toBe("");
    expect(resolveChatModelSelectState(pendingReset).modelOverrideSource).toBeNull();
  });

  it("disambiguates duplicate friendly names in picker options and default labels", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "claude-3-7-sonnet",
          name: "Claude Sonnet",
          provider: "anthropic",
        },
        {
          id: "claude-3-7-sonnet",
          name: "Claude Sonnet",
          provider: "openrouter",
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "claude-3-7-sonnet",
        modelProvider: "anthropic",
        defaultsModel: "claude-3-7-sonnet",
        defaultsProvider: "openrouter",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("anthropic/claude-3-7-sonnet");
    expect(resolved.defaultLabel).toBe("Default (Claude Sonnet · openrouter)");
    expect(resolved.options).toEqual([
      {
        value: "anthropic/claude-3-7-sonnet",
        label: "Claude Sonnet · anthropic",
      },
      {
        value: "openrouter/claude-3-7-sonnet",
        label: "Claude Sonnet · openrouter",
      },
    ]);
  });

  it("falls back to id and provider when duplicate names share the same provider", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "claude-3-7-sonnet",
          name: "Claude Sonnet",
          provider: "anthropic",
        },
        {
          id: "claude-3-7-sonnet-thinking",
          name: "Claude Sonnet",
          provider: "anthropic",
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "claude-3-7-sonnet",
        modelProvider: "anthropic",
        defaultsModel: "claude-3-7-sonnet-thinking",
        defaultsProvider: "anthropic",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("anthropic/claude-3-7-sonnet");
    expect(resolved.defaultLabel).toBe(
      "Default (Claude Sonnet · claude-3-7-sonnet-thinking · anthropic)",
    );
    expect(resolved.options).toEqual([
      {
        value: "anthropic/claude-3-7-sonnet",
        label: "Claude Sonnet · claude-3-7-sonnet · anthropic",
      },
      {
        value: "anthropic/claude-3-7-sonnet-thinking",
        label: "Claude Sonnet · claude-3-7-sonnet-thinking · anthropic",
      },
    ]);
  });
});
