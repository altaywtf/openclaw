import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { stampConfigWriteMetadata } from "../config/io.meta.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  applyModelAllowlist,
  applyModelFallbacksFromSelection,
  promptDefaultModel,
  promptModelAllowlist,
} from "./model-picker.js";
import { makePrompter, makeRuntime } from "./setup/__tests__/test-utils.js";

const mocks = vi.hoisted(() => ({
  loadView: vi.fn(),
  providers: vi.fn<
    () => Array<{
      id: string;
      label?: string;
      auth?: unknown[];
      preserveLiteralProviderPrefix?: boolean;
    }>
  >(() => []),
  contributions: vi.fn<
    () => Array<{
      option: { value: string; label: string; hint?: string };
    }>
  >(() => []),
  resolveChoice: vi.fn(),
  runAuth: vi.fn(),
  selected: vi.fn(),
}));

vi.mock("../agents/model-catalog-view.js", () => ({
  loadPreparedModelCatalogView: mocks.loadView,
}));
vi.mock("./model-picker.runtime.js", () => ({
  modelPickerRuntime: {
    resolvePluginProviders: mocks.providers,
    resolveProviderModelPickerContributions: mocks.contributions,
    resolveProviderModelPickerEntries: () => [],
    resolveProviderPluginChoice: mocks.resolveChoice,
    runProviderPluginAuthMethod: mocks.runAuth,
    runProviderModelSelectedHook: mocks.selected,
  },
}));

const primary: ModelCatalogEntry = { provider: "fixture", id: "primary", name: "Primary" };
const secondary: ModelCatalogEntry = { provider: "fixture", id: "secondary", name: "Secondary" };
const pickerConfig: OpenClawConfig = { agents: { defaults: { model: "fixture/primary" } } };

