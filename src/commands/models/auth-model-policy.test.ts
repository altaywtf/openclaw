import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import {
  getRuntimeConfigWriteApplication,
  type RuntimeConfigWriteApplicationStatus,
} from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  loadValidConfigOrThrow: vi.fn(),
  updateConfig: vi.fn(),
  logConfigUpdated: vi.fn(),
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  loadValidConfigOrThrow: mocks.loadValidConfigOrThrow,
  updateConfig: mocks.updateConfig,
}));

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

const { adoptProviderModelPolicy, chooseProviderModelAccess } =
  await import("./auth-model-policy.js");

function defaultPolicy(allow: string[]): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: "fixture/current",
        modelPolicy: { allow },
      },
      list: [{ id: "main", default: true }],
    },
  };
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("provider model access policy", () => {
  let currentConfig: OpenClawConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    currentConfig = defaultPolicy(["fixture/current"]);
    mocks.loadValidConfigOrThrow.mockImplementation(async () => currentConfig);
    mocks.updateConfig.mockImplementation(
      async (mutator: (config: OpenClawConfig) => OpenClawConfig) => {
        currentConfig = mutator(currentConfig);
        return currentConfig;
      },
    );
  });

  it("asks before widening an existing model restriction", async () => {
    const select = vi.fn(async () => "all" as const);

    const decision = await chooseProviderModelAccess({
      config: currentConfig,
      agentId: "main",
      provider: "sample",
      providerLabel: "Sample",
      prompter: createWizardPrompter({ select }),
    });

    expect(select).toHaveBeenCalledExactlyOnceWith({
      message:
        "Your current model restrictions may hide Sample models. What should happen after sign-in?",
      initialValue: "keep",
      options: [
        { value: "all", label: "Show all Sample models" },
        { value: "keep", label: "Keep current restrictions" },
      ],
    });
    expect(decision.choice).toBe("all");
  });

  it("keeps restrictions without opening a config write", async () => {
    const decision = await chooseProviderModelAccess({
      config: currentConfig,
      agentId: "main",
      provider: "sample",
      providerLabel: "Sample",
      choice: "keep",
      prompter: createWizardPrompter(),
    });

    await expect(
      adoptProviderModelPolicy({
        provider: "sample",
        agentId: "main",
        runtime: createRuntime(),
        decision,
      }),
    ).resolves.toBe("restricted");

    expect(mocks.updateConfig).not.toHaveBeenCalled();
    expect(currentConfig.agents?.defaults?.modelPolicy?.allow).toEqual(["fixture/current"]);
  });

  it("adds the provider wildcard without changing the default model", async () => {
    const decision = await chooseProviderModelAccess({
      config: currentConfig,
      agentId: "main",
      provider: "sample",
      providerLabel: "Sample",
      choice: "all",
      prompter: createWizardPrompter(),
    });

    await expect(
      adoptProviderModelPolicy({
        provider: "sample",
        agentId: "main",
        runtime: createRuntime(),
        decision,
      }),
    ).resolves.toBe("enabled");

    expect(currentConfig.agents?.defaults?.model).toBe("fixture/current");
    expect(currentConfig.agents?.defaults?.modelPolicy?.allow).toEqual([
      "fixture/current",
      "sample/*",
    ]);
    expect(mocks.logConfigUpdated).toHaveBeenCalledOnce();
  });

  it("preserves replacement restrictions when consent becomes stale", async () => {
    const decision = await chooseProviderModelAccess({
      config: currentConfig,
      agentId: "main",
      provider: "sample",
      providerLabel: "Sample",
      choice: "all",
      prompter: createWizardPrompter(),
    });
    currentConfig = defaultPolicy(["fixture/replacement"]);
    const runtime = createRuntime();

    await expect(
      adoptProviderModelPolicy({
        provider: "sample",
        agentId: "main",
        runtime,
        decision,
      }),
    ).resolves.toBe("failed");

    expect(currentConfig.agents?.defaults?.modelPolicy?.allow).toEqual(["fixture/replacement"]);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Choose model access again"),
    );
  });

  it("revalidates stale consent inside the config write", async () => {
    const decision = await chooseProviderModelAccess({
      config: currentConfig,
      agentId: "main",
      provider: "sample",
      providerLabel: "Sample",
      choice: "all",
      prompter: createWizardPrompter(),
    });
    mocks.updateConfig.mockImplementationOnce(
      async (mutator: (config: OpenClawConfig) => OpenClawConfig) => {
        currentConfig = defaultPolicy(["fixture/late-replacement"]);
        currentConfig = mutator(currentConfig);
        return currentConfig;
      },
    );
    const runtime = createRuntime();

    await expect(
      adoptProviderModelPolicy({
        provider: "sample",
        agentId: "main",
        runtime,
        decision,
      }),
    ).resolves.toBe("failed");

    expect(currentConfig.agents?.defaults?.modelPolicy?.allow).toEqual([
      "fixture/late-replacement",
    ]);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Choose model access again"),
    );
  });

  it("does not redirect agent consent to defaults when its policy owner disappears", async () => {
    currentConfig = {
      agents: {
        defaults: { modelPolicy: { allow: ["fixture/shared"] } },
        list: [
          { id: "main", default: true },
          { id: "coder", modelPolicy: { allow: ["fixture/private"] } },
        ],
      },
    };
    const decision = await chooseProviderModelAccess({
      config: currentConfig,
      agentId: "coder",
      provider: "sample",
      providerLabel: "Sample",
      choice: "all",
      prompter: createWizardPrompter(),
    });
    currentConfig.agents!.list![1] = { id: "coder" };

    await expect(
      adoptProviderModelPolicy({
        provider: "sample",
        agentId: "coder",
        runtime: createRuntime(),
        decision,
      }),
    ).resolves.toBe("failed");

    expect(currentConfig.agents?.defaults?.modelPolicy?.allow).toEqual(["fixture/shared"]);
    expect(currentConfig.agents?.list?.[1]).not.toHaveProperty("modelPolicy");
  });

  it("waits for the running Gateway to apply the widened policy", async () => {
    const decision = await chooseProviderModelAccess({
      config: currentConfig,
      agentId: "main",
      provider: "sample",
      providerLabel: "Sample",
      choice: "all",
      prompter: createWizardPrompter(),
    });
    let settleApplication: ((status: RuntimeConfigWriteApplicationStatus) => void) | undefined;
    mocks.updateConfig.mockImplementationOnce(
      async (
        mutator: (config: OpenClawConfig) => OpenClawConfig,
        options: { writeOptions?: object },
      ) => {
        currentConfig = mutator(currentConfig);
        const application = getRuntimeConfigWriteApplication(options.writeOptions ?? {});
        settleApplication = application?.claim()?.settle;
        return currentConfig;
      },
    );

    let completed = false;
    const update = adoptProviderModelPolicy({
      provider: "sample",
      agentId: "main",
      runtime: createRuntime(),
      decision,
    }).then((result) => {
      completed = true;
      return result;
    });
    await vi.waitFor(() => expect(settleApplication).toBeTypeOf("function"));

    expect(completed).toBe(false);
    settleApplication?.("applied");
    await expect(update).resolves.toBe("enabled");
  });
});
