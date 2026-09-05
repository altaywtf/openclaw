import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeStickerImage } from "./sticker-cache.js";

const mocks = vi.hoisted(() => ({
  resolveAutoImageModel:
    vi.fn<typeof import("openclaw/plugin-sdk/media-runtime").resolveAutoImageModel>(),
  describeImageFileWithModel: vi.fn(async (params: { provider: string; model: string }) => ({
    text: `${params.provider}/${params.model}`,
  })),
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveAgentDir: () => "/tmp/catalog-owner-agent",
  resolveDefaultModelForAgent: () => ({ provider: "alpha", model: "stale-vision" }),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  resolveAutoImageModel: mocks.resolveAutoImageModel,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getTelegramRuntime: () => ({
    mediaUnderstanding: {
      describeImageFileWithModel: mocks.describeImageFileWithModel,
    },
  }),
}));

describe("describeStickerImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAutoImageModel.mockReset();
  });

  it("returns no description when the core media owner selects no model", async () => {
    mocks.resolveAutoImageModel.mockResolvedValue(null);

    await expect(
      describeStickerImage({
        imagePath: "/tmp/catalog-owner-sticker.webp",
        cfg: {},
        agentDir: "/tmp/catalog-owner-agent",
      }),
    ).resolves.toBeNull();

    expect(mocks.describeImageFileWithModel).not.toHaveBeenCalled();
  });

  it("uses the exact model selected by the core media owner", async () => {
    mocks.resolveAutoImageModel.mockResolvedValue({
      provider: "beta",
      model: "selected-vision",
    });

    await expect(
      describeStickerImage({
        imagePath: "/tmp/catalog-owner-sticker.webp",
        cfg: {},
        agentDir: "/tmp/catalog-owner-agent",
      }),
    ).resolves.toBe("beta/selected-vision");

    expect(mocks.describeImageFileWithModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "beta",
        model: "selected-vision",
      }),
    );
  });
});