function modelView(entries: ModelCatalogEntry[], source = entries) {
  return {
    entries,
    catalog: source,
    defaultModel: "fixture/primary",
    resolvedDefault: { provider: "fixture", model: "primary" },
    configuredEntries: { entries: [], byKey: new Map() },
    runtime: () => undefined,
    matchesProvider: (provider: string, requested: string) => provider === requested,
    evaluate: () => ({ availability: true, routeResolution: null }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadView.mockResolvedValue(modelView([primary, secondary]));
  mocks.providers.mockReturnValue([]);
  mocks.contributions.mockReturnValue([]);
});

describe("prepared picker presentation", () => {
  it.each(["unknown", "missing-auth", "auth-failed", "cooldown"] as const)(
    "does not suggest or preselect a model whose prepared auth is %s",
    async (reason) => {
      const blocked = { provider: "fixture", id: "blocked", name: "Blocked" };
      mocks.loadView.mockResolvedValue({
        ...modelView([blocked, primary]),
        evaluate: (entry: ModelCatalogEntry) => ({
          availability: entry.id === blocked.id ? (reason === "unknown" ? undefined : false) : true,
          routeResolution: null,
          unavailableReason: reason === "unknown" ? undefined : reason,
        }),
      });
      const select = vi.fn().mockResolvedValue("fixture/primary");
      await promptDefaultModel({
        config: pickerConfig,
        prompter: makePrompter({ select }),
        preferredProvider: "fixture",
        allowKeep: false,
        includeManual: false,
      });
      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          initialValue: "fixture/primary",
          options: [expect.objectContaining({ value: "fixture/primary" })],
        }),
      );
    },
  );

  it("filters a complete published catalog to the requested provider", async () => {
    mocks.loadView.mockResolvedValue(
      modelView([{ provider: "other", id: "model", name: "Other" }, primary]),
    );
    const select = vi.fn().mockResolvedValue("fixture/primary");
    await promptDefaultModel({
      config: pickerConfig,
      prompter: makePrompter({ select }),
      preferredProvider: "fixture",
      allowKeep: false,
      includeManual: false,
    });
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [expect.objectContaining({ value: "fixture/primary" })],
        initialValue: "fixture/primary",
      }),
    );
  });

  it("matches a requested provider through its declared alias", async () => {
    const { prepareModelCatalogView } = await vi.importActual<
      typeof import("../agents/model-catalog-view.js")
    >("../agents/model-catalog-view.js");
    const entry: ModelCatalogEntry = { provider: "custom", id: "model", name: "Model" };
    mocks.loadView.mockResolvedValue(
      await prepareModelCatalogView({
        cfg: {},
        agentId: "main",
        workspaceDir: "/tmp/picker-provider-alias",
        snapshot: { entries: [entry], routeVariants: [entry] },
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "custom",
              providers: ["custom"],
              providerAuthAliases: { "custom-alias": "custom" },
            },
          ],
        }),
        auth: {
          authStore: {
            version: 1,
            profiles: {
              "custom:primary": { provider: "custom", type: "api_key", key: "fixture-key" },
            },
          },
          providerAuth: {},
        },
        env: {},
        view: "all",
      }),
    );
    const select = vi.fn().mockResolvedValue("custom/model");

    await expect(
      promptDefaultModel({
        config: {},
        prompter: makePrompter({ select }),
        preferredProvider: "custom-alias",
        allowKeep: false,
        includeManual: false,
      }),
    ).resolves.toEqual({ model: "custom/model" });
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [expect.objectContaining({ value: "custom/model" })],
      }),
    );
  });

  it("preserves provider source order instead of display order", async () => {
    mocks.loadView.mockResolvedValue(modelView([primary, secondary], [secondary, primary]));
    const select = vi.fn().mockResolvedValue("fixture/secondary");
    await expect(
      promptDefaultModel({
        config: pickerConfig,
        prompter: makePrompter({ select }),
        preferredProvider: "fixture",
        allowKeep: false,
        includeManual: false,
      }),
    ).resolves.toEqual({ model: "fixture/secondary" });
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "fixture/secondary",
        options: [
          expect.objectContaining({ value: "fixture/secondary" }),
          expect.objectContaining({ value: "fixture/primary" }),
        ],
      }),
    );
  });

  it("renders the final alias, runtime, and capabilities from prepared facts", async () => {
    const entry = { ...primary, alias: "daily", contextWindow: 64000, reasoning: true };
    mocks.loadView.mockResolvedValue({
      ...modelView([entry]),
      runtime: () => ({ id: "fixture-native", source: "auth" }),
      configuredEntries: {
        entries: [],
        byKey: new Map([["fixture/primary", { aliases: ["legacy", "daily"] }]]),
      },
    });
    const select = vi.fn().mockResolvedValue("fixture/primary");
    await promptDefaultModel({
      config: pickerConfig,
      prompter: makePrompter({ select }),
      allowKeep: false,
      includeManual: false,
    });
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          expect.objectContaining({
            hint: "Primary · ctx 64k · reasoning · alias: daily · fixture-native runtime route",
          }),
        ],
      }),
    );
  });

  it("keeps a configured selection absent from the prepared view", async () => {
    mocks.loadView.mockResolvedValue(modelView([secondary]));
    const select = vi.fn().mockResolvedValue("fixture/primary");
    await promptDefaultModel({
      config: pickerConfig,
      prompter: makePrompter({ select }),
      allowKeep: false,
      includeManual: false,
    });
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          expect.objectContaining({ value: "fixture/secondary" }),
          expect.objectContaining({
            value: "fixture/primary",
            hint: expect.stringContaining("catalog"),
          }),
        ],
      }),
    );
  });

  it.each([false, true])(
    "keeps current without catalog discovery (on demand: %s)",
    async (browseCatalogOnDemand) => {
      const select = vi.fn().mockResolvedValue("__keep__");
      await expect(
        promptDefaultModel({
          config: pickerConfig,
          prompter: makePrompter({ select }),
          loadCatalog: browseCatalogOnDemand,
          browseCatalogOnDemand,
        }),
      ).resolves.toEqual({});
      expect(mocks.loadView).not.toHaveBeenCalled();
      expect(mocks.contributions).not.toHaveBeenCalled();
    },
  );

  it("reads the published catalog for the chosen agent after an explicit browse", async () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce("__browse__")
      .mockResolvedValueOnce("fixture/secondary");
    await expect(
      promptDefaultModel({
        config: pickerConfig,
        prompter: makePrompter({ select }),
        preferredProvider: "fixture",
        browseCatalogOnDemand: true,
        agentId: "research",
        agentDir: "/tmp/picker-research",
      }),
    ).resolves.toEqual({ model: "fixture/secondary" });
    expect(mocks.loadView).toHaveBeenCalledOnce();
    expect(mocks.loadView).toHaveBeenCalledWith(
      expect.objectContaining({
        config: pickerConfig,
        agentId: "research",
        agentDir: "/tmp/picker-research",
        readOnly: true,
      }),
    );
  });

  it("retains manual entry without reading a catalog", async () => {
    const select = vi.fn().mockResolvedValue("__manual__");
    const text = vi.fn().mockResolvedValue("custom/provider-native-model");
    await expect(
      promptDefaultModel({
        config: pickerConfig,
        prompter: makePrompter({ select, text }),
        loadCatalog: false,
      }),
    ).resolves.toEqual({ model: "custom/provider-native-model" });
    expect(mocks.loadView).not.toHaveBeenCalled();
  });

  it("offers manual entry when there are no prepared or configured choices", async () => {
    mocks.loadView.mockResolvedValue({ ...modelView([]), defaultModel: undefined });
    const text = vi.fn().mockResolvedValue("custom/new-model");
    await expect(
      promptDefaultModel({
        config: {},
        prompter: makePrompter({ text }),
        allowKeep: false,
        includeManual: false,
      }),
    ).resolves.toEqual({ model: "custom/new-model" });
  });

  it("routes explicit provider setup through its auth method", async () => {
    mocks.contributions.mockReturnValue([
      {
        option: { value: "provider-plugin:fixture:custom", label: "Fixture custom" },
      },
    ]);
    mocks.providers.mockReturnValue([{ id: "fixture", label: "Fixture", auth: [] }]);
    const method = { id: "custom", label: "Custom", kind: "custom" };
    mocks.resolveChoice.mockReturnValue({ method });
    mocks.runAuth.mockResolvedValue({ config: pickerConfig, defaultModel: "fixture/secondary" });
    const select = vi.fn().mockResolvedValue("provider-plugin:fixture:custom");
    await expect(
      promptDefaultModel({
        config: pickerConfig,
        prompter: makePrompter({ select }),
        includeProviderPluginSetups: true,
        agentDir: "/tmp/picker-agent",
        runtime: makeRuntime(),
      }),
    ).resolves.toEqual({ config: pickerConfig, model: "fixture/secondary" });
    expect(mocks.runAuth).toHaveBeenCalledWith(expect.objectContaining({ method }));
    expect(mocks.selected).toHaveBeenCalledWith(
      expect.objectContaining({ model: "fixture/secondary" }),
    );
  });

  it("keeps literal provider-prefixed display labels", async () => {
    const entry = { provider: "fixture", id: "fixture/native", name: "Native" };
    mocks.loadView.mockResolvedValue(modelView([entry]));
    mocks.providers.mockReturnValue([{ id: "fixture", preserveLiteralProviderPrefix: true }]);
    const select = vi.fn().mockResolvedValue("fixture/native");
    await promptDefaultModel({
      config: pickerConfig,
      prompter: makePrompter({ select }),
      allowKeep: false,
      includeManual: false,
    });
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({
            value: "fixture/native",
            label: "fixture/fixture/native",
          }),
        ]),
      }),
    );
  });
});

