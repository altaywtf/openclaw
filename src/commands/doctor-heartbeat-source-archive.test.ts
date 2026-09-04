import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDefaultProactiveJobReceipt } from "../cron/proactive-job-receipt.js";
import { readCronJobScratchState } from "../cron/scratch-store.js";
import { loadCronJobsStore, resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
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

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

async function fixture() {
  const root = tempDirs.make("openclaw-heartbeat-archive-");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const sourcePath = path.join(workspace, "HEARTBEAT.md");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const env = { ...process.env };
  const cfg: OpenClawConfig = {
    agents: {
      defaults: { workspace, heartbeat: { every: "30m" } },
      list: [{ id: "main", workspace }],
    },
  };
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  const prepare = () =>
    prepareHeartbeatRetirement({
      sourceConfig: cfg,
      effectiveConfig: cfg,
      env,
      nowMs: 2_000_000_000_000,
    });
  const read = async (recoverClaims = false) =>
    await readHeartbeatSource(cfg, "main", { env, recoverClaims });
  const claim = async () => {
    const source = (await read())!;
    await archiveHeartbeatSource({ source, agentId: "main", env });
    return {
      claim: await claimHeartbeatSource(source),
      archivePath: archivePathForSource("main", source.sha256, env),
    };
  };
  const archivedContents = async () => {
    const entries = await fs.readdir(path.join(root, "backups", "heartbeat-migration"), {
      recursive: true,
      withFileTypes: true,
    });
    return Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => fs.readFile(path.join(entry.parentPath, entry.name), "utf8")),
    );
  };
  return { root, env, cfg, storePath, prepare, sourcePath, read, claim, archivedContents };
}

it("treats a missing workspace as having no heartbeat source", async () => {
  const f = await fixture();
  await fs.rmdir(path.dirname(f.sourcePath));
  await expect(f.read()).resolves.toBeUndefined();
});

// Windows and root do not enforce these POSIX directory-listing permissions.
it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
  "surfaces an unreadable claim inventory while preserving the interrupted source",
  async () => {
    const f = await fixture();
    const workspace = path.dirname(f.sourcePath);
    const claimPath = `${f.sourcePath}.doctor-importing-${process.pid}-0123456789ab`;
    await fs.writeFile(claimPath, "Interrupted instructions");
    await expect(f.read()).rejects.toThrow("interrupted migration claim");
    await fs.chmod(workspace, 0o111);
    try {
      await expect(fs.lstat(f.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(workspace)).rejects.toMatchObject({ code: "EACCES" });
      await expect(f.read()).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await fs.chmod(workspace, 0o700);
    }
    expect(await fs.readFile(claimPath, "utf8")).toBe("Interrupted instructions");
  },
);

