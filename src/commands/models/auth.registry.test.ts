import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "../../plugins/loader.test-fixtures.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { runModelsAuthLoginFlowCore } from "./auth.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

describe("provider login registry ownership", () => {
  it.each(["provider", "manifest-owner"] as const)(
    "preserves channel authorization during and after %s login",
    async (selection) => {
      const root = fs.realpathSync(makePluginLoaderTempDir());
      const plugin = writePlugin({
        id: "login-fixture",
        dir: path.join(root, "provider"),
        body: `module.exports = {
          id: "login-fixture",
          register(api) {
            api.registerProvider({
              id: "login-fixture",
              label: "Login fixture",
              auth: [{
                id: "test-login",
                label: "Test login",
                kind: "custom",
                async run(ctx) {
                  await ctx.prompter.note("Sign-in started");
                  return { profiles: [] };
                },
              }],
            });
          },
        };`,
      });
      fs.writeFileSync(
        path.join(plugin.dir, "openclaw.plugin.json"),
        JSON.stringify({
          id: plugin.id,
          providers: [plugin.id],
          configSchema: { type: "object", properties: {}, additionalProperties: false },
        }),
      );
      const config: OpenClawConfig = {
        commands: { ownerAllowFrom: ["telegram:200"] },
        agents: { defaults: { workspace: root } },
        plugins: {
          allow: [plugin.id],
          load: { paths: [plugin.file] },
          entries: { [plugin.id]: { enabled: true } },
        },
      };
      await withEnvAsync(
        {
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        },
        async () => {
          const channel = {
            pluginId: "telegram",
            plugin: createChannelTestPluginBase({ id: "telegram" }),
            source: "test",
          };
          const registry = createTestRegistry([channel]);
          setActivePluginRegistry(registry);
          const ownerAccess = (senderId: string) =>
            resolveCommandAuthorization({
              cfg: config,
              ctx: {
                Provider: "telegram",
                Surface: "telegram",
                ChatType: "direct",
                SenderId: senderId,
              },
              commandAuthorized: true,
            }).senderIsOwner;
          expect(ownerAccess("200")).toBe(true);
          expect(ownerAccess("300")).toBe(false);
          const started = createDeferredCore();
          const finish = createDeferredCore();
          const login = runModelsAuthLoginFlowCore({
            config,
            provider: plugin.id,
            ...(selection === "manifest-owner" ? { ownerPluginId: plugin.id } : {}),
            method: "test-login",
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            prompter: createWizardPrompter({
              note: async () => {
                started.resolve();
                await finish.promise;
              },
            }),
            refreshAuthState: async () => "refreshed",
          });
          try {
            await Promise.race([started.promise, login]);
            expect(getActivePluginRegistry()).toBe(registry);
            expect(ownerAccess("200")).toBe(true);
            const replacement = createTestRegistry([channel]);
            setActivePluginRegistry(replacement);
            finish.resolve();
            await expect(login).resolves.toMatchObject({
              providerId: plugin.id,
              methodId: "test-login",
            });
            expect(getActivePluginRegistry()).toBe(replacement);
            expect(ownerAccess("200")).toBe(true);
            expect(ownerAccess("300")).toBe(false);
          } finally {
            finish.resolve();
            await login;
          }
        },
      );
    },
  );
});
