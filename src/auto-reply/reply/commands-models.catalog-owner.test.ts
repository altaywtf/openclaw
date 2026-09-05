import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { buildPreparedModelsProviderData } from "./commands-models.js";

const mocks = vi.hoisted(() => ({
  loadView: vi.fn(),
}));

vi.mock("../../agents/model-catalog-view.js", () => ({
  loadPreparedModelCatalogView: mocks.loadView,
}));

vi.mock("../../agents/harness/policy.js", () => ({
  resolveAgentHarnessPolicy: () => ({ runtime: "openclaw" }),
}));

vi.mock("../../status/agent-runtime-label.js", () => ({
  resolveAgentRuntimeLabel: ({ resolvedHarness }: { resolvedHarness: string }) => resolvedHarness,
}));

beforeEach(() => {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [],
  });
  mocks.loadView.mockResolvedValue({
    entries: [{ provider: "alpha", id: "published", name: "Published model" }],
    resolvedDefault: { provider: "alpha", model: "published" },
    providerAuthLabels: new Map(),
    runtime: () => ({ id: "fixture-runtime", source: "auth" }),
    runtimeChoices: () => ["fixture-runtime", "openclaw"],
  });
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  vi.clearAllMocks();
});

it("uses the published model runtime instead of a separate provider binding table", async () => {
  const data = await buildPreparedModelsProviderData({});

  expect(data.runtimeChoicesByProvider?.get("alpha")).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "fixture-runtime" })]),
  );
  expect(data.runtimeChoicesByModel?.get("alpha/published")?.map((choice) => choice.id)).toEqual([
    "fixture-runtime",
    "openclaw",
  ]);
});

it("does not invent runtime choices for providers absent from the published view", async () => {
  const data = await buildPreparedModelsProviderData({});

  expect([...(data.runtimeChoicesByProvider?.keys() ?? [])]).toEqual(data.providers);
});
