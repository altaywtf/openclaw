import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validateEvidenceManifestFile } from "../../scripts/mantis/publish-pr-evidence.mjs";

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mantis-capture-workflow-")));
  roots.push(root);
  for (const lane of ["baseline", "candidate"]) {
    mkdirSync(path.join(root, lane));
  }
  return root;
}
function workflowRun(workflow: string, job: string) {
  const source = parse(readFileSync(`.github/workflows/mantis-discord-${workflow}.yml`, "utf8"));
  const run = source.jobs[job].steps.find((step: { id?: string }) => step.id === "run_mantis").run;
  if (typeof run !== "string") {
    throw new Error("Expected the workflow capture shell program.");
  }
  return run;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Mantis desktop capture workflows", () => {
  it.each([
    ["status-reactions", "run_status_reactions", "make_desktop_preview()", 2],
    ["thread-attachment", "run_thread_attachment", "read_discord_thread_attachment_status()", 1],
  ] as const)(
    "retains %s captures after the smoke audit fails",
    (workflow, job, nextFunction, lanes) => {
      const run = workflowRun(workflow, job);
      const capture = run.slice(run.indexOf("smoke_results=()"), run.indexOf(nextFunction));
      const root = fixture();
      for (const lane of ["baseline", "candidate"]) {
        writeFileSync(
          path.join(root, lane, "discord-status-reactions-tool-only-timeline.html"),
          "<p>Timeline</p>",
        );
      }
      writeFileSync(
        path.join(root, "candidate/discord-thread-reply-filepath-attachment-ui.json"),
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
printf '%s\\n' "\${smoke_results[@]}"
`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            TEST_ROOT: root,
            MANTIS_DISCORD_VIEWER_CHROME_PROFILE_DIR: "/profile",
            CRABBOX_COORDINATOR_TOKEN: "fixture",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const results = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(results).toHaveLength(lanes);
      expect(results.every((smoke: { exitCode: number }) => smoke.exitCode === 1)).toBe(true);
      const screenshot =
        workflow === "status-reactions"
          ? "candidate/discord-status-reactions-tool-only-desktop.png"
          : "candidate/discord-thread-reply-filepath-attachment-discord-web.png";
      expect(readFileSync(path.join(root, screenshot), "utf8")).toBe("screenshot");
    },
  );

  it("publishes the status-reaction failure report when desktop capture is missing", () => {
    const run = workflowRun("status-reactions", "run_status_reactions");
    const manifestEnd =
      run.indexOf('> "$root/mantis-evidence.json"') + '> "$root/mantis-evidence.json"'.length;
    const manifestCommand = run
      .slice(run.lastIndexOf("jq -n", manifestEnd), manifestEnd)
      .replace(/\$\{\{[^}]+\}\}/gu, "fixture-sha");
    const root = fixture();
    for (const lane of ["baseline", "candidate"]) {
      writeFileSync(
        path.join(root, lane, "discord-status-reactions-tool-only-timeline.png"),
        "timeline",
      );
    }
    writeFileSync(path.join(root, "comparison.json"), "{}");
    writeFileSync(
      path.join(root, "mantis-report.md"),
      "Desktop capture failed; retained functional evidence.",
    );
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
root="$TEST_ROOT"
baseline_status=fail
candidate_status=pass
${manifestCommand}
`,
      ],
      { encoding: "utf8", env: { ...process.env, TEST_ROOT: root } },
    );
    expect(result.status, result.stderr).toBe(0);
    const manifestPath = path.join(root, "mantis-evidence.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    // The video audit owns the veto; publication must still include its failure report.
    manifest.comparison = {
      ...manifest.comparison,
      pass: false,
      outcome: "blocked",
      candidate: { ...manifest.comparison.candidate, expectationMet: false },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(validateEvidenceManifestFile(manifestPath).comparison.outcome).toBe("blocked");
  });
});
