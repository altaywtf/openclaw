import { afterEach, beforeEach, expect, it } from "vitest";
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  getPreparedModelRuntimeTestApi,
  resetPreparedModelRuntimeHarness,
} from "../agents/prepared-model-runtime.test-harness.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveDefaultModelAuthStatus } from "./auth-choice.model-check.js";

const {
  getPreparedModelRuntimeSnapshot,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} = await import("../agents/prepared-model-runtime.js");
const runtime = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "wizard-draft-owner" });
  resetPreparedModelRuntimeHarness(state);
});

afterEach(async () => {
  await cleanupPreparedModelRuntimeHarness(state);
});

it("prepares and releases a draft while preserving the active Gateway owner", async () => {
  runtime.configuredAgentIds = ["default"];
  const publishedConfig: OpenClawConfig = {
    agents: {
      defaults: { model: "custom/published" },
      list: [{ id: "default" }],
    },
  };
  const scope = {
    agentId: "default",
    agentDir: state.agentDir("default"),
    workspaceDir: state.workspaceDir,
  };
  await refreshPreparedModelRuntimeSnapshots(publishedConfig, {
    gatewayLifecycle: true,
    defaultWorkspaceDir: state.workspaceDir,
  });
  const published = await prepareModelRuntimeSnapshot({ config: publishedConfig, ...scope });
  const ownerCount = getPreparedModelRuntimeTestApi().getPreparedModelRuntimeOwnerCountForTest();
  const draft: OpenClawConfig = {
    ...publishedConfig,
    agents: { ...publishedConfig.agents, defaults: { model: "custom/draft" } },
  };
  const result = await resolveDefaultModelAuthStatus(draft, scope);

  expect(result).toMatchObject({ provider: "custom", model: "draft" });
  expect(getPreparedModelRuntimeSnapshot({ config: publishedConfig, ...scope })).toBe(published);
  expect(
    getPreparedModelRuntimeSnapshot({ config: draft, ...scope, readOnly: true }),
  ).toBeUndefined();
  expect(getPreparedModelRuntimeTestApi().getPreparedModelRuntimeOwnerCountForTest()).toBe(
    ownerCount,
  );
});
