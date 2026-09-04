#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isRecord } from "./lib/record-shared.mjs";
import {
  runReleaseToolingGh,
  validateReleasePublishParentRun,
  verifyReleaseToolingIdentity,
} from "./release-tooling-identity.mjs";

const REQUEST = "linux-app-release-request.yml";
const BUILDER = "linux-app-release.yml";
const AUTO = "linux-app-release-auto.yml";
const SHA = /^[a-f0-9]{40}$/u;
const TAG = /^v[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:-[1-9][0-9]*)?$/u;
const EVENT = "openclaw-linux-release";

type Intent = {
  tag: string;
  sha: string;
  parentRunId: string;
  parentRunAttempt: string;
  parentWorkflowSha: string;
  parentWorkflowRef: string;
};
type RunBinding = { runId: string; runAttempt: string; workflowSha: string };
type Outcome = {
  kind: "linux-release-auto";
  version: 1;
  ownRunId: string;
  ownRunAttempt: string;
  workflowSha: string;
  releaseKey: string;
  parent: Intent;
  mutationAttempted: boolean;
  state:
    | "no-dispatch"
    | "dispatch-uncertain"
    | "request-observed"
    | "stopped"
    | "cancelled"
    | "builder-succeeded";
  assetsVerified: false;
  request?: RunBinding & { parentRunId: string; parentRunAttempt: string };
  builder?: RunBinding;
};
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Invalid Linux release evidence object");
  }
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new Error("Missing Linux release identity");
  }
  return value;
}
function id(value: unknown): string {
  const result = String(value);
  if (!/^[1-9][0-9]*$/u.test(result) || !Number.isSafeInteger(Number(result))) {
    throw new Error("Invalid Linux run ID or attempt");
  }
  return result;
}
function sha(value: unknown): string {
  const result = text(value);
  if (!SHA.test(result)) {
    throw new Error("Invalid Linux source/tooling SHA");
  }
  return result;
}
function intent(value: unknown): Intent {
  const data = record(value);
  const fields = [
    "tag",
    "sha",
    "parentRunId",
    "parentRunAttempt",
    "parentWorkflowSha",
    "parentWorkflowRef",
  ];
  if (Object.keys(data).toSorted().join(",") !== fields.toSorted().join(",")) {
    throw new Error("Unexpected Linux intent fields");
  }
  const tag = text(data.tag);
  if (!TAG.test(tag)) {
    throw new Error("Linux automation requires a stable release tag");
  }
  return {
    tag,
    sha: sha(data.sha),
    parentRunId: id(data.parentRunId),
    parentRunAttempt: id(data.parentRunAttempt),
    parentWorkflowSha: sha(data.parentWorkflowSha),
    parentWorkflowRef: text(data.parentWorkflowRef),
  };
}
function binding(run: Record<string, unknown>): RunBinding {
  return { runId: id(run.id), runAttempt: id(run.run_attempt), workflowSha: sha(run.head_sha) };
}
function workflowPath(run: Record<string, unknown>) {
  return text(run.path).split("@", 1)[0];
}

