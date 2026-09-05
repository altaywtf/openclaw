import { expect, test } from "vitest";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";

test("keeps model metadata readable after a reload copies the published config", async () => {
  const config = {
    agents: {
      defaults: { model: "test/first" },
      entries: { main: {} },
    },
  };
  const harness = createChatMetadataHarness(config, { useDefaultProjection: true });

  try {
    await harness.runtime.refresh();
    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "first" })],
    });

    const reloadedConfig = {
      agents: {
        ...config.agents,
        defaults: { model: "test/second" },
      },
    };
    harness.setConfig(reloadedConfig);
    harness.setOwner(createChatMetadataOwner(structuredClone(reloadedConfig), "second"));
    harness.runtime.invalidate();
    await harness.runtime.refresh();

    await expect(
      harness.runtime.readStartup({ agentId: "main", readPolicy: "ready" }),
    ).resolves.toMatchObject({
      sessionModelCatalog: [expect.objectContaining({ id: "second" })],
      defaultModelCatalog: [expect.objectContaining({ id: "second" })],
    });
    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "second" })],
    });

    harness.setConfig({ ...reloadedConfig, messages: { responsePrefix: "changed" } });
    await expect(
      harness.runtime.readStartup({ agentId: "main", readPolicy: "ready" }),
    ).resolves.toBeUndefined();
  } finally {
    await harness.runtime.stop();
  }
});
