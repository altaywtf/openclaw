import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { heartbeatTaskDeclarationKey } from "../cron/heartbeat-task.js";
import { readDefaultProactiveJobReceipt } from "../cron/proactive-job-receipt.js";
import { readCronJobScratchState, writeCronJobScratch } from "../cron/scratch-store.js";
import {
  loadCronJobsStore,
  resolveCronJobsStorePathFromConfig,
  saveCronJobsStore,
} from "../cron/store.js";
import type { CronStoredJob } from "../cron/types.js";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveHeartbeatRetirementPolicy } from "./doctor-heartbeat-retirement-policy.js";
import {
  applyHeartbeatRetirement,
  completeHeartbeatRetirement,
  prepareHeartbeatRetirement,
} from "./doctor-heartbeat-retirement.js";
import {
  archiveHeartbeatSource,
  archivePathForSource,
  claimHeartbeatSource,
  readHeartbeatSource,
} from "./doctor-heartbeat-scratch-migration.js";

const roots: string[] = [];
const nowMs = 2_000_000_000_000;
const tasks =
  "# Checklist\n\ntasks:\n  - name: inbox\n    interval: 1h\n    prompt: Check urgent inbox items\n\n# Keep alerts concise\n";

afterEach(async () => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function monitor(id = "monitor"): CronStoredJob {
  return {
    id,
    agentId: "main",
    name: "Existing heartbeat",
    declarationKey: "heartbeat:main",
    createdAtMs: nowMs - 20_000,
    updatedAtMs: nowMs - 10_000,
    enabled: true,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    schedule: { kind: "every", everyMs: 1_800_000, anchorMs: 1234 },
    payload: { kind: "heartbeat" },
    state: { nextRunAtMs: nowMs - 1, lastRunAtMs: nowMs - 60_000, lastRunStatus: "ok" },
  };
}

async function fixture(jobs: CronStoredJob[] = [monitor()]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-retirement-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  vi.stubEnv("HOME", path.join(root, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const env = { ...process.env };
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace, heartbeat: { every: "30m" } }, list: [{ id: "main" }] },
  };
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  if (jobs.length) {
    await saveCronJobsStore(storePath, { version: 1, jobs });
  }
  const prepare = (sourceConfig = cfg, effectiveConfig = sourceConfig) =>
    prepareHeartbeatRetirement({ sourceConfig, effectiveConfig, env, nowMs });
  const scratch = () => readCronJobScratchState(storePath, "monitor", { env });
  const receipt = () => readDefaultProactiveJobReceipt(storePath, "main", { env });
  return {
    root,
    env,
    cfg,
    storePath,
    prepare,
    scratch,
    receipt,
    heartbeatPath: path.join(workspace, "HEARTBEAT.md"),
  };
}

