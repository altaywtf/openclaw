import { beforeEach, expect, it, vi } from "vitest";
import { describeStickerImage } from "./sticker-cache.js";

const mocks = vi.hoisted(() => ({
  resolveAutoImageModel:
    vi.fn<typeof import("openclaw/plugin-sdk/media-runtime").resolveAutoImageModel>(),
  resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "fixture-key" })),
  describeImageFileWithModel: vi.fn(async (params: { provider: string; model: string }) => ({
    text: `${params.provider}/${params.model}`,
  })),
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  findModelInCatalog: (
    catalog: Array<{ provider: string; id: string; input: string[] }>,
    provider: string,
    model: string,
  ) => catalog.find((entry) => entry.provider === provider && entry.id === model),
  loadPreparedModelCatalog: async () => [
    { provider: "alpha", id: "stale-vision", name: "Stale vision model", input: ["image"] },
  ],
  modelSupportsVision: (entry?: { input: string[] }) => Boolean(entry?.input.includes("image")),
  resolveApiKeyForProvider: mocks.resolveApiKeyForProvider,
  resolveAgentDir: () => "/tmp/catalog-owner-agent",
  resolveDefaultModelForAgent: () => ({ provider: "alpha", model: "stale-vision" }),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  resolveAutoImageModel: mocks.resolveAutoImageModel,
  resolveAutoMediaKeyProviders: () => ["alpha"],
  resolveDefaultMediaModel: () => "stale-vision",
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getTelegramRuntime: () => ({
    mediaUnderstanding: { describeImageFileWithModel: mocks.describeImageFileWithModel },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAutoImageModel.mockReset();
});

it("does not resurrect an available model after the core media owner selects none", async () => {
  mocks.resolveAutoImageModel.mockResolvedValue(null);

  const description = await describeStickerImage({
    imagePath: "/tmp/catalog-owner-sticker.webp",
    cfg: {},
    agentDir: "/tmp/catalog-owner-agent",
  });

  expect(description).toBeNull();
  expect(mocks.describeImageFileWithModel).not.toHaveBeenCalled();
  expect(mocks.resolveApiKeyForProvider).not.toHaveBeenCalled();
});

it("uses the core media owner's selected model instead of channel catalog and auth choices", async () => {
  mocks.resolveAutoImageModel.mockResolvedValue({ provider: "beta", model: "selected-vision" });

  const description = await describeStickerImage({
    imagePath: "/tmp/catalog-owner-sticker.webp",
    cfg: {},
    agentDir: "/tmp/catalog-owner-agent",
  });

  expect(description).toBe("beta/selected-vision");
  expect(mocks.describeImageFileWithModel).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "beta", model: "selected-vision" }),
  );
  expect(mocks.resolveApiKeyForProvider).not.toHaveBeenCalled();
});