describe("prepared allowlist presentation", () => {
  it("keeps unavailable models editable without suggesting them as defaults", async () => {
    mocks.loadView.mockResolvedValue({
      ...modelView([secondary]),
      evaluate: () => ({
        availability: false,
        routeResolution: null,
        unavailableReason: "missing-auth",
      }),
    });
    const multiselect = vi.fn().mockResolvedValue(["fixture/secondary"]);
    await expect(
      promptModelAllowlist({
        config: pickerConfig,
        prompter: makePrompter({ multiselect }),
      }),
    ).resolves.toEqual({ models: ["fixture/secondary"] });
    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({
            value: "fixture/secondary",
            hint: expect.stringContaining("missing-auth"),
          }),
        ]),
      }),
    );
  });

  it("keeps a provider edit scoped when the owner publishes all providers", async () => {
    mocks.loadView.mockResolvedValue(
      modelView([{ provider: "other", id: "model", name: "Other" }, primary]),
    );
    const multiselect = vi.fn().mockResolvedValue(["fixture/primary"]);
    await expect(
      promptModelAllowlist({
        config: pickerConfig,
        prompter: makePrompter({ multiselect }),
        preferredProvider: "fixture",
      }),
    ).resolves.toEqual({ models: ["fixture/primary"], scopeKeys: ["fixture/primary"] });
    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [expect.objectContaining({ value: "fixture/primary" })],
      }),
    );
  });

  it("keeps a failed empty catalog in manual mode without inventing an allowlist", async () => {
    mocks.loadView.mockResolvedValue(modelView([]));
    const text = vi.fn().mockResolvedValue("");
    const multiselect = vi.fn();
    await expect(
      promptModelAllowlist({
        config: pickerConfig,
        prompter: makePrompter({ text, multiselect }),
      }),
    ).resolves.toEqual({});
    expect(text).toHaveBeenCalledWith(expect.objectContaining({ initialValue: "" }));
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("retains configured fallback seeds in manual mode", async () => {
    mocks.loadView.mockResolvedValue(modelView([]));
    const text = vi.fn().mockResolvedValue("fixture/primary, fixture/secondary");
    await expect(
      promptModelAllowlist({
        config: {
          agents: {
            defaults: {
              model: { primary: "fixture/primary", fallbacks: ["secondary"] },
              models: { "fixture/primary": {} },
            },
          },
        },
        prompter: makePrompter({ text }),
      }),
    ).resolves.toEqual({ models: ["fixture/primary", "fixture/secondary"] });
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "fixture/primary, fixture/secondary",
      }),
    );
  });

  it("retains explicit allowed keys and their scope without loading a catalog", async () => {
    const multiselect = vi.fn().mockResolvedValue(["fixture/missing"]);
    await expect(
      promptModelAllowlist({
        config: pickerConfig,
        prompter: makePrompter({ multiselect }),
        allowedKeys: ["fixture/primary", "fixture/missing"],
      }),
    ).resolves.toEqual({
      models: ["fixture/missing"],
      scopeKeys: ["fixture/primary", "fixture/missing"],
    });
    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          expect.objectContaining({ value: "fixture/primary" }),
          expect.objectContaining({ value: "fixture/missing" }),
        ],
      }),
    );
    expect(mocks.loadView).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "requires confirmation before clearing a scope (%s)",
    async (confirmClear) => {
      const confirm = vi.fn().mockResolvedValue(confirmClear);
      await expect(
        promptModelAllowlist({
          config: pickerConfig,
          prompter: makePrompter({ confirm }),
          allowedKeys: ["fixture/primary"],
          loadCatalog: false,
        }),
      ).resolves.toEqual(confirmClear ? { models: [], scopeKeys: ["fixture/primary"] } : {});
      expect(confirm).toHaveBeenCalledOnce();
    },
  );

  it("keeps configured missing models in the editable selection", async () => {
    const multiselect = vi.fn().mockResolvedValue(["fixture/missing"]);
    await promptModelAllowlist({
      config: {
        agents: { defaults: { model: "fixture/primary", models: { "fixture/missing": {} } } },
      },
      prompter: makePrompter({ multiselect }),
    });
    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([expect.objectContaining({ value: "fixture/missing" })]),
        initialValues: expect.arrayContaining(["fixture/missing"]),
      }),
    );
  });
});