it("prepares a provider-resolved default without creating state or modifying authored config", async () => {
  const f = await fixture([]);
  delete f.cfg.agents!.defaults!.heartbeat;
  const effective = structuredClone(f.cfg);
  effective.agents!.defaults!.heartbeat = { every: "1h" };
  const plan = await f.prepare(f.cfg, effective);
  expect(plan.agents[0]?.jobs[0]?.job.schedule).toMatchObject({
    kind: "every",
    everyMs: 3_600_000,
  });
  expect(f.cfg.agents!.defaults!.heartbeat).toBeUndefined();
  await expect(fs.stat(resolveOpenClawStateSqlitePath(f.env))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each([{ start: "09:00" }, { end: "17:00" }])(
  "keeps partial active-hours windows unrestricted: %j",
  async (activeHours) => {
    const f = await fixture([]);
    f.cfg.agents!.defaults!.heartbeat!.activeHours = activeHours;
    expect(
      resolveHeartbeatRetirementPolicy({ effectiveConfig: f.cfg, agentId: "main", env: f.env })
        .activeHours,
    ).toBeUndefined();
  },
);

it("preserves uniform alert suppression and rejects mixed dynamic owner visibility", async () => {
  const f = await fixture([]);
  f.cfg.channels = { defaults: { heartbeatVisibility: { showAlerts: false } } };
  expect(
    resolveHeartbeatRetirementPolicy({ effectiveConfig: f.cfg, agentId: "main", env: f.env })
      .delivery.mode,
  ).toBe("none");
  f.cfg.channels = {
    telegram: { heartbeatVisibility: { showAlerts: false } },
    discord: { heartbeatVisibility: { showAlerts: true } },
  };
  await expect(f.prepare()).rejects.toThrow("Mixed heartbeat alert visibility");
  await expect(fs.stat(resolveOpenClawStateSqlitePath(f.env))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("converts unenrolled owners' old tasks and files without enabling their jobs", async () => {
  const f = await fixture();
  delete f.cfg.agents!.defaults!.heartbeat;
  f.cfg.agents!.list = [
    { id: "main", workspace: path.dirname(f.heartbeatPath) },
    { id: "other", heartbeat: { every: "1h" } },
    { id: "untouched" },
  ];
  await fs.writeFile(f.heartbeatPath, tasks);
  const plan = await f.prepare();
  const main = plan.agents.find((agent) => agent.agentId === "main")!;
  expect(main.jobs).toHaveLength(2);
  expect(main.jobs.every(({ job }) => !job.enabled)).toBe(true);
  expect(plan.agents.some((agent) => agent.agentId === "untouched")).toBe(false);
  await applyHeartbeatRetirement(plan, plan.config);
  expect(
    (await loadCronJobsStore(f.storePath)).jobs
      .filter((job) => job.agentId === "main")
      .every((job) => !job.enabled),
  ).toBe(true);
});

it.each(["showOk", "useIndicator"] as const)(
  "retains explicit unsupported %s settings before preparation",
  async (setting) => {
    const f = await fixture([]);
    f.cfg.channels = { defaults: { heartbeatVisibility: { [setting]: true } } };
    await expect(f.prepare()).rejects.toThrow("no ordinary cron equivalent");
    await expect(fs.stat(resolveOpenClawStateSqlitePath(f.env))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("retains the claimed inode when archiving across filesystems fails", async () => {
  const f = await fixture([]);
  await fs.writeFile(f.heartbeatPath, "Original instructions");
  const source = (await readHeartbeatSource(f.cfg, "main", { env: f.env }))!;
  await archiveHeartbeatSource({ source, agentId: "main", env: f.env });
  const writer = await fs.open(f.heartbeatPath, "r+");
  try {
    const claim = await claimHeartbeatSource(source);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(
      Object.assign(new Error("different filesystem"), { code: "EXDEV" }),
    );
    await expect(
      claim.release({ archivePath: archivePathForSource("main", source.sha256, f.env) }),
    ).rejects.toMatchObject({ code: "EXDEV" });
    await writer.truncate(0);
    await writer.writeFile("Late operator instructions");
    await claim.restore(undefined);
    expect(await fs.readFile(f.heartbeatPath, "utf8")).toBe("Late operator instructions");
  } finally {
    await writer.close();
  }
});

it.each(["runningAtMs", "queuedAtMs"] as const)(
  "refuses cutover while a job has %s ownership",
  async (marker) => {
    const job = monitor();
    job.state[marker] = nowMs;
    const f = await fixture([job]);
    const before = await loadCronJobsStore(f.storePath);
    const plan = await f.prepare();
    await expect(applyHeartbeatRetirement(plan, plan.config)).rejects.toThrow(
      "changed during preparation",
    );
    expect(await loadCronJobsStore(f.storePath)).toEqual(before);
    expect(f.receipt()).toBeUndefined();
  },
);

it("preserves disabled enrollment, task overrides, tool policy, scratch and execution history", async () => {
  const task: CronStoredJob = {
    ...monitor("task"),
    name: "inbox",
    declarationKey: heartbeatTaskDeclarationKey("main", "inbox"),
    payload: { kind: "systemEvent", text: "Operator-edited prompt", toolsAllow: ["read"] },
    schedule: { kind: "every", everyMs: 9_000_000, anchorMs: 500 },
  };
  const original = monitor();
  original.enabled = false;
  const f = await fixture([original, task]);
  f.cfg.agents!.defaults!.heartbeat = {
    every: "0m",
    model: "openai/gpt-5.6-sol",
    lightContext: false,
  };
  f.cfg.agents!.defaults!.timeoutSeconds = 0;
  writeCronJobScratch({
    storePath: f.storePath,
    jobId: original.id,
    content: tasks,
    expectedRevision: 0,
  });
  const plan = await f.prepare();
  await applyHeartbeatRetirement(plan, plan.config);
  const converted = (await loadCronJobsStore(f.storePath)).jobs;
  expect(converted.map((job) => job.id)).toEqual(["monitor", "task"]);
  expect(converted.every((job) => !job.enabled && job.payload.kind === "agentTurn")).toBe(true);
  expect(converted[0]?.schedule).toEqual(original.schedule);
  expect(converted[0]?.state).toEqual(original.state);
  expect(converted[1]).toMatchObject({
    schedule: task.schedule,
    state: task.state,
    payload: {
      kind: "agentTurn",
      message: "Operator-edited prompt",
      toolsAllow: ["read"],
      model: "openai/gpt-5.6-sol",
      lightContext: false,
      timeoutSeconds: 0,
    },
  });
  expect(f.scratch().scratch?.content).not.toContain("tasks:");
  await expect(completeHeartbeatRetirement(plan, f.cfg)).rejects.toThrow("still present");
  expect(f.receipt()?.phase).toBe("pending");
  await completeHeartbeatRetirement(plan, plan.config);
  expect(f.receipt()?.phase).toBe("complete");
});

it("rejects invalid tasks before committing any job, scratch, or receipt", async () => {
  const f = await fixture();
  const invalid = tasks.replace("interval: 1h", "interval: nonsense");
  writeCronJobScratch({
    storePath: f.storePath,
    jobId: "monitor",
    content: invalid,
    expectedRevision: 0,
  });
  const before = await loadCronJobsStore(f.storePath);
  const beforeScratch = f.scratch();
  await expect(f.prepare()).rejects.toThrow();
  expect(await loadCronJobsStore(f.storePath)).toEqual(before);
  expect(f.scratch()).toEqual(beforeScratch);
  expect(f.receipt()).toBeUndefined();
});

it.each(["default", "explicit"])(
  "uses heartbeat delivery without activating a stored %s task route",
  async (kind) => {
    const task: CronStoredJob = {
      ...monitor("task"),
      declarationKey: heartbeatTaskDeclarationKey("main", "inbox"),
      payload: { kind: "systemEvent", text: "Check inbox" },
      delivery:
        kind === "default"
          ? { mode: "none", failureDestination: { channel: "last" } }
          : { mode: "announce", channel: "telegram", to: "operator-target" },
    };
    const f = await fixture([monitor(), task]);
    const before = await loadCronJobsStore(f.storePath);
    if (kind === "explicit") {
      await expect(f.prepare()).rejects.toThrow("heartbeat never executed");
      expect(await loadCronJobsStore(f.storePath)).toEqual(before);
      expect(f.receipt()).toBeUndefined();
      return;
    }
    const plan = await f.prepare();
    const converted = plan.agents[0]!.jobs.find(({ job }) => job.id === "task")!;
    expect(converted.previous).toMatchObject({ delivery: task.delivery });
    expect(converted.job.delivery).toMatchObject({
      mode: "announce",
      target: "owner",
      failureDestination: task.delivery!.failureDestination,
    });
  },
);

it.each(["cadence", "window", "delivery", "empty fallbacks"])(
  "retains pending migration when repaired source changes %s",
  async (change) => {
    const f = await fixture();
    const plan = await f.prepare();
    await applyHeartbeatRetirement(plan, plan.config);
    const before = await loadCronJobsStore(f.storePath);
    const heartbeat = f.cfg.agents!.defaults!.heartbeat!;
    if (change === "cadence") {
      heartbeat.every = "2h";
    }
    if (change === "window") {
      heartbeat.activeHours = { start: "10:00", end: "12:00" };
    }
    if (change === "delivery") {
      heartbeat.directPolicy = "block";
    }
    if (change === "empty fallbacks") {
      f.cfg.agents!.list![0]!.model = { fallbacks: [] };
    }
    await expect(f.prepare()).rejects.toThrow("policy changed");
    expect(await loadCronJobsStore(f.storePath)).toEqual(before);
    expect(f.receipt()?.phase).toBe("pending");
  },
);

it.each(["config", "file"])(
  "retains newly introduced legacy %s after completed cutover",
  async (change) => {
    const f = await fixture();
    const plan = await f.prepare();
    await applyHeartbeatRetirement(plan, plan.config);
    await completeHeartbeatRetirement(plan, plan.config);
    const source = structuredClone(plan.config);
    if (change === "config") {
      source.agents!.defaults!.heartbeat = { every: "2h" };
    } else {
      await fs.writeFile(f.heartbeatPath, "New instructions");
    }
    const before = await loadCronJobsStore(f.storePath);
    await expect(f.prepare(source)).rejects.toThrow("legacy heartbeat intent");
    expect(await loadCronJobsStore(f.storePath)).toEqual(before);
    if (change === "file") {
      expect(await fs.readFile(f.heartbeatPath, "utf8")).toBe("New instructions");
    }
  },
);

it.each(["job", "scratch"])(
  "preserves an intervening destination %s edit on retry",
  async (change) => {
    const f = await fixture();
    const plan = await f.prepare();
    await applyHeartbeatRetirement(plan, plan.config);
    if (change === "job") {
      const store = await loadCronJobsStore(f.storePath);
      store.jobs[0]!.name = "Operator edit";
      await saveCronJobsStore(f.storePath, store);
    } else {
      writeCronJobScratch({
        storePath: f.storePath,
        jobId: "monitor",
        content: "Operator edit",
        expectedRevision: 0,
      });
    }
    await expect(f.prepare()).rejects.toThrow("changed during pending");
    await expect(completeHeartbeatRetirement(plan, plan.config)).rejects.toThrow(
      "changed during pending",
    );
    expect(f.receipt()?.phase).toBe("pending");
  },
);

it("archives a leftover file without reviving an explicit scratch tombstone", async () => {
  const f = await fixture();
  writeCronJobScratch({
    storePath: f.storePath,
    jobId: "monitor",
    content: "Removed checklist",
    expectedRevision: 0,
  });
  writeCronJobScratch({
    storePath: f.storePath,
    jobId: "monitor",
    content: null,
    expectedRevision: 1,
  });
  await fs.writeFile(f.heartbeatPath, tasks);
  const plan = await f.prepare();
  await applyHeartbeatRetirement(plan, plan.config);
  expect(f.scratch()).toEqual({ currentRevision: 2 });
  expect((await loadCronJobsStore(f.storePath)).jobs).toHaveLength(1);
  await expect(fs.stat(f.heartbeatPath)).rejects.toMatchObject({ code: "ENOENT" });
  const archiveDir = path.join(f.root, "backups", "heartbeat-migration");
  const archives = await fs.readdir(archiveDir, { withFileTypes: true });
  expect(
    await fs.readFile(
      path.join(archiveDir, archives.find((entry) => entry.isFile())!.name),
      "utf8",
    ),
  ).toBe(tasks);
  await completeHeartbeatRetirement(plan, plan.config);
});

it("preserves source bytes and all database rows when the file changes after preparation", async () => {
  const f = await fixture();
  await fs.writeFile(f.heartbeatPath, tasks);
  const plan = await f.prepare();
  const before = await loadCronJobsStore(f.storePath);
  await fs.writeFile(f.heartbeatPath, "New operator instructions");
  await expect(applyHeartbeatRetirement(plan, plan.config)).rejects.toThrow(
    "changed during preparation",
  );
  expect(await fs.readFile(f.heartbeatPath, "utf8")).toBe("New operator instructions");
  expect(await loadCronJobsStore(f.storePath)).toEqual(before);
  expect(f.receipt()).toBeUndefined();
});

it("resumes after the exact final Doctor config was written, then remembers permanent deletion", async () => {
  const f = await fixture();
  const plan = await f.prepare();
  const finalConfig = { ...plan.config, logging: { level: "warn" as const } };
  await applyHeartbeatRetirement(plan, finalConfig);
  await expect(completeHeartbeatRetirement(plan, plan.config)).rejects.toThrow(
    "differs from the final",
  );
  const retry = await f.prepare(finalConfig);
  await applyHeartbeatRetirement(retry, finalConfig);
  await completeHeartbeatRetirement(retry, finalConfig);
  await saveCronJobsStore(f.storePath, { version: 1, jobs: [] });
  const afterDeletion = await f.prepare(finalConfig);
  expect(afterDeletion.agents).toEqual([]);
  expect(f.receipt()?.jobId).toBe("monitor");
});

it("matches the persisted JSON projection when a candidate contains undefined properties", async () => {
  const f = await fixture();
  const plan = await f.prepare();
  const finalConfig = { ...plan.config, logging: undefined };
  await applyHeartbeatRetirement(plan, finalConfig);
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise the persisted JSON shape, which omits undefined fields.
  const persisted = JSON.parse(JSON.stringify(finalConfig)) as OpenClawConfig;
  await expect(completeHeartbeatRetirement(plan, persisted)).resolves.toBeUndefined();
  expect(f.receipt()?.phase).toBe("complete");
});

it("keeps duplicate monitor IDs and scratch while enabling only the current reconciler winner", async () => {
  const older = monitor("older");
  const newer = monitor();
  newer.updatedAtMs++;
  const f = await fixture([older, newer]);
  writeCronJobScratch({
    storePath: f.storePath,
    jobId: "older",
    content: "Earlier checklist",
    expectedRevision: 0,
  });
  const plan = await f.prepare();
  await applyHeartbeatRetirement(plan, plan.config);
  const store = await loadCronJobsStore(f.storePath);
  expect(store.jobs.find((job) => job.id === "older")).toMatchObject({
    enabled: false,
    state: older.state,
  });
  expect(store.jobs.find((job) => job.id === "monitor")).toMatchObject({
    enabled: true,
    state: newer.state,
  });
  expect(readCronJobScratchState(f.storePath, "older").scratch?.content).toBe("Earlier checklist");
  expect(f.receipt()?.jobId).toBe("monitor");
});

it("uses current enrollment for a stale disabled monitor without enabling a disabled task", async () => {
  const stale = { ...monitor(), enabled: false };
  const task: CronStoredJob = {
    ...monitor("disabled-task"),
    enabled: false,
    declarationKey: heartbeatTaskDeclarationKey("main", "inbox"),
    payload: { kind: "systemEvent", text: "Check inbox" },
  };
  const f = await fixture([stale, task]);
  const plan = await f.prepare();
  await applyHeartbeatRetirement(plan, plan.config);
  const { jobs } = await loadCronJobsStore(f.storePath);
  expect(jobs.find((job) => job.id === stale.id)?.enabled).toBe(true);
  expect(jobs.find((job) => job.id === task.id)?.enabled).toBe(false);
});

it.each(["present", "absent"])(
  "rejects differing reads of an initially %s shared heartbeat source",
  async (initial) => {
    const f = await fixture();
    const workspace = path.dirname(f.heartbeatPath);
    f.cfg.agents!.list = [
      { id: "main", workspace },
      { id: "ops", workspace },
    ];
    if (initial === "present") {
      await fs.writeFile(f.heartbeatPath, tasks);
    }
    const before = await loadCronJobsStore(f.storePath);
    let read = false;
    const readSource = readHeartbeatSource;
    vi.spyOn(
      await import("./doctor-heartbeat-scratch-migration.js"),
      "readHeartbeatSource",
    ).mockImplementation(async (...args) => {
      const source = await readSource(...args);
      if (!read) {
        read = true;
        await fs.writeFile(f.heartbeatPath, "New operator checklist");
      }
      return source;
    });
    await expect(f.prepare().then(() => undefined)).rejects.toThrow("heartbeat source changed");
    expect(await loadCronJobsStore(f.storePath)).toEqual(before);
    expect(f.receipt()).toBeUndefined();
    expect(await fs.readFile(f.heartbeatPath, "utf8")).toBe("New operator checklist");
  },
);

it("retains a newly created source for an untouched owner at completion", async () => {
  const f = await fixture();
  delete f.cfg.agents!.defaults!.heartbeat;
  const untouchedWorkspace = path.join(f.root, "untouched");
  await fs.mkdir(untouchedWorkspace);
  f.cfg.agents!.list = [
    { id: "main", heartbeat: { every: "30m" } },
    { id: "untouched", workspace: untouchedWorkspace },
  ];
  const plan = await f.prepare();
  expect(plan.agents.map(({ agentId }) => agentId)).toEqual(["main"]);
  await applyHeartbeatRetirement(plan, plan.config);
  const sourcePath = path.join(untouchedWorkspace, "HEARTBEAT.md");
  await fs.writeFile(sourcePath, "New untouched-owner instructions");
  const before = await loadCronJobsStore(f.storePath);
  await expect(completeHeartbeatRetirement(plan, plan.config)).rejects.toThrow(
    "heartbeat source remains",
  );
  expect(await loadCronJobsStore(f.storePath)).toEqual(before);
  expect(f.receipt()?.phase).toBe("pending");
  expect(await fs.readFile(sourcePath, "utf8")).toBe("New untouched-owner instructions");
});

it.each(["apply", "complete"])(
  "rejects canonical partition drift across %s filesystem awaits",
  async (operation) => {
    const f = await fixture();
    await fs.writeFile(f.heartbeatPath, tasks);
    const plan = await f.prepare();
    if (operation === "complete") {
      await applyHeartbeatRetirement(plan, plan.config);
    }
    const before = await loadCronJobsStore(f.storePath);
    const changePartition = () =>
      writeConfigMachineState("cron.store", path.join(f.root, "new-jobs.json"), { env: f.env });
    const sourceModule = await import("./doctor-heartbeat-scratch-migration.js");
    if (operation === "apply") {
      const archiveSource = archiveHeartbeatSource;
      vi.spyOn(sourceModule, "archiveHeartbeatSource").mockImplementation(async (...args) => {
        await archiveSource(...args);
        changePartition();
      });
    } else {
      const readSource = readHeartbeatSource;
      vi.spyOn(sourceModule, "readHeartbeatSource").mockImplementation(async (...args) => {
        const source = await readSource(...args);
        changePartition();
        return source;
      });
    }
    await expect(
      operation === "apply"
        ? applyHeartbeatRetirement(plan, plan.config)
        : completeHeartbeatRetirement(plan, plan.config),
    ).rejects.toThrow("source selection changed");
    expect(await loadCronJobsStore(f.storePath)).toEqual(before);
    if (operation === "apply") {
      expect(f.receipt()).toBeUndefined();
      expect(await fs.readFile(f.heartbeatPath, "utf8")).toBe(tasks);
    } else {
      expect(f.receipt()?.phase).toBe("pending");
    }
  },
);

it.each([
  { operation: "prepare", kind: "monitor" },
  { operation: "prepare", kind: "task" },
  { operation: "complete", kind: "monitor" },
  { operation: "complete", kind: "task" },
])("rejects a new legacy $kind during pending $operation", async ({ operation, kind }) => {
  const f = await fixture();
  const plan = await f.prepare();
  await applyHeartbeatRetirement(plan, plan.config);
  const store = await loadCronJobsStore(f.storePath);
  const added = monitor("new-legacy-job");
  if (kind === "task") {
    added.declarationKey = heartbeatTaskDeclarationKey("main", "inbox");
    added.payload = { kind: "systemEvent", text: "New instructions" };
  }
  store.jobs.push(added);
  await saveCronJobsStore(f.storePath, store);
  const before = await loadCronJobsStore(f.storePath);
  await expect(
    operation === "prepare"
      ? f.prepare().then(() => undefined)
      : completeHeartbeatRetirement(plan, plan.config),
  ).rejects.toThrow("Legacy automation");
  expect(await loadCronJobsStore(f.storePath)).toEqual(before);
  expect(f.receipt()?.phase).toBe("pending");
});

it.each(["before", "after"])(
  "rejects canonical partition drift %s source release without approving the config write",
  async (stage) => {
    const f = await fixture();
    await fs.writeFile(f.heartbeatPath, tasks);
    const plan = await f.prepare();
    const claimSource = claimHeartbeatSource;
    const changePartition = () =>
      writeConfigMachineState("cron.store", path.join(f.root, "new-jobs.json"), { env: f.env });
    vi.spyOn(
      await import("./doctor-heartbeat-scratch-migration.js"),
      "claimHeartbeatSource",
    ).mockImplementation(async (...args) => {
      const claim = await claimSource(...args);
      return {
        ...claim,
        release: async (params) => {
          if (stage === "before") {
            changePartition();
          }
          await claim.release(params);
          if (stage === "after") {
            changePartition();
          }
        },
      };
    });
    await expect(applyHeartbeatRetirement(plan, plan.config)).rejects.toThrow(
      "source selection changed",
    );
    expect(f.receipt()?.phase).toBe("pending");
    expect((await loadCronJobsStore(f.storePath)).jobs[0]?.payload.kind).toBe("agentTurn");
    expect(
      (await loadCronJobsStore(resolveCronJobsStorePathFromConfig(f.cfg, f.env))).jobs,
    ).toEqual([]);
    if (stage === "before") {
      expect(await fs.readFile(f.heartbeatPath, "utf8")).toBe(tasks);
    } else {
      await expect(fs.stat(f.heartbeatPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);

it.each(["workspace", "session store", "cron partition", "agent roster"])(
  "rejects changed %s selection before retiring the prepared source",
  async (selection) => {
    const f = await fixture();
    await fs.writeFile(f.heartbeatPath, tasks);
    const plan = await f.prepare();
    const candidate = structuredClone(plan.config);
    if (selection === "workspace") {
      const workspace = path.join(f.root, "new-workspace");
      await fs.mkdir(workspace);
      await fs.writeFile(path.join(workspace, "HEARTBEAT.md"), "Unimported instructions");
      candidate.agents!.defaults!.workspace = workspace;
    } else if (selection === "session store") {
      candidate.session = { store: path.join(f.root, "new-sessions.sqlite") };
    } else if (selection === "cron partition") {
      writeConfigMachineState("cron.store", path.join(f.root, "new-jobs.json"), { env: f.env });
    } else {
      candidate.agents!.list = [{ id: "other" }];
    }
    const before = await loadCronJobsStore(f.storePath);
    await expect(applyHeartbeatRetirement(plan, candidate)).rejects.toThrow(
      "source selection changed",
    );
    expect(await loadCronJobsStore(f.storePath)).toEqual(before);
    expect(f.receipt()).toBeUndefined();
    expect(await fs.readFile(f.heartbeatPath, "utf8")).toBe(tasks);
  },
);

it.each(["before apply", "during claims"])(
  "rejects a previously absent source appearing %s without committing a pending cutover",
  async (phase) => {
    const f = await fixture();
    const otherWorkspace = path.join(f.root, "other-workspace");
    await fs.mkdir(otherWorkspace);
    f.cfg.agents!.list = [
      { id: "main", workspace: path.dirname(f.heartbeatPath) },
      { id: "other", workspace: otherWorkspace },
    ];
    const otherSourcePath = path.join(otherWorkspace, "HEARTBEAT.md");
    await fs.writeFile(otherSourcePath, "Other instructions");
    const plan = await f.prepare();
    const before = await loadCronJobsStore(f.storePath);
    if (phase === "before apply") {
      await fs.writeFile(f.heartbeatPath, "New instructions");
    } else {
      const archiveSource = archiveHeartbeatSource;
      vi.spyOn(
        await import("./doctor-heartbeat-scratch-migration.js"),
        "archiveHeartbeatSource",
      ).mockImplementation(async (...args) => {
        await archiveSource(...args);
        await fs.writeFile(f.heartbeatPath, "New instructions");
      });
    }
    await expect(applyHeartbeatRetirement(plan, plan.config)).rejects.toThrow(
      "heartbeat source remains",
    );
    expect(await loadCronJobsStore(f.storePath)).toEqual(before);
    expect(f.receipt()).toBeUndefined();
    expect(await fs.readFile(f.heartbeatPath, "utf8")).toBe("New instructions");
    expect(await fs.readFile(otherSourcePath, "utf8")).toBe("Other instructions");
  },
);

it("rejects a retargeted shared owner's alias even when another owner holds the source claim", async () => {
  const f = await fixture();
  const original = path.dirname(f.heartbeatPath);
  const replacement = path.join(f.root, "replacement");
  const alias = path.join(f.root, "alias");
  await fs.mkdir(replacement);
  await fs.symlink(original, alias, "dir");
  await fs.writeFile(f.heartbeatPath, tasks);
  await fs.writeFile(path.join(replacement, "HEARTBEAT.md"), tasks);
  f.cfg.agents!.list = [
    { id: "main", workspace: alias },
    { id: "other", workspace: original },
  ];
  const plan = await f.prepare();
  expect(plan.sources).toHaveLength(1);
  expect(plan.sources[0]?.agentId).toBe("other");
  const before = await loadCronJobsStore(f.storePath);
  await fs.unlink(alias);
  await fs.symlink(replacement, alias, "dir");
  await expect(applyHeartbeatRetirement(plan, plan.config)).rejects.toThrow(
    "source selection changed",
  );
  expect(await loadCronJobsStore(f.storePath)).toEqual(before);
  expect(f.receipt()).toBeUndefined();
  expect(await fs.readFile(f.heartbeatPath, "utf8")).toBe(tasks);
  expect(await fs.readFile(path.join(replacement, "HEARTBEAT.md"), "utf8")).toBe(tasks);
});

it.each([
  "timeout",
  "removed timeout",
  "default model",
  "agent model",
  "empty fallbacks",
  "timezone",
])("rejects inherited %s drift in the final Doctor candidate", async (field) => {
  const f = await fixture();
  f.cfg.agents!.defaults!.timeoutSeconds = 60;
  f.cfg.agents!.defaults!.model = {
    primary: "openai/gpt-5.6-luna",
    fallbacks: ["openai/gpt-5.6-sol"],
  };
  f.cfg.agents!.defaults!.userTimezone = "UTC";
  await fs.writeFile(f.heartbeatPath, tasks);
  const plan = await f.prepare();
  const candidate = structuredClone(plan.config);
  const defaults = candidate.agents!.defaults!;
  if (field === "timeout") {
    defaults.timeoutSeconds = 300;
  } else if (field === "removed timeout") {
    delete defaults.timeoutSeconds;
  } else if (field === "default model") {
    defaults.model = "openai/gpt-5.6-sol";
  } else if (field === "agent model") {
    candidate.agents!.list![0]!.model = "openai/gpt-5.6-sol";
  } else if (field === "empty fallbacks") {
    candidate.agents!.list![0]!.model = { fallbacks: [] };
  } else {
    defaults.userTimezone = "America/New_York";
  }
  const before = await loadCronJobsStore(f.storePath);
  await expect(applyHeartbeatRetirement(plan, candidate)).rejects.toThrow("policy changed");
  expect(await loadCronJobsStore(f.storePath)).toEqual(before);
  expect(f.receipt()).toBeUndefined();
  expect(await fs.readFile(f.heartbeatPath, "utf8")).toBe(tasks);
});

it.each([false, true])(
  "accepts unchanged effective defaults (materialized: %s)",
  async (materialized) => {
    const f = await fixture();
    const effective = structuredClone(f.cfg);
    effective.agents!.defaults!.timeoutSeconds = 60;
    effective.agents!.defaults!.model = {
      primary: "openai/gpt-5.6-luna",
      fallbacks: ["openai/gpt-5.6-sol"],
    };
    effective.agents!.defaults!.userTimezone = "UTC";
    effective.agents!.list![0]!.model = { fallbacks: [] };
    const plan = await f.prepare(f.cfg, effective);
    const candidate = structuredClone(plan.config);
    if (materialized) {
      candidate.agents!.defaults = { ...effective.agents!.defaults, heartbeat: undefined };
      candidate.agents!.list = effective.agents!.list;
    }
    candidate.logging = { level: "warn" };
    await applyHeartbeatRetirement(plan, candidate);
    await completeHeartbeatRetirement(plan, candidate);
    expect(f.receipt()?.phase).toBe("complete");
    expect((await loadCronJobsStore(f.storePath)).jobs[0]?.payload).toMatchObject({
      timeoutSeconds: 60,
    });
  },
);

it("allows a global timeout edit when heartbeat has an explicit timeout", async () => {
  const f = await fixture();
  f.cfg.agents!.defaults!.timeoutSeconds = 60;
  f.cfg.agents!.defaults!.heartbeat!.timeoutSeconds = 120;
  const plan = await f.prepare();
  const candidate = structuredClone(plan.config);
  candidate.agents!.defaults!.timeoutSeconds = 300;
  await applyHeartbeatRetirement(plan, candidate);
  await completeHeartbeatRetirement(plan, candidate);
  expect((await loadCronJobsStore(f.storePath)).jobs[0]?.payload).toMatchObject({
    timeoutSeconds: 120,
  });
});

it.each(["omitted", "retired"])(
  "rejects a %s source created during final archive release",
  async (phase) => {
    const f = await fixture();
    const other = path.join(f.root, "other");
    await fs.mkdir(other);
    if (phase === "retired") {
      await fs.writeFile(f.heartbeatPath, "Original instructions");
    }
    await fs.writeFile(path.join(other, "HEARTBEAT.md"), "Other instructions");
    f.cfg.agents!.list = [
      { id: "main", workspace: path.dirname(f.heartbeatPath) },
      { id: "other", workspace: other },
    ];
    const entry = path.join(await fs.realpath(path.dirname(f.heartbeatPath)), "HEARTBEAT.md");
    const plan = await f.prepare();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (
        String(to).includes("heartbeat-migration") &&
        path.basename(String(to)) === "HEARTBEAT.md" &&
        (phase === "omitted" || String(from).startsWith(entry))
      ) {
        await fs.writeFile(f.heartbeatPath, "New instructions");
      }
    });
    const result = await applyHeartbeatRetirement(plan, plan.config).catch(
      (error: unknown) => error,
    );
    expect(await fs.readFile(f.heartbeatPath, "utf8")).toBe("New instructions");
    expect(result).toMatchObject({ message: expect.stringContaining("heartbeat source remains") });
    expect(f.receipt()?.phase).toBe("pending");
  },
);

it("retains the recorded source location across an interrupted retry and empty alias retarget", async () => {
  const f = await fixture();
  const original = path.dirname(f.heartbeatPath);
  const empty = path.join(f.root, "empty");
  const alias = path.join(f.root, "alias");
  await fs.mkdir(empty);
  await fs.symlink(original, alias, "dir");
  f.cfg.agents!.list = [{ id: "main", workspace: alias }];
  await fs.writeFile(f.heartbeatPath, tasks);
  const plan = await f.prepare();
  const rename = fs.rename.bind(fs);
  const fault = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (
      String(to).includes("heartbeat-migration") &&
      path.basename(String(to)) === "HEARTBEAT.md"
    ) {
      throw Object.assign(new Error("Different filesystem"), { code: "EXDEV" });
    }
    await rename(from, to);
  });
  await expect(applyHeartbeatRetirement(plan, plan.config)).rejects.toMatchObject({
    code: "EXDEV",
  });
  fault.mockRestore();
  const pending = f.receipt();
  expect(pending?.phase).toBe("pending");
  const before = await loadCronJobsStore(f.storePath);
  await fs.unlink(alias);
  await fs.symlink(empty, alias, "dir");
  await expect(f.prepare()).rejects.toThrow("heartbeat file changed");
  expect(f.receipt()).toEqual(pending);
  expect(await loadCronJobsStore(f.storePath)).toEqual(before);
  expect(await fs.readFile(f.heartbeatPath, "utf8")).toBe(tasks);
  await fs.unlink(alias);
  await fs.symlink(original, alias, "dir");
  const retry = await f.prepare();
  await applyHeartbeatRetirement(retry, retry.config);
  await completeHeartbeatRetirement(retry, retry.config);
  expect(f.receipt()?.phase).toBe("complete");
});

it.each(["inherited", "heartbeat", "agent override", "unused", "empty fallback override"])(
  "pins consumed model alias bindings while allowing %s controls",
  async (kind) => {
    const f = await fixture();
    f.cfg.agents!.defaults!.model = kind === "heartbeat" ? "openai/gpt-5.6-luna" : "fast";
    f.cfg.agents!.defaults!.models = { "openai/gpt-5.6-luna": { alias: "fast" } };
    if (kind === "heartbeat") {
      f.cfg.agents!.defaults!.heartbeat!.model = "fast";
    }
    if (kind === "agent override") {
      f.cfg.agents!.list![0]!.models = { "openai/gpt-5.6-luna": { alias: "fast" } };
    }
    if (kind === "empty fallback override") {
      f.cfg.agents!.defaults!.model = { primary: "fast", fallbacks: ["fast"] };
      f.cfg.agents!.list![0]!.model = { primary: "openai/gpt-5.6-luna", fallbacks: [] };
    }
    const route = (cfg: OpenClawConfig) =>
      resolveModelRefFromString({
        cfg,
        agentId: "main",
        raw: "fast",
        defaultProvider: "openai",
        aliasIndex: buildModelAliasIndex({ cfg, agentId: "main", defaultProvider: "openai" }),
      })?.ref;
    const plan = await f.prepare();
    const candidate = structuredClone(plan.config);
    candidate.agents!.defaults!.models =
      kind === "unused"
        ? { ...candidate.agents!.defaults!.models, "openai/gpt-5.6-sol": { alias: "unused" } }
        : { "openai/gpt-5.6-sol": { alias: "fast" } };
    const changed = kind === "inherited" || kind === "heartbeat";
    if (changed) {
      expect(route(f.cfg)).not.toEqual(route(candidate));
      const before = await loadCronJobsStore(f.storePath);
      await expect(applyHeartbeatRetirement(plan, candidate)).rejects.toThrow("policy changed");
      expect(await loadCronJobsStore(f.storePath)).toEqual(before);
      expect(f.receipt()).toBeUndefined();
    } else {
      if (kind !== "empty fallback override") {
        expect(route(f.cfg)).toEqual(route(candidate));
      }
      await applyHeartbeatRetirement(plan, candidate);
      await completeHeartbeatRetirement(plan, candidate);
      expect(f.receipt()?.phase).toBe("complete");
    }
  },
);
