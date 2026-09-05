import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
import { createManagedHandoffLeaseRuntime } from "./update-managed-service-handoff-lease-runtime.js";
import { HANDOFF_SENTINEL_STATE_SCRIPT } from "./update-managed-service-handoff-sentinel-script.js";
import { HANDOFF_SERVICE_SCRIPT } from "./update-managed-service-handoff-service-script.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "./update-run-ledger.js";

const tempDirs = createTempDirTracker();
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

it.runIf(process.platform !== "win32")(
  "finishes the original update before triage retarget and exec without lending its run identity",
  async () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-triage-ledger-cutover-"));
    const options = { env: { OPENCLAW_STATE_DIR: root } };
    const original = createUpdateRun({ trigger: "cli" }, options);
    const failure = { status: "failed", reason: "restart-unhealthy" } as const;
    const fragment = path.join(root, "gateway.service");
    const paramsPath = path.join(root, "params.json");
    const params = {
      action: "update",
      runId: original.runId,
      updateLeaseKey: root,
      scopeUnit: "openclaw-update-fixture.scope",
      serviceRecovery: { kind: "systemd", unit: "openclaw-gateway.service" },
      serviceManagerEnv: { PATH: root },
      systemdRun: path.join(root, "systemd-run"),
    };
    // Only this synthetic manager is executable. No host service manager is called.
    fs.writeFileSync(
      path.join(root, "systemctl"),
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`Id=openclaw-gateway.service\nLoadState=loaded\nFragmentPath=${fragment}\n`)});\n`,
      { mode: 0o700 },
    );
    const leaseRuntime = createManagedHandoffLeaseRuntime({
      databasePath: path.join(root, "unused-lease.sqlite"),
      serviceManagerEnv: params.serviceManagerEnv,
    });
    let atRetarget: ReturnType<typeof getUpdateRun>;
    let atExec:
      | {
          run: ReturnType<typeof getUpdateRun>;
          env: NodeJS.ProcessEnv;
          params: Record<string, unknown>;
        }
      | undefined;
    const logs: string[] = [];
    const helperProcess = Object.assign(new EventEmitter(), {
      pid: process.pid,
      execPath: process.execPath,
      argv: [process.execPath, path.join(root, "handoff.cjs"), paramsPath],
      env: { ...options.env, [UPDATE_RUN_ID_ENV]: original.runId },
      execve: (_command: string, _argv: string[], env: NodeJS.ProcessEnv) => {
        atExec = {
          run: getUpdateRun(original.runId, options),
          env: { ...env },
          params: JSON.parse(fs.readFileSync(paramsPath, "utf8")),
        };
      },
    });
    // Execute both complete staged owners. Lease admission and exec are boundaries;
    // ledger persistence, service inspection, parameter serialization and cutover are real.
    await runInNewContext(
      `${HANDOFF_SENTINEL_STATE_SCRIPT}\n${HANDOFF_SERVICE_SCRIPT}\n
      runLedger = ledger;
      runOutcome = originalFailure;
      serviceDowntimeMs = 350;
      parkedServiceFragment = fragment;
      enterTriageAfterUpdate(continuation);`,
      {
        fs,
        spawn,
        params,
        fragment,
        process: helperProcess,
        parseSystemdProperties: leaseRuntime.properties,
        appendLog: (message: string) => logs.push(message),
        hasManagedUpdateLease: () => true,
        ownsManagedUpdateLease: () => true,
        managedUpdateLease: { action: { kind: "update" }, key: root },
        leaseStore: {
          retarget: (_lease: unknown, key: string, action: unknown) => {
            atRetarget = getUpdateRun(original.runId, options);
            return { kind: "acquired", lease: { key, action } };
          },
        },
        ledger: {
          finishUpdateRun: (runId: string, result: Parameters<typeof finishUpdateRun>[1]) =>
            finishUpdateRun(runId, result, options),
        },
        originalFailure: failure,
        continuation: { failure: { installationRoot: root }, commandArgv: ["openclaw", "triage"] },
      },
    );

    expect(atExec, logs.join("\n")).toBeDefined();
    if (!atExec) {
      throw new Error("The helper never reached the exec cutover");
    }
    const terminal = { ...failure, phase: "finished", downtimeMs: 350 };
    expect.soft(atRetarget, "ledger at lease retarget").toMatchObject(terminal);
    expect.soft(atExec.run, "ledger at exec cutover").toMatchObject(terminal);
    expect.soft(atExec.env[UPDATE_RUN_ID_ENV]).toBeUndefined();
    expect.soft(atExec.params.runId).toBeUndefined();
    const next = createUpdateRun({ trigger: "cli", runId: atExec.env[UPDATE_RUN_ID_ENV] }, options);
    expect.soft(next.runId).not.toBe(original.runId);
    expect.soft(next.status).toBe("running");
    expect(getUpdateRun(original.runId, options)).toEqual(atExec.run);
  },
);
