import {
  AccessDeniedException,
  BedrockClient,
  ListFoundationModelsCommand,
} from "@aws-sdk/client-bedrock";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as controlPlane from "./control-plane.js";
import amazonBedrockPlugin from "./index.js";

vi.mock("./aws-credential-refresh.js", () => ({
  refreshAwsSharedConfigCacheForBedrock: vi.fn(async () => {}),
}));

const context: ProviderCatalogContext = {
  config: {
    plugins: {
      entries: {
        "amazon-bedrock": { config: { discovery: { enabled: true, refreshInterval: 0 } } },
      },
    },
  },
  env: {},
  resolveProviderApiKey: () => ({ apiKey: undefined }),
  resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
};

describe("Bedrock catalog outcomes", () => {
  let client: BedrockClient;

  beforeEach(async () => {
    client = new BedrockClient({ region: "us-east-1" });
    const sdk = await controlPlane.loadBedrockControlPlaneSdk();
    vi.spyOn(controlPlane, "loadBedrockControlPlaneSdk").mockResolvedValue({
      ...sdk,
      createClient: () => client,
    });
    vi.spyOn(client, "send").mockResolvedValue({
      $metadata: {},
      modelSummaries: [],
      inferenceProfileSummaries: [],
    });
    vi.spyOn(client, "destroy");
  });

  afterEach(() => {
    client.destroy();
    vi.restoreAllMocks();
  });

  it.each([
    { operation: "foundation", rejected: true },
    { operation: "profiles", rejected: true },
    { operation: "foundation", rejected: false },
    { operation: "profiles", rejected: false },
  ])("reports $operation acquisition failure (auth rejected: $rejected)", async (testCase) => {
    vi.mocked(client.send).mockImplementation(async (command) => {
      const foundation = command instanceof ListFoundationModelsCommand;
      if (foundation === (testCase.operation === "foundation")) {
        throw testCase.rejected
          ? new AccessDeniedException({
              message: "Catalog permission denied",
              $metadata: { httpStatusCode: 403 },
            })
          : new Error("Catalog unavailable");
      }
      return { $metadata: {}, modelSummaries: [], inferenceProfileSummaries: [] };
    });
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);

    await expect(provider.catalog?.run(context)).resolves.toEqual({
      providers: {},
      outcomes: [
        {
          provider: "amazon-bedrock",
          status: testCase.rejected ? "auth-rejected" : "unavailable",
          ...(testCase.rejected ? { rejectionScope: "catalog" } : {}),
        },
      ],
    });
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it("reports a successfully acquired empty catalog as ready", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);

    await expect(provider.catalog?.run(context)).resolves.toMatchObject({
      provider: { models: [], auth: "aws-sdk" },
      outcomes: [{ provider: "amazon-bedrock", status: "ready" }],
    });
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it.each([{}, { discovery: { enabled: false } }])(
    "does not report acquisition when discovery is not attempted: %j",
    async (pluginConfig) => {
      const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
      await expect(
        provider.catalog?.run({
          ...context,
          config: { plugins: { entries: { "amazon-bedrock": { config: pluginConfig } } } },
        }),
      ).resolves.toBeNull();
      expect(client.send).not.toHaveBeenCalled();
    },
  );
});
