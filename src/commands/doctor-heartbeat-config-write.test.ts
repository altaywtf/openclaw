import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import { applyModelDefaults, DEFAULT_MODEL_ALIASES } from "../config/defaults.js";
import { readConfigFileSnapshot } from "../config/io.runtime.js";
import { transformConfigFile } from "../config/mutate.js";
import { withEnvOverride, withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDefaultProactiveJobReceipt } from "../cron/proactive-job-receipt.js";
import { loadCronJobsStore } from "../cron/store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { heartbeatRetirementConfigFingerprint } from "./doctor-heartbeat-retirement-policy.js";
import {
  applyHeartbeatRetirement,
  completeHeartbeatRetirement,
  prepareHeartbeatRetirement,
} from "./doctor-heartbeat-retirement.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each([
  { interrupted: false, include: false },
  { interrupted: true, include: false },
  { interrupted: false, include: true },
  { interrupted: true, include: true },
])(
  "binds retirement to the real writer's source projection ($interrupted, include: $include)",
  async ({ interrupted, include }) => {
    await withTempHome(async (home) => {
      await withEnvOverride(
        {
          HEARTBEAT_TEST_AGENT_NAME: "Synthetic agent",
          HEARTBEAT_TEST_MODEL: "openai/gpt-5.6-luna",
        },
        async () => {
          const configPath = await writeOpenClawConfig(home, {
            agents: {
              defaults: {
                workspace: "~/workspace",
                model: "${HEARTBEAT_TEST_MODEL}",
                heartbeat: { every: "30m" },
              },
              entries: { main: { name: "${HEARTBEAT_TEST_AGENT_NAME}" } },
            },
          });
          const agentsPath = path.join(path.dirname(configPath), "agents.json");
          if (include) {
            const authored = JSON.parse(await fs.readFile(configPath, "utf8"));
            await fs.writeFile(agentsPath, JSON.stringify(authored.agents));
            await fs.writeFile(configPath, JSON.stringify({ agents: { $include: "agents.json" } }));
          }
          const original = await fs.readFile(configPath, "utf8");
          const originalAgents = include ? await fs.readFile(agentsPath, "utf8") : undefined;
          const prepare = async () => {
            const snapshot = await readConfigFileSnapshot();
            expect(snapshot.valid).toBe(true);
            return {
              snapshot,
              plan: await prepareHeartbeatRetirement({
                sourceConfig: snapshot.sourceConfig,
                effectiveConfig: snapshot.config,
                env: process.env,
                nowMs: 2_000_000_000_000,
              }),
            };
          };
          let { snapshot, plan } = await prepare();
          const write = (
            nextConfig: OpenClawConfig,
            preCommitRuntimePreflight: (sourceConfig: OpenClawConfig) => Promise<void>,
          ) =>
            transformConfigFile({
              ...(snapshot.hash ? { baseHash: snapshot.hash } : {}),
              transform: () => ({ nextConfig }),
              afterWrite: { mode: "auto" },
              writeOptions: { skipOutputLogs: true, preCommitRuntimePreflight },
            });
          if (interrupted) {
            await expect(
              write(plan.config, async (sourceConfig) => {
                await applyHeartbeatRetirement(plan, sourceConfig);
                throw new Error("Interrupted before config commit");
              }),
            ).rejects.toThrow("Interrupted before config commit");
            expect(await fs.readFile(configPath, "utf8")).toBe(original);
            if (include) {
              expect(await fs.readFile(agentsPath, "utf8")).toBe(originalAgents);
            }
            expect(readDefaultProactiveJobReceipt(plan.storePath, "main")?.phase).toBe("pending");
            ({ snapshot, plan } = await prepare());
          }
          let preparedRevision: string | undefined;
          await write({ ...plan.config, logging: undefined }, async (sourceConfig) => {
            if (!include) {
              expect(sourceConfig.meta?.lastTouchedVersion).toBeTruthy();
            }
            expect(sourceConfig.agents?.defaults?.workspace).toBe("~/workspace");
            preparedRevision = heartbeatRetirementConfigFingerprint(sourceConfig);
            await applyHeartbeatRetirement(plan, sourceConfig);
          });
          const persisted = await readConfigFileSnapshot();
          expect(persisted.valid).toBe(true);
          expect(heartbeatRetirementConfigFingerprint(persisted.sourceConfig)).toBe(
            preparedRevision,
          );
          const authored = JSON.parse(await fs.readFile(configPath, "utf8"));
          const authoredAgents = include
            ? JSON.parse(await fs.readFile(agentsPath, "utf8"))
            : authored.agents;
          expect(authoredAgents.defaults.workspace).toBe("~/workspace");
          expect(authoredAgents.defaults.model).toBe("${HEARTBEAT_TEST_MODEL}");
          expect(authoredAgents.entries.main.name).toBe("${HEARTBEAT_TEST_AGENT_NAME}");
          expect(authoredAgents.defaults.heartbeat).toBeUndefined();
          if (include) {
            expect(authored.agents).toEqual({ $include: "agents.json" });
          }
          expect(authored.logging).toBeUndefined();
          await completeHeartbeatRetirement(plan, persisted.sourceConfig);
          expect(readDefaultProactiveJobReceipt(plan.storePath, "main")?.phase).toBe("complete");
        },
      );
    });
  },
);

const modelAliases = ["gpt", "sonnet", "gemini"];
it.each(
  modelAliases.flatMap((primary) =>
    ["partial", "full", "redirect"].map((mode) => ({ primary, mode })),
  ),
)(
  "compares canonical $primary alias bindings after $mode normalization",
  async ({ primary, mode }) => {
    await withTempHome(async (home) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: path.join(home, "workspace"),
            heartbeat: { every: "30m" },
            model: { primary, fallbacks: modelAliases.filter((alias) => alias !== primary) },
            models: Object.fromEntries(
              modelAliases.map((alias) => [DEFAULT_MODEL_ALIASES[alias]!, {}]),
            ),
          },
          list: [{ id: "main" }],
        },
      };
      const effective = applyModelDefaults(cfg);
      const plan = await prepareHeartbeatRetirement({
        sourceConfig: cfg,
        effectiveConfig: effective,
        env: process.env,
        nowMs: 2_000_000_000_000,
      });
      const candidate = structuredClone(plan.config);
      const models = candidate.agents!.defaults!.models!;
      if (mode === "redirect") {
        models[`openai/${primary}`] = { alias: primary };
        expect(
          resolveDefaultModelForAgent({ cfg: applyModelDefaults(candidate), agentId: "main" }),
        ).not.toEqual(resolveDefaultModelForAgent({ cfg: effective, agentId: "main" }));
        const before = await loadCronJobsStore(plan.storePath);
        await expect(applyHeartbeatRetirement(plan, candidate)).rejects.toThrow("policy changed");
        expect(await loadCronJobsStore(plan.storePath)).toEqual(before);
        expect(readDefaultProactiveJobReceipt(plan.storePath, "main")).toBeUndefined();
      } else {
        for (const alias of mode === "full" ? modelAliases : [primary]) {
          models[DEFAULT_MODEL_ALIASES[alias]!]!.alias = alias;
        }
        expect(applyModelDefaults(candidate).agents!.defaults!.models).toEqual(
          effective.agents!.defaults!.models,
        );
        await applyHeartbeatRetirement(plan, candidate);
        await completeHeartbeatRetirement(plan, candidate);
        expect(readDefaultProactiveJobReceipt(plan.storePath, "main")?.phase).toBe("complete");
      }
    });
  },
);