describe("applyModelAllowlist", () => {
  it("preserves existing entries for selected models", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { alias: "gpt" },
            "anthropic/claude-opus-4-6": { alias: "opus" },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelAllowlist(config, ["openai/gpt-5.5"]);
    expect(next.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "gpt" },
      "anthropic/claude-opus-4-6": { alias: "opus" },
    });
    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual(["openai/gpt-5.5"]);
  });

  it("normalizes retired Google Gemini refs before writing selected models", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3.1-pro-preview": { alias: "gemini" },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelAllowlist(config, [
      "google/gemini-3-pro-preview",
      "google-gemini-cli/gemini-3-pro-preview",
      "openrouter/google/gemini-3-pro-preview",
    ]);
    expect(next.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": { alias: "gemini" },
      "google-gemini-cli/gemini-3.1-pro-preview": {},
      "openrouter/google/gemini-3.1-pro-preview": {},
    });
    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([
      "google/gemini-3.1-pro-preview",
      "google-gemini-cli/gemini-3.1-pro-preview",
      "openrouter/google/gemini-3.1-pro-preview",
    ]);
  });

  it("keeps non-Google provider Gemini-looking refs unchanged while writing selected models", () => {
    const config = {} as OpenClawConfig;

    const next = applyModelAllowlist(config, ["litellm/gemini-3-flash", "litellm/gemini-3.1-pro"]);
    expect(next.agents?.defaults?.models).toEqual({
      "litellm/gemini-3-flash": {},
      "litellm/gemini-3.1-pro": {},
    });
    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([
      "litellm/gemini-3-flash",
      "litellm/gemini-3.1-pro",
    ]);
  });

  it("preserves entries outside scoped allowlist updates", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { alias: "gpt" },
            "anthropic/claude-opus-4-6": { alias: "opus" },
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
          },
          modelPolicy: { allow: ["openai/*", "anthropic/*", "sonnet"] },
        },
      },
    } as OpenClawConfig;

    const next = applyModelAllowlist(config, ["anthropic/claude-sonnet-4-6"], {
      scopeKeys: ["anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-6"],
    });
    expect(next.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "gpt" },
      "anthropic/claude-opus-4-6": { alias: "opus" },
      "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
    });
    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([
      "openai/*",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("seeds provider-scoped configure edits from the effective legacy allowlist", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { alias: "gpt" },
            "anthropic/claude-opus-4-6": { alias: "opus" },
          },
        },
      },
    } as OpenClawConfig;

    const applied = applyModelAllowlist(config, ["openai/gpt-5.6-sol"], {
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.6-sol"],
    });
    const next = stampConfigWriteMetadata(applied, undefined, undefined, config);

    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([
      "anthropic/claude-opus-4-6",
      "openai/gpt-5.6-sol",
    ]);
    expect(next.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });

  it("clears an effective legacy restriction and preserves model metadata", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { alias: "gpt" },
          },
        },
      },
    } as OpenClawConfig;

    const applied = applyModelAllowlist(config, []);
    const next = stampConfigWriteMetadata(applied, undefined, undefined, config);
    expect(next.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "gpt" },
    });
    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([]);
    expect(next.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });
});