// One release-keyed coordinator owns one possible request POST. Its immutable
// outcome artifact is evidence of non-dispatch, never release authorization.
export async function runLinuxReleaseAuto({
  event,
  env = process.env,
  runGh = runReleaseToolingGh,
  signal = new AbortController().signal,
  sleep = (ms: number) => setTimeout(ms, undefined, { signal }),
}: {
  event: unknown;
  env?: NodeJS.ProcessEnv;
  runGh?: (args: string[]) => string;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<Outcome> {
  const repository = text(env.GITHUB_REPOSITORY);
  const envelope = record(event);
  if (
    repository !== "openclaw/openclaw" ||
    env.GITHUB_EVENT_NAME !== "repository_dispatch" ||
    envelope.action !== EVENT ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_WORKFLOW_REF !== repository + "/.github/workflows/" + AUTO + "@refs/heads/main"
  ) {
    throw new Error(
      "Linux automation requires its trusted default-branch repository_dispatch owner",
    );
  }
  const parent = intent(envelope.client_payload);
  const releaseKey = parent.tag + "@" + parent.sha;
  const outcome: Outcome = {
    kind: "linux-release-auto",
    version: 1,
    ownRunId: id(env.GITHUB_RUN_ID),
    ownRunAttempt: id(env.GITHUB_RUN_ATTEMPT),
    workflowSha: sha(env.GITHUB_WORKFLOW_SHA),
    releaseKey,
    parent,
    mutationAttempted: false,
    state: "no-dispatch",
    assetsVerified: false,
  };
  const root = text(env.RUNNER_TEMP);
  const outcomeDir = join(root, "linux-release-outcome");
  const outcomePath = join(outcomeDir, "outcome.json");
  mkdirSync(outcomeDir, { recursive: true });
  if (existsSync(outcomePath)) {
    throw new Error("Coordinator outcome already exists; never overwrite a prior mutation marker");
  }
  const save = () => writeFileSync(outcomePath, JSON.stringify(outcome) + "\n");
  writeFileSync(outcomePath, JSON.stringify(outcome) + "\n", { flag: "wx" });
  const json = (args: string[]) => record(JSON.parse(runGh(args)));
  const get = (path: string, projection?: string) =>
    json([
      "api",
      "repos/" + repository + "/" + path,
      "--method",
      "GET",
      "-H",
      "Cache-Control: max-age=0",
      ...(projection ? ["--jq", projection] : []),
    ]);
  const url = (runId: string) => "https://github.com/" + repository + "/actions/runs/" + runId;
  const download = (runId: string, name: string, directory: string, filename: string) => {
    runGh(["run", "download", runId, "--repo", repository, "--name", name, "--dir", directory]);
    return record(JSON.parse(readFileSync(join(directory, filename), "utf8")));
  };
  const checkParent = () => {
    if (signal.aborted) {
      outcome.state = "cancelled";
      signal.throwIfAborted();
    }
    const run = get("actions/runs/" + parent.parentRunId);
    if (run.conclusion === "cancelled") {
      outcome.state = "cancelled";
    }
    const ref = parent.parentWorkflowRef.replace(/^refs\/(?:heads|tags)\//u, "");
    const identity = { sha: parent.parentWorkflowSha, ref, fullRef: parent.parentWorkflowRef };
    validateReleasePublishParentRun({
      identity,
      repository,
      run,
      releasePublishRunId: parent.parentRunId,
      releasePublishRunAttempt: parent.parentRunAttempt,
      releasePublishRef: ref,
      releasePublishFullRef: parent.parentWorkflowRef,
      releasePublishParentStatePolicy:
        run.conclusion === "failure" ? "active-or-failure" : "active-or-success",
    });
    // The canonical publisher contract above owns the route allowlist. For an
    // admitted direct release branch, still prove its exact live branch SHA.
    verifyReleaseToolingIdentity({
      repository,
      runGh,
      allowPrevalidatedRef: true,
      workflowSha: identity.sha,
      workflowRef: identity.ref,
      workflowFullRef: identity.fullRef,
    });
  };
  const successfulJob = (runId: string, attempt: string, name: string) => {
    const matches: Record<string, unknown>[] = [];
    for (let page = 1; page <= 10; page++) {
      const jobs = get(
        "actions/runs/" + runId + "/attempts/" + attempt + "/jobs?per_page=100&page=" + page,
      ).jobs;
      if (!Array.isArray(jobs)) {
        throw new Error("Invalid Linux release job evidence");
      }
      matches.push(...jobs.map(record).filter((job) => job.name === name));
      if (matches.length > 1) {
        throw new Error("Ambiguous " + name + " job evidence");
      }
      if (jobs.length < 100) {
        const [job] = matches;
        return matches.length === 1 && job?.status === "completed" && job.conclusion === "success";
      }
    }
    throw new Error("Job evidence exceeded bounded scan: " + url(runId));
  };
  const checkSource = () => {
    const commit = get("commits/" + encodeURIComponent("refs/tags/" + parent.tag));
    const release = get("releases/tags/" + encodeURIComponent(parent.tag));
    if (
      commit.sha !== parent.sha ||
      release.tag_name !== parent.tag ||
      release.draft !== false ||
      release.prerelease !== false
    ) {
      throw new Error("Linux source drift or release is not public stable");
    }
  };
  const listRuns = (workflow: string) => {
    const runs: Record<string, unknown>[] = [];
    for (let page = 1; page <= 20; page++) {
      const result = get(
        "actions/workflows/" + workflow + "/runs?branch=main&per_page=50&page=" + page,
        "{workflow_runs: [.workflow_runs[] | {id,run_attempt,head_sha,head_branch,event,path,repository:{full_name:.repository.full_name},status,conclusion,display_title}]}",
      );
      if (!Array.isArray(result.workflow_runs)) {
        throw new Error("Invalid workflow run listing");
      }
      runs.push(...result.workflow_runs.map(record));
      if (result.workflow_runs.length < 50) {
        return runs;
      }
    }
    throw new Error("Linux run history exceeded bounded scan; cannot prove dispatch absence");
  };
  const validateMainRun = (run: Record<string, unknown>, workflow: string, eventName: string) => {
    if (
      record(run.repository).full_name !== repository ||
      workflowPath(run) !== ".github/workflows/" + workflow ||
      run.event !== eventName ||
      run.head_branch !== "main"
    ) {
      throw new Error("Linux child/coordinator workflow identity changed");
    }
    const actual = binding(run);
    verifyReleaseToolingIdentity({
      repository,
      runGh,
      workflowSha: actual.workflowSha,
      workflowRef: "main",
      workflowFullRef: "refs/heads/main",
    });
    return actual;
  };
  const checkCoordinator = () => {
    const run = get("actions/runs/" + outcome.ownRunId);
    const actual = validateMainRun(run, AUTO, "repository_dispatch");
    if (run.conclusion === "cancelled") {
      outcome.state = "cancelled";
    }
    if (
      actual.runId !== outcome.ownRunId ||
      actual.runAttempt !== outcome.ownRunAttempt ||
      actual.workflowSha !== outcome.workflowSha ||
      run.status !== "in_progress" ||
      run.conclusion
    ) {
      throw new Error("Coordinator is no longer the exact active run; stop Linux automation");
    }
  };
  const requestPattern =
    /^Linux App Release Request \[(v[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:-[1-9][0-9]*)?)\] desktop=(true|false)(?: source=([a-f0-9]{40}) parent=([1-9][0-9]*):([1-9][0-9]*))?$/u;
  const findRequest = () => {
    const matches: Record<string, unknown>[] = [];
    for (const run of listRuns(REQUEST)) {
      const title = text(run.display_title);
      // Legacy or conflicting same-tag requests can still publish. They are not
      // evidence of absence, even if they came from a different parent.
      if (!title.startsWith("Linux App Release Request [" + parent.tag + "]")) {
        continue;
      }
      const parsed = requestPattern.exec(title);
      if (!parsed || parsed[2] !== "false" || parsed[3] !== parent.sha) {
        throw new Error(
          "Legacy or conflicting same-tag Linux request requires manual reconciliation: " +
            url(id(run.id)),
        );
      }
      validateMainRun(run, REQUEST, "workflow_dispatch");
      matches.push(run);
    }
    if (matches.length > 1) {
      throw new Error("Multiple source-bound Linux requests; never dispatch another");
    }
    return matches[0];
  };
  const requireNoPriorDispatch = () => {
    const title = "Linux App Release Auto [tag=" + parent.tag + " source=" + parent.sha + "]";
    const coordinators = listRuns(AUTO).filter((run) => run.display_title === title);
    if (!coordinators.some((run) => id(run.id) === outcome.ownRunId)) {
      throw new Error("Current coordinator is not visible; dispatch absence is unproven");
    }
    for (const run of coordinators) {
      const live = validateMainRun(run, AUTO, "repository_dispatch");
      const current = live.runId === outcome.ownRunId;
      if (
        current &&
        (live.runAttempt !== outcome.ownRunAttempt || live.workflowSha !== outcome.workflowSha)
      ) {
        throw new Error("Current coordinator attempt/source changed");
      }
      const lastAttempt = Number(live.runAttempt) - (current ? 1 : 0);
      if (lastAttempt > 50) {
        throw new Error("Coordinator attempt history exceeds bounded reconciliation");
      }
      for (let attempt = 1; attempt <= lastAttempt; attempt++) {
        const previous = get("actions/runs/" + live.runId + "/attempts/" + attempt);
        const actual = validateMainRun(previous, AUTO, "repository_dispatch");
        if (
          actual.runId !== live.runId ||
          actual.runAttempt !== String(attempt) ||
          actual.workflowSha !== live.workflowSha ||
          previous.display_title !== title ||
          previous.status !== "completed"
        ) {
          throw new Error("Prior coordinator is active or its identity changed; outcome unknown");
        }
        const receipt = download(
          actual.runId,
          "linux-release-outcome-" + actual.runId + "-" + actual.runAttempt,
          join(root, "prior-linux-outcomes", actual.runId, actual.runAttempt),
          "outcome.json",
        );
        const priorParent = intent(receipt.parent);
        if (
          receipt.kind !== "linux-release-auto" ||
          receipt.version !== 1 ||
          receipt.ownRunId !== actual.runId ||
          receipt.ownRunAttempt !== actual.runAttempt ||
          receipt.workflowSha !== actual.workflowSha ||
          receipt.releaseKey !== releaseKey ||
          priorParent.tag !== parent.tag ||
          priorParent.sha !== parent.sha ||
          receipt.mutationAttempted !== false ||
          receipt.state !== "no-dispatch"
        ) {
          throw new Error(
            "Prior coordinator does not prove no dispatch; outcome unresolved: " +
              url(actual.runId),
          );
        }
      }
    }
  };
  const poll = async (
    label: string,
    count: number,
    observe: () => Record<string, unknown> | undefined,
  ) => {
    for (let attempt = 0; attempt < count; attempt++) {
      checkParent();
      checkCoordinator();
      const result = observe();
      if (result) {
        return result;
      }
      if (attempt + 1 < count) {
        await sleep(30_000);
      }
    }
    throw new Error(
      label +
        " exhausted its observation budget; inspect exact runs. No replacement dispatch was attempted.",
    );
  };
  const awaitTerminal = async (
    initial: Record<string, unknown>,
    workflow: string,
    eventName: string,
    count: number,
  ) => {
    const expected = binding(initial);
    const terminal = await poll(workflow + " " + url(expected.runId), count, () => {
      const run = get("actions/runs/" + expected.runId);
      const actual = validateMainRun(run, workflow, eventName);
      if (
        JSON.stringify(actual) !== JSON.stringify(expected) ||
        run.display_title !== initial.display_title
      ) {
        throw new Error("Linux run attempt/source changed while collecting");
      }
      return run.status === "completed" ? run : undefined;
    });
    if (terminal.conclusion !== "success") {
      if (terminal.conclusion === "cancelled") {
        outcome.state = "cancelled";
      }
      throw new Error(
        workflow +
          " " +
          String(terminal.conclusion) +
          ": " +
          url(expected.runId) +
          " attempt " +
          expected.runAttempt +
          "; inspect exact failed jobs, not the release campaign",
      );
    }
  };
  try {
    checkParent();
    if (!successfulJob(parent.parentRunId, parent.parentRunAttempt, "Finalize GitHub release")) {
      throw new Error("Parent has no successful exact release finalization");
    }
    const payload = download(
      parent.parentRunId,
      "linux-release-intent-" + parent.parentRunId + "-" + parent.parentRunAttempt,
      join(root, "linux-release-intent"),
      "intent.json",
    );
    if (JSON.stringify(intent(payload)) !== JSON.stringify(parent)) {
      throw new Error("Immutable Linux intent does not match dispatch payload");
    }
    checkSource();
    let request = findRequest();
    if (!request) {
      requireNoPriorDispatch();
      // Deliver pending cancellation before the only mutation. Fresh source and
      // exact parent checks are repeated after history/artifact reconciliation.
      await setTimeout(0, undefined, { signal });
      checkSource();
      checkParent();
      checkCoordinator();
      outcome.mutationAttempted = true;
      outcome.state = "dispatch-uncertain";
      save();
      let dispatchedId: string | undefined;
      try {
        const response = json([
          "api",
          "repos/" + repository + "/actions/workflows/" + REQUEST + "/dispatches",
          "--method",
          "POST",
          "-H",
          "X-GitHub-Api-Version: 2026-03-10",
          "-f",
          "ref=main",
          "-f",
          "inputs[tag]=" + parent.tag,
          "-f",
          "inputs[desktop-test-bundles]=false",
          "-f",
          "inputs[expected_sha]=" + parent.sha,
          "-f",
          "inputs[release_publish_run_id]=" + parent.parentRunId,
          "-f",
          "inputs[release_publish_run_attempt]=" + parent.parentRunAttempt,
        ]);
        dispatchedId = id(response.workflow_run_id);
      } catch {
        // A lost/error response never grants a second POST. Missing durable
        // outcome after a crash likewise blocks replacement by the next run.
      }
      request = await poll("Linux request reconciliation for " + releaseKey, 12, () => {
        if (!dispatchedId) {
          return findRequest();
        }
        try {
          const run = get("actions/runs/" + dispatchedId);
          if (id(run.id) !== dispatchedId) {
            throw new Error("Returned Linux request ID changed");
          }
          return run;
        } catch (error) {
          if (String(error).includes("HTTP 404")) {
            return undefined;
          }
          throw error;
        }
      });
    }
    const selected = validateMainRun(request, REQUEST, "workflow_dispatch");
    const parsed = requestPattern.exec(text(request.display_title));
    if (
      !parsed ||
      parsed[1] !== parent.tag ||
      parsed[2] !== "false" ||
      parsed[3] !== parent.sha ||
      !parsed[4] ||
      !parsed[5]
    ) {
      throw new Error("Selected Linux request source binding changed");
    }
    outcome.request = { ...selected, parentRunId: id(parsed[4]), parentRunAttempt: id(parsed[5]) };
    outcome.state = "request-observed";
    save();
    console.log("Linux request: " + url(selected.runId) + " attempt " + selected.runAttempt);
    if (selected.runAttempt !== "1") {
      throw new Error("Linux request was rerun; inspect its builders before recovery");
    }
    await awaitTerminal(request, REQUEST, "workflow_dispatch", 20);
    const builderTitle =
      "Linux App Release [request=" + selected.runId + ":" + selected.runAttempt + "]";
    const builder = await poll("Linux builder delivery", 20, () => {
      const matches = listRuns(BUILDER).filter((run) => run.display_title === builderTitle);
      if (matches.length > 1) {
        throw new Error("Multiple exact Linux builders; reconcile manually");
      }
      return matches[0];
    });
    outcome.builder = validateMainRun(builder, BUILDER, "workflow_run");
    save();
    console.log(
      "Linux builder: " + url(outcome.builder.runId) + " attempt " + outcome.builder.runAttempt,
    );
    await awaitTerminal(builder, BUILDER, "workflow_run", 180);
    if (
      !successfulJob(
        outcome.builder.runId,
        outcome.builder.runAttempt,
        "Publish companion bundles and updater manifest",
      )
    ) {
      throw new Error("Linux publication job did not succeed; skipped jobs are not completion");
    }
    checkSource();
    checkParent();
    outcome.state = "builder-succeeded";
    return outcome;
  } catch (error) {
    if (signal.aborted) {
      outcome.state = "cancelled";
    } else if (outcome.state === "request-observed") {
      outcome.state = "stopped";
    }
    throw error;
  } finally {
    save();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(
      new Error("Linux observation cancelled; already-dispatched children are unchanged"),
    );
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await runLinuxReleaseAuto({
      event: JSON.parse(readFileSync(text(process.env.GITHUB_EVENT_PATH), "utf8")),
      signal: controller.signal,
    });
    console.log(JSON.stringify(result));
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        "## Linux release automation\n\n" +
          JSON.stringify(result) +
          "\n\nBuilder result only; live release assets were not independently verified.\n",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[linux-release-auto] FAILED (exit 1)");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
