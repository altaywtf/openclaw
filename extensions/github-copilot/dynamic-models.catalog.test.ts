import type { ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGithubCopilotDynamicModelHooks } from "./dynamic-models.js";

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  exchange: vi.fn(),
  models: vi.fn(),
}));

vi.mock("./auth.js", () => ({ resolveFirstGithubToken: mocks.token }));
vi.mock("./register.runtime.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://api.githubcopilot.com",
  resolveCopilotRuntimeAuth: mocks.exchange,
}));
vi.mock("./models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./models.js")>()),
  fetchCopilotModelCatalog: mocks.models,
}));

const context: ProviderCatalogContext = {
  config: {},
  env: {},
  resolveProviderApiKey: () => ({ apiKey: undefined }),
  resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
};

describe("Copilot catalog acquisition", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
    mocks.token.mockReset().mockResolvedValue({
      githubToken: "test-github-token",
      hasProfile: true,
      profileId: "github-copilot:tested",
    });
    mocks.exchange.mockReset().mockResolvedValue({
      baseUrl: "https://api.githubcopilot.com",
      apiKey: "test-copilot-token",
    });
    mocks.models.mockReset().mockResolvedValue([]);
  });

  it.each(["exchange", "models"] as const)(
    "catalog cutover: reports Copilot %s failure instead of an empty successful catalog",
    async (stage) => {
      mocks[stage].mockRejectedValueOnce(new Error(`${stage} unavailable`));
      const hooks = createGithubCopilotDynamicModelHooks({ discoveryEnabled: () => true });
      await expect(hooks.runCatalog(context)).resolves.toMatchObject({
        outcomes: [
          {
            provider: "github-copilot",
            profileId: "github-copilot:tested",
            status: "unavailable",
          },
        ],
      });
      expect(mocks.token).toHaveBeenCalledOnce();
    },
  );

  it("catalog cutover: keeps missing Copilot credentials a non-attempt", async () => {
    mocks.token.mockResolvedValueOnce({ githubToken: "", hasProfile: false });
    const hooks = createGithubCopilotDynamicModelHooks({ discoveryEnabled: () => true });
    await expect(hooks.runCatalog(context)).resolves.toBeNull();
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.models).not.toHaveBeenCalled();
  });
});