it("preserves every original inode when the same heartbeat bytes are imported again", async () => {
  const f = await fixture();
  const writers: Awaited<ReturnType<typeof fs.open>>[] = [];
  try {
    for (let occurrence = 0; occurrence < 2; occurrence++) {
      await fs.writeFile(f.sourcePath, "Same checklist");
      writers.push(await fs.open(f.sourcePath, "r+"));
      const { claim, archivePath } = await f.claim();
      await claim.release({ archivePath });
      await expect(fs.access(f.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    for (const [index, writer] of writers.entries()) {
      expect((await writer.stat()).nlink).toBeGreaterThan(0);
      await writer.truncate(0);
      await writer.writeFile(`Late edit ${index}`);
      await writer.sync();
    }
    expect(await f.archivedContents()).toEqual(
      expect.arrayContaining(["Late edit 0", "Late edit 1"]),
    );
  } finally {
    await Promise.all(writers.map((writer) => writer.close()));
  }
});

it.each(["before claiming", "while claimed"])(
  "preserves both entries when a workspace alias is retargeted %s",
  async (phase) => {
    const root = tempDirs.make("openclaw-heartbeat-alias-");
    const original = path.join(root, "original");
    const replacement = path.join(root, "replacement");
    const alias = path.join(root, "workspace");
    for (const workspace of [original, replacement]) {
      await fs.mkdir(workspace);
      await fs.writeFile(path.join(workspace, "HEARTBEAT.md"), "Same instructions");
    }
    await fs.symlink(original, alias, "dir");
    const cfg = { agents: { list: [{ id: "main", workspace: alias }] } };
    const env = { OPENCLAW_STATE_DIR: root };
    const source = (await readHeartbeatSource(cfg, "main", { env }))!;
    await archiveHeartbeatSource({ source, agentId: "main", env });
    const claim = phase === "while claimed" ? await claimHeartbeatSource(source) : undefined;
    await fs.unlink(alias);
    await fs.symlink(replacement, alias, "dir");
    if (claim) {
      await expect(
        claim.release({ archivePath: archivePathForSource("main", source.sha256, env) }),
      ).rejects.toThrow();
    } else {
      await expect(claimHeartbeatSource(source)).rejects.toThrow();
    }
    for (const workspace of [original, replacement]) {
      expect(await fs.readFile(path.join(workspace, "HEARTBEAT.md"), "utf8")).toBe(
        "Same instructions",
      );
    }
  },
);

it.each(["before", "after"])("recovers an interruption %s the archive rename", async (phase) => {
  const f = await fixture();
  await fs.writeFile(f.sourcePath, "Original checklist");
  const writer = await fs.open(f.sourcePath, "r+");
  try {
    const { claim, archivePath } = await f.claim();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
      if (phase === "after") {
        await rename(from, to);
      }
      throw new Error("Interrupted archive rename");
    });
    await expect(claim.release({ archivePath })).rejects.toThrow("Interrupted archive rename");
    const recovered = await f.read(true);
    expect(Boolean(recovered)).toBe(phase === "before");
    await writer.truncate(0);
    await writer.writeFile("Late edit after interruption");
    await writer.sync();
    if (phase === "before") {
      expect(await fs.readFile(f.sourcePath, "utf8")).toBe("Late edit after interruption");
    } else {
      expect(await f.archivedContents()).toContain("Late edit after interruption");
    }
  } finally {
    await writer.close();
  }
});

it.each(
  ["forward", "reverse", "indirect", "directory parent"].flatMap((direction) =>
    ["parent first", "child first"].map((order) => ({ direction, order })),
  ),
)(
  "retires $direction contained links and shared aliases with $order insertion",
  async ({ direction, order }) => {
    const f = await fixture();
    const outer = path.dirname(f.sourcePath);
    const inner = path.join(
      outer,
      ...(direction === "directory parent" ? ["0", "nested"] : ["child"]),
    );
    const alias = path.join(f.root, "outer-alias");
    await fs.mkdir(inner, { recursive: true });
    await fs.symlink(outer, alias, "dir");
    const linked = direction === "reverse" || direction === "indirect";
    const target = linked ? "checklist.md" : "HEARTBEAT.md";
    await fs.writeFile(path.join(inner, target), "Shared nested instructions");
    if (direction === "directory parent") {
      await fs.mkdir(path.join(outer, "0", "deep"));
      await fs.mkdir(path.join(outer, "nested"));
      await fs.writeFile(path.join(outer, "nested", "HEARTBEAT.md"), "Untouched decoy");
      await fs.symlink("0/deep", path.join(outer, "bridge"));
      await fs.symlink("bridge/../nested/HEARTBEAT.md", f.sourcePath);
    } else {
      await fs.symlink(`child/${target}`, f.sourcePath);
    }
    if (linked) {
      const link = direction === "reverse" ? "../HEARTBEAT.md" : "alias.md";
      if (direction === "indirect") {
        await fs.symlink("../HEARTBEAT.md", path.join(inner, "alias.md"));
      }
      await fs.symlink(link, path.join(inner, "HEARTBEAT.md"));
    }
    const entries = [
      { id: "main", workspace: outer },
      { id: "child", workspace: inner },
    ];
    f.cfg.agents!.list = [
      ...(order === "parent first" ? entries : entries.toReversed()),
      { id: "shared", workspace: alias },
    ];
    let plan = await f.prepare();
    expect(plan.sources).toHaveLength(2);
    if (direction === "forward" && order === "child first") {
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
      plan = await f.prepare();
    }
    await applyHeartbeatRetirement(plan, plan.config);
    await completeHeartbeatRetirement(plan, plan.config);
    const jobs = (await loadCronJobsStore(f.storePath)).jobs;
    expect(jobs).toHaveLength(3);
    for (const job of jobs) {
      expect(readCronJobScratchState(f.storePath, job.id, { env: f.env }).scratch?.content).toBe(
        "Shared nested instructions",
      );
      expect(readDefaultProactiveJobReceipt(f.storePath, job.agentId!, { env: f.env })?.phase).toBe(
        "complete",
      );
    }
    if (direction === "directory parent") {
      expect(await fs.readFile(path.join(outer, "nested", "HEARTBEAT.md"), "utf8")).toBe(
        "Untouched decoy",
      );
    }
    await expect(fs.lstat(f.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.join(inner, "HEARTBEAT.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