describe("applyModelFallbacksFromSelection", () => {
  it("sets fallbacks from selection when the primary is included", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, [
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
  });

  it("does not inject a phantom primary when none was configured", () => {
    const config = {
      agents: {
        defaults: {},
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, [
      "openai/gpt-5.6-sol",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(next.agents?.defaults?.model).toEqual({
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
    expect(next.agents?.defaults?.model).not.toHaveProperty("primary");
  });

  it("does not write an empty model object for singleton default selections", () => {
    const config = {
      agents: {
        defaults: {},
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5"]);
    expect(next).toBe(config);
  });

  it("clears existing fallbacks when only the primary remains selected", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["anthropic/claude-opus-4-6"]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
    });
  });

  it("normalizes retired Google Gemini refs in selected fallbacks before writing config", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["google/gemini-3-pro-preview"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, [
      "openai/gpt-5.5",
      "google/gemini-3-pro-preview",
      "openrouter/google/gemini-3-pro-preview",
    ]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["google/gemini-3.1-pro-preview", "openrouter/google/gemini-3.1-pro-preview"],
    });
  });

  it("normalizes a retired Google Gemini primary while writing selected fallbacks", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "google/gemini-3-pro-preview",
            fallbacks: ["openai/gpt-5.5"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, [
      "google/gemini-3.1-pro-preview",
      "openai/gpt-5.5",
    ]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
      fallbacks: ["openai/gpt-5.5"],
    });
  });

  it("drops malformed fallback refs instead of preserving raw strings", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["openai/"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5"]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
    });
  });

  it("preserves out-of-scope fallbacks during scoped selections", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5"], {
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4"],
    });
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
  });

  it("removes scoped fallbacks for empty scoped selections", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["openai/gpt-5.5", "google/gemini-3-pro-preview"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, [], {
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4"],
    });
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["google/gemini-3.1-pro-preview"],
    });
  });

  it("does not add new scoped fallbacks when the primary is outside scope", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["openai/gpt-5.5"],
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5", "openai/gpt-5.4"], {
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4"],
    });
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["openai/gpt-5.5"],
    });
  });

  it("removes existing scoped fallback aliases when deselected", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["mini"],
          },
          models: {
            "openai/gpt-5.4-mini": { alias: "mini" },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5"], {
      scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
    });
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
    });
  });

  it("canonicalizes existing scoped fallback aliases when kept selected", () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["mini"],
          },
          models: {
            "openai/gpt-5.4-mini": { alias: "mini" },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(
      config,
      ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
      {
        scopeKeys: ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
      },
    );
    expect(next.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["openai/gpt-5.4-mini"],
    });
  });

  it("keeps existing fallbacks when the primary is not selected", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6", fallbacks: ["openai/gpt-5.5"] },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.5"]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["openai/gpt-5.5"],
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
