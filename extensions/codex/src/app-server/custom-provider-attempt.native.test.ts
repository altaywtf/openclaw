import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { codexControlRequest } from "../command-rpc.js";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import type { CodexAppServerClient } from "./client.js";
import { CODEX_CUSTOM_PROVIDER_API_KEY_ENV } from "./custom-provider.js";
import {
  createCustomProviderTestServer,
  customProviderTestConfig,
  writeCustomProviderTestResponse,
} from "./custom-provider.test-support.js";
import { dynamicToolBuildState } from "./dynamic-tool-build-state.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject } from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createCodexRuntimePlanFixture,
  createNativeRunParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";
import {
  clearSharedCodexAppServerClientIfCurrentAndWait,
  getLeasedSharedCodexAppServerClient,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

setupRunAttemptTestHooks();
vi.unmock("node:child_process");

const PROVIDER = "test-proxy";
const MODEL = "gpt-5.2-codex";
const PREPARED_KEY = "synthetic-prepared-attempt-key";
const ANSWER = "Prepared custom route completed.";

describe("native Codex custom provider attempt", () => {
  it(
    "preserves a generic prepared route across native control and a private bounded turn",
    { timeout: 90_000 },
    async () => {
      const cleanups: Array<() => Promise<void>> = [];
      const failures: unknown[] = [];
      try {
        const root = await fs.realpath(tempDir);
        const native = await createCodexNativeTestState(root);
        for (const [name, value] of Object.entries(native.env)) {
          if (value !== undefined) {
            vi.stubEnv(name, value);
          }
        }
        vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
        vi.stubEnv("OPENAI_API_KEY", "synthetic-ambient-key");
        vi.stubEnv(CODEX_CUSTOM_PROVIDER_API_KEY_ENV, "synthetic-stale-provider-key");
        const requests: Array<{
          authorization: string | undefined;
          model: unknown;
          account: unknown;
        }> = [];
        const baseUrl = await createCustomProviderTestServer(
          (request, response, requestBody) => {
            try {
              if (request.method !== "POST" || request.url !== "/v1/responses") {
                response.writeHead(404).end();
                return;
              }
              const body: unknown = JSON.parse(requestBody);
              if (!isJsonObject(body)) {
                response.writeHead(400).end();
                return;
              }
              requests.push({
                authorization: request.headers.authorization,
                model: body.model,
                account: request.headers["chatgpt-account-id"],
              });
              if (
                request.headers.authorization !== `Bearer ${PREPARED_KEY}` ||
                body.model !== MODEL
              ) {
                response.writeHead(401).end();
                return;
              }
              const id = `attempt-response-${requests.length}`;
              writeCustomProviderTestResponse(
                response,
                id,
                {
                  id: `attempt-answer-${requests.length}`,
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: ANSWER }],
                },
                { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
              );
            } catch (error) {
              failures.push(error);
              response.writeHead(500).end();
            }
          },
          (cleanup) => {
            cleanups.push(cleanup);
          },
        );
        const agentDir = path.join(root, "agent");
        const codexHome = resolveCodexAppServerHomeDir(agentDir);
        await fs.mkdir(codexHome, { recursive: true });
        await fs.writeFile(
          path.join(codexHome, "config.toml"),
          customProviderTestConfig({
            model: MODEL,
            provider: PROVIDER,
            baseUrl,
            sandbox: "workspace-write",
          }),
        );
        const pluginConfig = {
          appServer: {
            command: native.command,
            args: ["app-server"],
            homeScope: "agent" as const,
            transport: "stdio" as const,
            providerIds: ["codex", "openai", PROVIDER],
            clearEnv: Object.keys(process.env).filter(
              (key) => !(key in native.env) && key !== CODEX_CUSTOM_PROVIDER_API_KEY_ENV,
            ),
          },
        };
        const params = createNativeRunParams(path.join(root, "session.jsonl"), native.cwd);
        await attachSqliteSessionTarget(
          params,
          path.join(root, "transcript.sqlite"),
          "custom-provider-attempt",
        );
        params.agentDir = agentDir;
        params.provider = PROVIDER;
        params.modelId = MODEL;
        params.model = {
          ...params.model,
          provider: PROVIDER,
          id: MODEL,
          api: "openai-responses",
          baseUrl,
        };
        params.resolvedApiKey = PREPARED_KEY;
        params.prompt = "Reply briefly.";
        params.timeoutMs = 30_000;
        params.disableTools = false;
        params.permissionMode = "full";
        params.config = {
          agents: {
            defaults: { model: { primary: `${PROVIDER}/${MODEL}` }, workspace: native.cwd },
          },
          models: {
            providers: {
              [PROVIDER]: { api: "openai-responses", baseUrl, apiKey: PREPARED_KEY, models: [] },
            },
          },
          tools: { web: { search: { enabled: false } } },
        };
        const runtimePlan = createCodexRuntimePlanFixture();
        // Generic configured providers carry model facts and a prepared key without modelRoute.
        params.runtimePlan = {
          ...runtimePlan,
          auth: {
            selectedAuthMode: "api-key",
            providerForAuth: PROVIDER,
            authProfileProviderForAuth: PROVIDER,
          },
          observability: {
            ...runtimePlan.observability,
            provider: PROVIDER,
            modelId: MODEL,
            resolvedRef: `${PROVIDER}/${MODEL}`,
          },
        };
        dynamicToolBuildState.openClawCodingToolsFactory = () => [];
        const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
        cleanups.push(async () => closeHost());
        const clients = new Set<CodexAppServerClient>();
        const registerClientCleanup = (client: CodexAppServerClient) => {
          if (!clients.has(client)) {
            clients.add(client);
            cleanups.push(async () => {
              await clearSharedCodexAppServerClientIfCurrentAndWait(client);
              expect(await client.closeAndWait()).toMatchObject({ exited: true });
            });
          }
        };
        const clientFactory: CodexAppServerClientFactory = async (options) => {
          const client = await getLeasedSharedCodexAppServerClient(options);
          registerClientCleanup(client);
          expect(client.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
          return client;
        };
        const result = await runCodexAppServerAttempt(params, {
          pluginConfig,
          clientFactory,
          nativeHookRelay: { enabled: false },
        });
        expect(result.terminal).toEqual({ kind: "ok" });
        const binding = await readCodexAppServerBinding(params.sessionFile);
        expect(binding).toMatchObject({ modelProvider: PROVIDER, model: MODEL });
        if (!binding) {
          throw new Error("Expected a persisted native thread binding");
        }
        const turnClients = new Set(clients);
        const publishControl = vi.fn(async (_response: unknown, client: CodexAppServerClient) => {
          expect(turnClients.has(client)).toBe(true);
        });
        const resumed = await codexControlRequest(
          pluginConfig,
          "thread/resume",
          { threadId: binding.threadId },
          {
            config: params.config,
            agentDir,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            storePath: params.sessionTarget?.storePath,
            timeoutMs: 30_000,
            beforeRequest: async (_request, client) => {
              registerClientCleanup(client);
            },
            onResponse: publishControl,
          },
        );
        expect(publishControl).toHaveBeenCalledOnce();
        expect(resumed).toMatchObject({
          thread: { id: binding.threadId, modelProvider: PROVIDER },
          model: MODEL,
          modelProvider: PROVIDER,
        });
        expect(requests).toEqual([
          { authorization: `Bearer ${PREPARED_KEY}`, model: MODEL, account: undefined },
        ]);

        const bounded = await runBoundedCodexAppServerTurn({
          model: { mode: "required", id: MODEL },
          modelProvider: PROVIDER,
          preparedAuth: {
            kind: "api-key",
            apiKey: PREPARED_KEY,
            customProvider: { provider: PROVIDER, baseUrl },
          },
          authRequirement: "api-key",
          authProfileStore: params.authProfileStore,
          agentDir,
          timeoutMs: 30_000,
          taskLabel: "custom provider private-home proof",
          developerInstructions: "Reply briefly without tools.",
          input: [{ type: "text", text: "Confirm the prepared route.", text_elements: [] }],
          requiredModalities: ["text"],
          isolation: "private-stdio",
          requireNoExternalCapabilities: true,
          options: { pluginConfig },
        });
        expect(bounded.text).toBe(ANSWER);
        expect(bounded.nativeSelection).toEqual({ model: MODEL, modelProvider: PROVIDER });
        expect(requests).toEqual([
          { authorization: `Bearer ${PREPARED_KEY}`, model: MODEL, account: undefined },
          { authorization: `Bearer ${PREPARED_KEY}`, model: MODEL, account: undefined },
        ]);
      } catch (error) {
        failures.push(error);
      } finally {
        // Native processes must exit before shared afterEach removes their homes.
        for (const cleanup of cleanups.toReversed()) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Native custom provider attempt or cleanup failed");
      }
    },
  );
});
