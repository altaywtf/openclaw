import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const script = path.resolve("scripts/mantis/attach-smoke-video-audits.mjs");
const roots: string[] = [];

function fixture(priorPass = true) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mantis-smoke-audit-")));
  roots.push(root);
  const manifestPath = path.join(root, "mantis-evidence.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      comparison: {
        baseline: { expectationMet: true },
        candidate: { expectationMet: priorPass },
        pass: priorPass,
        outcome: priorPass ? "pass" : "fail",
      },
      artifacts: [],
    }),
  );
  const smokeArgs: string[] = [];
  function smoke(
    lane: "baseline" | "candidate",
    auditStatus: "pass" | "fail" | "error",
    options: { status?: string; error?: string; exit?: number } = {},
  ) {
    const dir = path.join(root, lane, "video-audit-123");
    mkdirSync(dir, { recursive: true });
    const auditPath = path.join(dir, "video-audit.json");
    const reportPath = path.join(dir, "video-audit.md");
    const audit = {
      provider: "google",
      model: "gemini-3.8-flash",
      processing: "agentic",
      status: auditStatus,
      complete: true,
      findings: auditStatus === "fail" ? [{ observation: "Flicker" }] : [],
      error: auditStatus === "error" ? "Missing agentic navigation proof" : undefined,
      summaryPath: auditPath,
      reportPath,
    };
    writeFileSync(auditPath, JSON.stringify(audit));
    writeFileSync(reportPath, `Video audit: ${auditStatus}\n`);
    const summaryPath = path.join(root, lane, "smoke-summary.json");
    const status = options.status ?? (auditStatus === "pass" ? "pass" : "fail");
    const summary = { status, error: options.error, videoAudit: audit };
    writeFileSync(summaryPath, JSON.stringify(summary));
    smokeArgs.push(
      "--smoke",
      lane,
      summaryPath,
      String(options.exit ?? (status === "pass" ? 0 : 1)),
    );
    return { audit, auditPath, reportPath, summary, summaryPath };
  }
  function run() {
    const result = spawnSync(process.execPath, [script, manifestPath, ...smokeArgs], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return {
      status: result.stdout.trim(),
      manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
    };
  }
  return { root, smoke, smokeArgs, run };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("persisted Mantis smoke video evidence", () => {
  it.each([
    ["pass", "pass", "pass"],
    ["fail", "pass", "pass"],
    ["fail", "fail", "fail"],
    ["error", "pass", "blocked"],
    ["pass", "error", "blocked"],
  ] as const)("compares baseline %s and candidate %s as %s", (baseline, candidate, expected) => {
    const test = fixture();
    test.smoke("baseline", baseline);
    test.smoke("candidate", candidate);
    const result = test.run();
    expect(result.status).toBe(expected);
    expect(result.manifest.comparison.pass).toBe(expected === "pass");
    expect(result.manifest.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lane: "baseline",
          kind: "report",
          path: "baseline/video-audit-123/video-audit.md",
          targetPath: "baseline/video-audit-123/video-audit.md",
        }),
        expect.objectContaining({
          lane: "candidate",
          kind: "metadata",
          path: "candidate/video-audit-123/video-audit.json",
          targetPath: "candidate/video-audit-123/video-audit.json",
        }),
      ]),
    );
    expect(readFileSync(path.join(test.root, "mantis-smoke-video-audits.md"), "utf8")).toContain(
      expected,
    );
  });

  it.each([
    { prior: false, status: "pass", exit: 0 },
    { prior: true, status: "fail", exit: 1, error: "Gateway failed" },
    { prior: true, status: "pass", exit: 2 },
  ])("never hides functional or process failures: %j", ({ prior, ...options }) => {
    const test = fixture(prior);
    test.smoke("candidate", "pass", options);
    expect(test.run().status).toBe("fail");
  });

  it.each(["malformed", "incomplete", "disagrees", "oversized", "outside", "symlink", "missing"])(
    "blocks %s persisted evidence",
    (failure) => {
      const test = fixture();
      const files = test.smoke("candidate", "pass");
      if (failure === "malformed") {
        writeFileSync(files.auditPath, "{");
      }
      if (failure === "incomplete") {
        writeFileSync(files.auditPath, JSON.stringify({ ...files.audit, complete: false }));
      }
      if (failure === "disagrees") {
        writeFileSync(
          files.auditPath,
          JSON.stringify({ ...files.audit, status: "fail", findings: [{}] }),
        );
      }
      if (failure === "oversized") {
        writeFileSync(files.reportPath, "x".repeat(256 * 1024 + 1));
      }
      if (failure === "outside" || failure === "symlink") {
        const outside = fixture().root;
        const outsideReport = path.join(outside, "private.md");
        writeFileSync(outsideReport, "private content");
        if (failure === "outside") {
          files.summary.videoAudit.reportPath = outsideReport;
          writeFileSync(files.summaryPath, JSON.stringify(files.summary));
        } else {
          rmSync(files.reportPath);
          symlinkSync(outsideReport, files.reportPath);
        }
      }
      if (failure === "missing") {
        rmSync(files.summaryPath);
      }
      const result = test.run();
      expect(result.status).toBe("blocked");
      expect(result.manifest.videoAudit.reviews[0]).toMatchObject({
        lane: "candidate",
        status: "error",
        error: expect.any(String),
      });
      expect(JSON.stringify(result.manifest)).not.toContain("private content");
    },
  );

  it("records an optional capture skip without claiming video proof", () => {
    const result = fixture().run();
    expect(result.status).toBe("pass");
    expect(result.manifest.videoAudit).toEqual({ status: "skipped", reviews: [] });
    expect(result.manifest.comparison.verdictNote).toContain("Functional evidence only");
  });

  it.each([
    ["status-reactions", "run_status_reactions", "make_desktop_preview()", 2],
    ["thread-attachment", "run_thread_attachment", "read_discord_thread_attachment_status()", 1],
  ] as const)(
    "retains %s captures after the smoke command reports an audit failure",
    (workflow, job, nextFunction, lanes) => {
      const source = parse(
        readFileSync(`.github/workflows/mantis-discord-${workflow}.yml`, "utf8"),
      );
      const run = source.jobs[job].steps.find(
        (step: { id?: string }) => step.id === "run_mantis",
      ).run;
      if (typeof run !== "string") {
        throw new Error("Expected the workflow capture shell program.");
      }
      const capture = run.slice(run.indexOf("smoke_audit_args=()"), run.indexOf(nextFunction));
      const test = fixture();
      for (const lane of ["baseline", "candidate"]) {
        mkdirSync(path.join(test.root, lane), { recursive: true });
        writeFileSync(
          path.join(test.root, lane, "discord-status-reactions-tool-only-timeline.html"),
          "<p>Timeline</p>",
        );
      }
      writeFileSync(
        path.join(test.root, "candidate/discord-thread-reply-filepath-attachment-ui.json"),
        JSON.stringify({ discordWebUrl: "https://discord.com/channels/test" }),
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
root="$TEST_ROOT"
desktop_lease_id=cbx_test
pnpm() {
  local output_dir
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--output-dir" ]]; then output_dir="$2"; break; fi
    shift
  done
  mkdir -p "$output_dir"
  printf screenshot > "$output_dir/desktop-browser-smoke.png"
  return 1
}
${capture}
printf '%s\\n' "\${smoke_audit_args[@]}"
`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            TEST_ROOT: test.root,
            MANTIS_DISCORD_VIEWER_CHROME_PROFILE_DIR: "/profile",
            CRABBOX_COORDINATOR_TOKEN: "fixture",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const retained = result.stdout.trim().split("\n");
      expect(retained.filter((line) => line === "--smoke")).toHaveLength(lanes);
      expect(retained.filter((line) => line === "1")).toHaveLength(lanes);
      const screenshot =
        workflow === "status-reactions"
          ? "candidate/discord-status-reactions-tool-only-desktop.png"
          : "candidate/discord-thread-reply-filepath-attachment-discord-web.png";
      expect(readFileSync(path.join(test.root, screenshot), "utf8")).toBe("screenshot");
    },
  );
});
