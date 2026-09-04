import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runCiGitStep } from "./ci-git-owner.test-support.js";
import {
  createLinuxReleaseFixture as fixture,
  linuxReleaseTempDirs as dirs,
  linuxReleaseTag as tag,
  linuxReleaseSource as source,
  linuxReleaseTooling as tooling,
  linuxReleaseKey as key,
} from "./linux-release-auto.test-support.js";

describe.skipIf(process.platform === "win32")("release-keyed Linux automation", () => {
  it.each(["in_progress", "success", "failure"])(
    "starts outside the parent lock after finalization (%s)",
    async (status) => {
      const f = fixture();
      if (status !== "in_progress") {
        f.parent.status = "completed";
        f.parent.conclusion = status;
      }
      const result = await f.run();
      expect(result).toMatchObject({
        state: "builder-succeeded",
        assetsVerified: false,
        releaseKey: key,
        mutationAttempted: true,
        request: { runId: "30", parentRunId: "10", parentRunAttempt: "1" },
        builder: { runId: "40" },
      });
      expect(f.writes()).toHaveLength(1);
      expect(f.calls.some((args) => args.includes("cancel") || args.includes("rerun"))).toBe(false);
    },
  );
  it.each(["release/2026.9.1", "extended-stable/2026.9.33"])(
    "supports the canonically admitted direct parent branch %s",
    async (branch) => {
      const f = fixture();
      f.payload.parentWorkflowRef = "refs/heads/" + branch;
      f.parent.head_branch = branch;
      await expect(f.run()).resolves.toMatchObject({ state: "builder-succeeded" });
      expect(f.writes()).toHaveLength(1);
    },
  );
  it("rejects a supported parent branch that moved from its approved workflow SHA", async () => {
    const f = fixture();
    f.payload.parentWorkflowRef = "refs/heads/release/2026.9.1";
    f.parent.head_branch = "release/2026.9.1";
    f.state.branchSha = tooling;
    await expect(f.run()).rejects.toThrow("branch is missing or moved");
    expect(f.writes()).toEqual([]);
  });
  it("does not admit an arbitrary branch through the prevalidated-ref check", async () => {
    const f = fixture();
    f.payload.parentWorkflowRef = "refs/heads/not-a-release";
    f.parent.head_branch = "not-a-release";
    await expect(f.run()).rejects.toThrow("not a trusted direct");
    expect(f.writes()).toEqual([]);
  });
  it("refuses an immutable intent that differs from the repository event", async () => {
    const f = fixture();
    f.state.tamperIntent = true;
    await expect(f.run()).rejects.toThrow("intent does not match");
    expect(f.writes()).toEqual([]);
    expect(f.outcome()).toMatchObject({ state: "no-dispatch", mutationAttempted: false });
  });
  it("allows the first finalized parent attempt 2 when no earlier coordinator exists", async () => {
    const f = fixture();
    f.payload.parentRunAttempt = "2";
    f.parent.run_attempt = 2;
    await expect(f.run()).resolves.toMatchObject({
      state: "builder-succeeded",
      request: { parentRunAttempt: "2" },
    });
    expect(f.writes()).toHaveLength(1);
  });
  it.each(["same-parent", "new-parent"])(
    "adopts the same release key after %s delivery",
    async (delivery) => {
      const f = fixture();
      await f.run();
      const receipt = f.outcome();
      f.prior(20, 1, receipt);
      f.env.GITHUB_RUN_ID = "21";
      if (delivery === "new-parent") {
        f.payload.parentRunId = "11";
        f.parent.id = 11;
      }
      await expect(f.run()).resolves.toMatchObject({
        state: "builder-succeeded",
        mutationAttempted: false,
        parent: { parentRunId: delivery === "new-parent" ? "11" : "10" },
        request: { parentRunId: "10", parentRunAttempt: "1" },
      });
      expect(f.writes()).toHaveLength(1);
    },
  );
  it("permits a coordinator-only retry after an authenticated no-dispatch result", async () => {
    const f = fixture();
    f.state.finalized = false;
    await expect(f.run()).rejects.toThrow("finalization");
    expect(f.outcome()).toMatchObject({ state: "no-dispatch", mutationAttempted: false });
    f.prior(20, 1, f.outcome());
    f.env.GITHUB_RUN_ATTEMPT = "2";
    f.state.finalized = true;
    await expect(f.run()).resolves.toMatchObject({ state: "builder-succeeded" });
    expect(f.writes()).toHaveLength(1);
  });
  it.each(["missing", "uncertain", "cancelled", "wrong-sha", "wrong-key", "wrong-owner"])(
    "refuses replacement when a prior receipt is %s",
    async (fault) => {
      const f = fixture();
      const run = f.prior();
      const receipt = f.receipts.get("19:1")!;
      if (fault === "missing") {
        f.receipts.delete("19:1");
      }
      if (fault === "uncertain") {
        receipt.mutationAttempted = true;
        receipt.state = "dispatch-uncertain";
      }
      if (fault === "cancelled") {
        receipt.state = "cancelled";
      }
      if (fault === "wrong-sha") {
        receipt.workflowSha = source;
      }
      if (fault === "wrong-key") {
        receipt.releaseKey = "different";
      }
      if (fault === "wrong-owner") {
        run.path = ".github/workflows/other.yml";
      }
      await expect(f.run()).rejects.toThrow();
      expect(f.writes()).toEqual([]);
    },
  );
  it("does not let a later no-dispatch receipt hide an uncertain earlier attempt", async () => {
    const f = fixture();
    f.prior(19, 2);
    f.receipts.set("19:1", {
      ...f.receipts.get("19:2"),
      ownRunAttempt: "1",
      mutationAttempted: true,
      state: "dispatch-uncertain",
    });
    await expect(f.run()).rejects.toThrow("outcome unresolved");
    expect(f.writes()).toEqual([]);
  });
  it("adopts an exact request even when the earlier coordinator outcome is missing", async () => {
    const f = fixture();
    f.prior();
    f.receipts.clear();
    f.state.visible = true;
    await expect(f.run()).resolves.toMatchObject({
      mutationAttempted: false,
      state: "builder-succeeded",
    });
    expect(f.writes()).toEqual([]);
  });
  it.each(["legacy", "old-unbound-attempt", "duplicate", "changed-source"])(
    "blocks a %s same-tag request",
    async (fault) => {
      const f = fixture();
      f.state.visible = true;
      if (fault === "legacy") {
        f.request.display_title = "Linux App Release Request [" + tag + "] desktop=false";
      }
      if (fault === "old-unbound-attempt") {
        f.request.display_title = f.request.display_title.replace(":1", "");
      }
      if (fault === "duplicate") {
        f.state.duplicate = true;
      }
      if (fault === "changed-source") {
        f.request.display_title = f.request.display_title.replace(source, "c".repeat(40));
      }
      await expect(f.run()).rejects.toThrow();
      expect(f.writes()).toEqual([]);
    },
  );
  it("reconciles an accepted request whose POST response was lost", async () => {
    const f = fixture();
    f.state.ambiguous = true;
    await expect(f.run()).resolves.toMatchObject({ state: "builder-succeeded" });
    expect(f.writes()).toHaveLength(1);
  });
  it("exhausts ambiguous observations without replacing the request, including a new-parent delivery", async () => {
    const f = fixture();
    f.state.lost = true;
    await expect(f.run()).rejects.toThrow("observation budget");
    expect(f.state.sleeps).toBe(11);
    expect(f.outcome()).toMatchObject({ state: "dispatch-uncertain", mutationAttempted: true });
    f.prior(20, 1, f.outcome());
    f.env.GITHUB_RUN_ID = "21";
    f.payload.parentRunId = "11";
    f.parent.id = 11;
    await expect(f.run()).rejects.toThrow("outcome unresolved");
    expect(f.writes()).toHaveLength(1);
  });
  it("waits for exactly the returned request ID after 404 visibility lag", async () => {
    const f = fixture();
    f.state.first404 = true;
    await f.run();
    expect(f.state.sleeps).toBe(1);
    expect(f.writes()).toHaveLength(1);
  });
  it("refuses a changed ID from the exact response endpoint", async () => {
    const f = fixture();
    f.state.beforePost = () => {
      f.request.id = 31;
    };
    await expect(f.run()).rejects.toThrow("request ID changed");
    expect(f.writes()).toHaveLength(1);
  });
  it.each(["tag", "draft", "parent-attempt", "queued", "cancelled", "ancestry", "jobs"])(
    "stops on %s drift before dispatch",
    async (fault) => {
      const f = fixture();
      if (fault === "tag") {
        f.state.tagSha = tooling;
      }
      if (fault === "draft") {
        f.state.draft = true;
      }
      if (fault === "parent-attempt") {
        f.parent.run_attempt = 2;
      }
      if (fault === "queued") {
        f.parent.status = "queued";
      }
      if (fault === "cancelled") {
        f.parent.status = "completed";
        f.parent.conclusion = "cancelled";
      }
      if (fault === "ancestry") {
        f.state.ancestry = "diverged";
      }
      if (fault === "jobs") {
        f.state.malformedJobs = true;
      }
      await expect(f.run()).rejects.toThrow();
      expect(f.writes()).toEqual([]);
    },
  );
  it("checks live coordinator cancellation before the only request POST", async () => {
    const f = fixture();
    f.state.coordinatorCancelled = true;
    await expect(f.run()).rejects.toThrow("exact active run");
    expect(f.outcome()).toMatchObject({ state: "cancelled", mutationAttempted: false });
    expect(f.writes()).toEqual([]);
  });
  it("finds successful finalization beyond the first jobs page", async () => {
    const f = fixture();
    f.state.secondJobsPage = true;
    await f.run();
    expect(f.writes()).toHaveLength(1);
  });
  it.each(["failure", "cancelled"])(
    "adopts a %s builder without rerunning successful siblings",
    async (conclusion) => {
      const f = fixture();
      f.state.visible = true;
      f.builder.conclusion = conclusion;
      await expect(f.run()).rejects.toThrow("actions/runs/40");
      expect(f.writes()).toEqual([]);
    },
  );
  it("records cancellation during observation and leaves dispatched children unchanged", async () => {
    const f = fixture();
    f.builder.status = "in_progress";
    f.state.afterSleep = () => f.abort.abort(new Error("operator cancelled"));
    await expect(f.run()).rejects.toThrow("operator cancelled");
    expect(f.outcome()).toMatchObject({ state: "cancelled", mutationAttempted: true });
    expect(f.writes()).toHaveLength(1);
  });
  it("does not accept an advanced builder attempt or all-skipped publication as completion", async () => {
    const f = fixture();
    f.builder.status = "in_progress";
    f.state.afterSleep = () => {
      f.builder.run_attempt = 2;
      f.builder.status = "completed";
    };
    await expect(f.run()).rejects.toThrow("attempt/source changed");
    const skipped = fixture();
    skipped.state.published = false;
    await expect(skipped.run()).rejects.toThrow("skipped jobs are not completion");
  });
  it("executes the actual sparse-checkout CLI and gh boundary with no credentials", async () => {
    const f = fixture();
    await f.run();
    const root = dirs.make("linux-auto-cli-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const workflow = parse(readFileSync(".github/workflows/linux-app-release-auto.yml", "utf8"));
    const checkout = workflow.jobs.linux.steps.find(
      (step: { name: string }) => step.name === "Checkout trusted automation",
    );
    for (const file of checkout.with["sparse-checkout"].trim().split(/\s+/u)) {
      const destination = join(root, file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(file, destination);
    }
    const runtime = join(root, "runtime");
    mkdirSync(join(runtime, "linux-release-intent"), { recursive: true });
    copyFileSync(
      join(f.env.RUNNER_TEMP!, "linux-release-intent/intent.json"),
      join(runtime, "linux-release-intent/intent.json"),
    );
    const tape = join(root, "responses.json");
    const eventPath = join(root, "event.json");
    writeFileSync(
      tape,
      JSON.stringify(
        f.responses.map((entry) => ({
          ...entry,
          args: entry.args.map((arg) => arg.replace(f.env.RUNNER_TEMP!, runtime)),
        })),
      ),
    );
    writeFileSync(eventPath, JSON.stringify(f.event));
    writeFileSync(
      join(bin, "gh"),
      "#!" +
        process.execPath +
        "\n" +
        [
          'const fs = require("node:fs");',
          'const tape = JSON.parse(fs.readFileSync(process.env.RESPONSE_TAPE, "utf8"));',
          "const next = tape.shift();",
          "if (!next || JSON.stringify(next.args) !== JSON.stringify(process.argv.slice(2))) process.exit(97);",
          "fs.writeFileSync(process.env.RESPONSE_TAPE, JSON.stringify(tape));",
          "process.stdout.write(next.stdout);",
        ].join("\n"),
      { mode: 0o755 },
    );
    const result = spawnSync(process.execPath, ["scripts/linux-release-auto.mts"], {
      cwd: root,
      env: {
        ...f.env,
        RUNNER_TEMP: runtime,
        PATH: bin,
        HOME: root,
        RESPONSE_TAPE: tape,
        GITHUB_EVENT_PATH: eventPath,
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('"state":"builder-succeeded"');
    expect(result.stdout).toContain('"assetsVerified":false');
    expect(JSON.parse(readFileSync(tape, "utf8"))).toEqual([]);
  });
  it.each([
    undefined,
    ".github/workflows/linux-app-release.yml",
    "scripts/release-tooling-identity.mjs",
    "apps/linux/scripts",
  ])(
    "accepts unrelated main movement but not owned tooling drift: %s",
    async (changedPath) => {
      const builderSha = "f".repeat(40);
      const workflow = parse(readFileSync(".github/workflows/linux-app-release.yml", "utf8"));
      const requestStep = workflow.jobs.validate_release.steps.find(
        (step: { id?: string }) => step.id === "request",
      );
      const admissionOutput = join(dirs.make("linux-source-request-"), "output");
      const admission = spawnSync("bash", ["-e", "-o", "pipefail", "-c", requestStep.run], {
        env: {
          PATH: process.env.PATH,
          GITHUB_OUTPUT: admissionOutput,
          REQUEST_TITLE:
            "Linux App Release Request [" +
            tag +
            "] desktop=false source=" +
            source +
            " parent=10:1",
          REQUEST_HEAD_SHA: tooling,
          WORKFLOW_SHA: builderSha,
        },
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(admission.status, admission.stdout + admission.stderr).toBe(0);
      const expectedSha = readFileSync(admissionOutput, "utf8")
        .split("\n")
        .find((line) => line.startsWith("expected_sha="))
        ?.slice("expected_sha=".length);
      expect(expectedSha).toBe(source);
      if (!expectedSha) {
        throw new Error("Source-bound admission did not hand off its source");
      }
      const closure = [
        ".github/workflows/linux-app-release-request.yml",
        ".github/workflows/linux-app-release.yml",
        "scripts/lib/record-shared.mjs",
        "scripts/release-tooling-identity.mjs",
        "scripts/verify-release-tag-target.mjs",
        "apps/linux/src-tauri/tauri.conf.json",
        "apps/linux/scripts",
        "apps/linux/tests",
      ];
      const revisions = Object.fromEntries(
        closure.flatMap((path) => [
          [tooling + ":" + path, source],
          [builderSha + ":" + path, source],
        ]),
      );
      const report = await runCiGitStep({
        workflow: {
          file: ".github/workflows/linux-app-release.yml",
          job: "validate_release",
          step: "Ensure tag commit is reachable from its release branch",
        },
        fetchResults: [],
        env: {
          RELEASE_TAG: tag,
          EXPECTED_SHA: expectedSha,
          REQUEST_WORKFLOW_SHA: tooling,
          WORKFLOW_SHA: builderSha,
        },
        revisions: {
          ...revisions,
          ["refs/tags/" + tag + "^{commit}"]: source,
          ...(changedPath ? { [builderSha + ":" + changedPath]: "c".repeat(40) } : {}),
        },
      });
      expect(report.code, report.output).toBe(changedPath ? 1 : 0);
      expect(report.githubOutput).toBe(changedPath ? "" : "tag_sha=" + source + "\n");
      if (changedPath) {
        expect(report.output).toContain("Linux request tooling changed: " + changedPath);
      }
    },
    55_000,
  );
});
