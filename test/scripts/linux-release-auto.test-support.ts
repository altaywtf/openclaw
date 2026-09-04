import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import { parse } from "yaml";
import { runLinuxReleaseAuto } from "../../scripts/linux-release-auto.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const repo = "openclaw/openclaw";
const tag = "v2026.9.1";
const source = "a".repeat(40);
const tooling = "b".repeat(40);
const key = tag + "@" + source;
const autoTitle = "Linux App Release Auto [tag=" + tag + " source=" + source + "]";
const publisher = parse(readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8"));
type Run = {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  event: string;
  path: string;
  repository: { full_name: string };
  status: string;
  conclusion: string | null;
  display_title: string;
};
function runRecord(workflow: string, event: string, runId: number, title: string): Run {
  return {
    id: runId,
    run_attempt: 1,
    head_sha: tooling,
    head_branch: "main",
    event,
    path: ".github/workflows/" + workflow,
    repository: { full_name: repo },
    status: "completed",
    conclusion: "success",
    display_title: title,
  };
}
function fixture() {
  const payload = {
    tag,
    sha: source,
    parentRunId: "10",
    parentRunAttempt: "1",
    parentWorkflowSha: source,
    parentWorkflowRef: "refs/heads/main",
  };
  const event = { action: "openclaw-linux-release", client_payload: payload };
  const parent = runRecord(
    "openclaw-release-publish.yml",
    "workflow_dispatch",
    10,
    "OpenClaw Release Publish",
  );
  parent.head_sha = source;
  parent.status = "in_progress";
  parent.conclusion = null;
  const requestTitle = () =>
    "Linux App Release Request [" +
    tag +
    "] desktop=false source=" +
    source +
    " parent=" +
    payload.parentRunId +
    ":" +
    payload.parentRunAttempt;
  const request = runRecord(
    "linux-app-release-request.yml",
    "workflow_dispatch",
    30,
    requestTitle(),
  );
  const builder = runRecord(
    "linux-app-release.yml",
    "workflow_run",
    40,
    "Linux App Release [request=30:1]",
  );
  const state = {
    visible: false,
    ambiguous: false,
    lost: false,
    duplicate: false,
    finalized: true,
    published: true,
    malformedJobs: false,
    secondJobsPage: false,
    tamperIntent: false,
    tagSha: source,
    branchSha: source,
    draft: false,
    ancestry: "ahead",
    first404: false,
    reads404: 0,
    builderVisible: true,
    coordinatorVisible: true,
    coordinatorCancelled: false,
    sleeps: 0,
    afterSleep: () => {},
    beforePost: () => {},
  };
  const env: NodeJS.ProcessEnv = {
    GITHUB_REPOSITORY: repo,
    GITHUB_RUN_ID: "20",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_SHA: tooling,
    GITHUB_EVENT_NAME: "repository_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: repo + "/.github/workflows/linux-app-release-auto.yml@refs/heads/main",
  };
  const priorRuns: Run[] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const calls: string[][] = [];
  const responses: { args: string[]; stdout: string }[] = [];
  const abort = new AbortController();
  let root = "";
  const ownRun = () => ({
    ...runRecord(
      "linux-app-release-auto.yml",
      "repository_dispatch",
      Number(env.GITHUB_RUN_ID),
      autoTitle,
    ),
    run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
    status: "in_progress",
    conclusion: null,
  });
  const outcome = () =>
    JSON.parse(readFileSync(join(root, "linux-release-outcome/outcome.json"), "utf8")) as Record<
      string,
      unknown
    >;
  const respond = (args: string[], value: unknown) => {
    const stdout = value === undefined ? "" : JSON.stringify(value);
    responses.push({ args, stdout });
    return stdout;
  };
  const prior = (runId = 19, attempt = 1, change: Record<string, unknown> = {}) => {
    const run = {
      ...runRecord("linux-app-release-auto.yml", "repository_dispatch", runId, autoTitle),
      run_attempt: attempt,
    };
    priorRuns.push(run);
    const receipt = {
      kind: "linux-release-auto",
      version: 1,
      ownRunId: String(runId),
      ownRunAttempt: String(attempt),
      workflowSha: tooling,
      releaseKey: key,
      parent: { ...payload },
      mutationAttempted: false,
      state: "no-dispatch",
      assetsVerified: false,
      ...change,
    };
    receipts.set(runId + ":" + attempt, receipt);
    return run;
  };
  const runGh = (args: string[]) => {
    calls.push(args);
    if (args[0] === "run") {
      const name = args[args.indexOf("--name") + 1];
      const directory = args[args.indexOf("--dir") + 1];
      if (!name || !directory) {
        throw new Error("Fixture requires an exact named artifact and directory");
      }
      if (name.startsWith("linux-release-intent-")) {
        expect(name).toBe(
          "linux-release-intent-" + payload.parentRunId + "-" + payload.parentRunAttempt,
        );
      } else {
        const match = /^linux-release-outcome-([0-9]+)-([0-9]+)$/u.exec(name);
        const receipt = match && receipts.get(match[1] + ":" + match[2]);
        if (!receipt) {
          throw new Error("Prior outcome artifact missing");
        }
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "outcome.json"), JSON.stringify(receipt));
      }
      return respond(args, undefined);
    }
    const target = args[1];
    if (!target) {
      throw new Error("Fixture requires an API endpoint");
    }
    const endpoint = target.replace("repos/" + repo + "/", "");
    if (args.includes("POST")) {
      expect(endpoint).toBe("actions/workflows/linux-app-release-request.yml/dispatches");
      expect(args).toEqual(
        expect.arrayContaining([
          "X-GitHub-Api-Version: 2026-03-10",
          "ref=main",
          "inputs[tag]=" + tag,
          "inputs[expected_sha]=" + source,
          "inputs[desktop-test-bundles]=false",
          "inputs[release_publish_run_id]=" + payload.parentRunId,
          "inputs[release_publish_run_attempt]=" + payload.parentRunAttempt,
        ]),
      );
      // A transport failure must leave a positive mutation marker, not a stale
      // no-dispatch receipt that would permit another coordinator to retry it.
      expect(outcome()).toMatchObject({ mutationAttempted: true, state: "dispatch-uncertain" });
      request.display_title = requestTitle();
      state.beforePost();
      state.visible = !state.lost;
      if (state.ambiguous || state.lost) {
        throw new Error("HTTP 502 after dispatch");
      }
      return respond(args, { workflow_run_id: 30 });
    }
    let value: unknown;
    if (endpoint.startsWith("git/ref/heads/")) {
      value = {
        ref: "refs/heads/" + parent.head_branch,
        object: { type: "commit", sha: state.branchSha },
      };
    } else if (endpoint.startsWith("compare/")) {
      value = { status: state.ancestry };
    } else if (endpoint.startsWith("commits/")) {
      expect(decodeURIComponent(endpoint)).toBe("commits/refs/tags/" + tag);
      expect(args).toContain("Cache-Control: max-age=0");
      value = { sha: state.tagSha };
    } else if (endpoint.startsWith("releases/tags/")) {
      value = { tag_name: tag, draft: state.draft, prerelease: false };
    } else if (endpoint === "actions/runs/" + payload.parentRunId) {
      value = parent;
    } else if (endpoint === "actions/runs/" + env.GITHUB_RUN_ID) {
      value = state.coordinatorCancelled
        ? { ...ownRun(), status: "completed", conclusion: "cancelled" }
        : ownRun();
    } else if (endpoint === "actions/runs/30") {
      if (state.first404 && state.reads404++ === 0) {
        throw new Error("HTTP 404");
      }
      value = request;
    } else if (endpoint === "actions/runs/40") {
      value = builder;
    } else if (endpoint.startsWith("actions/runs/" + payload.parentRunId + "/attempts/")) {
      value = {
        jobs: state.malformedJobs
          ? null
          : state.secondJobsPage && endpoint.endsWith("page=1")
            ? Array.from({ length: 100 }, (_, index) => ({
                name: "sibling " + index,
                status: "completed",
                conclusion: "success",
              }))
            : [
                {
                  name: "Finalize GitHub release",
                  status: "completed",
                  conclusion: state.finalized ? "success" : "skipped",
                },
              ],
      };
    } else if (endpoint.startsWith("actions/runs/40/attempts/")) {
      value = {
        jobs: [
          {
            name: "Publish companion bundles and updater manifest",
            status: "completed",
            conclusion: state.published ? "success" : "skipped",
          },
        ],
      };
    } else if (/^actions\/runs\/\d+\/attempts\/\d+$/u.test(endpoint)) {
      const parts = endpoint.split("/");
      const previous = [ownRun(), ...priorRuns].find((run) => String(run.id) === parts[2]);
      if (!previous) {
        throw new Error("Unknown prior run");
      }
      value = {
        ...previous,
        run_attempt: Number(parts[4]),
        status: "completed",
        conclusion: "failure",
      };
    } else if (endpoint.startsWith("actions/workflows/linux-app-release-request.yml/runs?")) {
      value = {
        workflow_runs: state.visible
          ? state.duplicate
            ? [request, { ...request, id: 31 }]
            : [request]
          : [],
      };
    } else if (endpoint.startsWith("actions/workflows/linux-app-release-auto.yml/runs?")) {
      value = {
        workflow_runs: [
          ...(state.coordinatorVisible ? [ownRun()] : []),
          ...priorRuns.filter((run) => String(run.id) !== env.GITHUB_RUN_ID),
        ],
      };
    } else if (endpoint.startsWith("actions/workflows/linux-app-release.yml/runs?")) {
      value = { workflow_runs: state.builderVisible ? [builder] : [] };
    } else {
      throw new Error("Unexpected GitHub call: " + args.join(" "));
    }
    return respond(args, value);
  };
  const run = () => {
    root = dirs.make("linux-auto-");
    env.RUNNER_TEMP = root;
    const step = publisher.jobs.linux_handoff.steps.find(
      (value: { name: string }) => value.name === "Record detached Linux release intent",
    );
    const produced = spawnSync("bash", ["-e", "-o", "pipefail", "-c", step.run], {
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: root,
        RELEASE_TAG: payload.tag,
        TARGET_SHA: payload.sha,
        GITHUB_RUN_ID: payload.parentRunId,
        GITHUB_RUN_ATTEMPT: payload.parentRunAttempt,
        GITHUB_WORKFLOW_SHA: payload.parentWorkflowSha,
        GITHUB_REF: payload.parentWorkflowRef,
      },
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(produced.status, produced.stderr).toBe(0);
    if (state.tamperIntent) {
      writeFileSync(
        join(root, "linux-release-intent/intent.json"),
        JSON.stringify({ ...payload, sha: tooling }),
      );
    }
    return runLinuxReleaseAuto({
      event,
      env,
      runGh,
      signal: abort.signal,
      sleep: async () => {
        state.sleeps++;
        state.afterSleep();
      },
    });
  };
  return {
    run,
    env,
    event,
    payload,
    parent,
    request,
    builder,
    state,
    prior,
    receipts,
    calls,
    responses,
    outcome,
    abort,
    writes: () => calls.filter((args) => args.includes("POST")),
  };
}

export {
  fixture as createLinuxReleaseFixture,
  dirs as linuxReleaseTempDirs,
  tag as linuxReleaseTag,
  source as linuxReleaseSource,
  tooling as linuxReleaseTooling,
  key as linuxReleaseKey,
};
