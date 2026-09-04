import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const source = "a".repeat(40);
type Step = { name: string; run?: string; if?: string; "continue-on-error"?: boolean };
const publisher = parse(readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8"));
const request = parse(readFileSync(".github/workflows/linux-app-release-request.yml", "utf8"));

describe.skipIf(process.platform === "win32")("Linux producer handoff boundaries", () => {
  it.each([
    { tag: "v2026.9.1", fail: false, count: 1, code: 0 },
    { tag: "v2026.9.1-beta.1", fail: false, count: 0, code: 0 },
    { tag: "v2026.9.1", fail: true, count: 1, code: 42 },
  ])(
    "emits one source-bound event ($tag, transport failure=$fail)",
    ({ tag, fail, count, code }) => {
      const job = publisher.jobs.linux_handoff;
      const steps = job.steps as Step[];
      // GHA job-level advisory semantics preserve the parent conclusion, while
      // raw failed step status remains available to failure() diagnostics.
      expect(job["continue-on-error"]).toBe(true);
      for (const sibling of ["qualify_android_native", "publish_android", "publish_windows"]) {
        expect(publisher.jobs[sibling]["continue-on-error"]).toBe(true);
      }
      const postpublish = parse(
        readFileSync(".github/workflows/plugin-clawhub-postpublish.yml", "utf8"),
      );
      expect(postpublish.jobs.verify.if).toContain(
        "github.event.workflow_run.conclusion == 'success'",
      );
      const prepare = steps.find((step) => step.name === "Record detached Linux release intent")!;
      const upload = steps.findIndex(
        (step) => step.name === "Upload detached Linux release intent",
      );
      const dispatch = steps.find(
        (step) => step.name === "Start detached Linux release automation",
      )!;
      expect(dispatch["continue-on-error"]).toBeUndefined();
      const report = steps.find((step) => step.name === "Report failed Linux handoff")!;
      expect(report.if).toBe("failure()");
      expect(upload).toBeGreaterThan(steps.indexOf(prepare));
      expect(upload).toBeLessThan(steps.indexOf(dispatch));
      // Handoff failure is not a new prerequisite of Windows or core publication.
      expect(publisher.jobs.publish_windows.needs).not.toContain("linux_handoff");
      expect(publisher.jobs.finalize_github_release.needs).not.toContain("linux_handoff");
      const root = dirs.make("linux-event-");
      const bin = join(root, "bin");
      mkdirSync(bin);
      const output = join(root, "posts.jsonl");
      writeFileSync(output, "");
      writeFileSync(
        join(bin, "gh"),
        "#!" +
          process.execPath +
          "\n" +
          [
            'const fs = require("node:fs"); let input = "";',
            'process.stdin.setEncoding("utf8"); process.stdin.on("data", value => { input += value; });',
            'process.stdin.on("end", () => {',
            'fs.appendFileSync(process.env.POSTS, JSON.stringify({args:process.argv.slice(2),body:JSON.parse(input)}) + "\\n");',
            'process.exitCode = process.env.FAIL_POST === "true" ? 42 : 0;',
            "});",
          ].join("\n"),
        { mode: 0o755 },
      );
      const env = {
        PATH: bin + ":/usr/bin:/bin",
        RUNNER_TEMP: root,
        GITHUB_STEP_SUMMARY: join(root, "summary.md"),
        POSTS: output,
        FAIL_POST: String(fail),
        MOCK_GH: join(bin, "gh"),
        RELEASE_TAG: tag,
        TARGET_SHA: source,
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ID: "10",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_WORKFLOW_SHA: source,
        GITHUB_REF: "refs/heads/main",
      };
      const prepared = spawnSync("bash", ["-e", "-o", "pipefail", "-c", prepare.run!], {
        env,
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(prepared.status, prepared.stderr).toBe(0);
      // Bind the fake transport explicitly: ambient launcher PATH rewriting
      // must never send a fixture request through the real authenticated CLI.
      const dispatchBody = 'gh() { "$MOCK_GH" "$@"; }\n' + dispatch.run!;
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", dispatchBody], {
        env,
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(result.status, result.stderr).toBe(code);
      if (fail) {
        const reported = spawnSync("bash", ["-e", "-o", "pipefail", "-c", report.run!], {
          env,
          encoding: "utf8",
          timeout: 5_000,
        });
        expect(reported.status, reported.stderr).toBe(0);
        expect(reported.stdout).toContain("::warning::");
        const summary = readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
        expect(summary).toContain("Release key: " + tag + "@" + source);
        expect(summary).toContain("Parent run: 10; attempt: 2");
        expect(summary).toContain("outcome may be uncertain");
        expect(summary).toContain("before manual recovery");
        expect(summary).toContain(
          "Do not repeat an uncertain POST or rerun the release campaign/E2E suite",
        );
      }
      const lines = readFileSync(output, "utf8").trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(count);
      if (count) {
        const [line] = lines;
        if (!line) {
          throw new Error("Expected one recorded event");
        }
        const posted = JSON.parse(line);
        expect(posted.args).toEqual([
          "api",
          "--method",
          "POST",
          "repos/openclaw/openclaw/dispatches",
          "--input",
          "-",
        ]);
        expect(posted.body).toEqual({
          event_type: "openclaw-linux-release",
          client_payload: JSON.parse(
            readFileSync(join(root, "linux-release-intent/intent.json"), "utf8"),
          ),
        });
        expect(posted.body.client_payload).toMatchObject({
          tag,
          sha: source,
          parentRunId: "10",
          parentRunAttempt: "2",
        });
      }
    },
  );
  it.each([
    { sha: "", parent: "", attempt: "", code: 0 },
    { sha: source, parent: "10", attempt: "2", code: 0 },
    { sha: source, parent: "10", attempt: "", code: 1 },
    { sha: source, parent: "", attempt: "2", code: 1 },
    { sha: "invalid", parent: "10", attempt: "2", code: 1 },
  ])(
    "preserves manual input and exact automatic tuple ($parent:$attempt)",
    ({ sha, parent, attempt, code }) => {
      const step = request.jobs.validate_request.steps[0] as Step;
      const result = spawnSync("bash", ["-c", step.run!], {
        env: {
          PATH: "/usr/bin:/bin",
          RELEASE_TAG: "v2026.9.1",
          EXPECTED_SHA: sha,
          PARENT_RUN_ID: parent,
          PARENT_RUN_ATTEMPT: attempt,
        },
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(result.status, result.stderr).toBe(code);
    },
  );
});
