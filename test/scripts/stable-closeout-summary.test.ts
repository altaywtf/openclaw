import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { verifyStableMainCloseout } from "../../scripts/lib/stable-release-closeout.mjs";

const params = {
  tag: "v2026.6.8",
  mainPackageJson: { version: "2026.6.8" },
  tagPackageJson: { version: "2026.6.8" },
  mainChangelog: "## 2026.6.8\n\n- Released.\n",
  tagChangelog: "## 2026.6.8\n\n- Released.\n",
  mainAppcast: "<rss/>",
  release: { tagName: "v2026.6.8", isDraft: false, isPrerelease: false, assets: [] },
  releaseTagSha: "a".repeat(40),
  mainSha: "b".repeat(40),
  fullReleaseValidationRunId: "11",
  fullReleaseValidationRunAttempt: "2",
  releasePublishRunId: "12",
  rollbackDrillId: "synthetic-drill",
  rollbackDrillDate: "2026-06-01",
  nowMs: Date.parse("2026-06-17"),
};

function readWorkflowRun(job: "resolve" | "verify", name: string) {
  const workflow = parse(
    readFileSync(".github/workflows/openclaw-stable-main-closeout.yml", "utf8"),
  ) as { jobs: Record<string, { steps: { name: string; run?: string }[] }> };
  const run = workflow.jobs[job]?.steps.find((step) => step.name === name)?.run;
  if (!run) {
    throw new Error(`Missing workflow step ${job}/${name}`);
  }
  return run;
}

function renderSummary(manifest: unknown) {
  const run = readWorkflowRun("verify", "Verify stable state and write closeout manifest");
  // Execute the workflow-owned jq program, not a test copy of its rendering.
  const filter = /^jq -r '([\s\S]*?)' \\\n/mu.exec(run)?.[1];
  if (!filter) {
    throw new Error("Missing closeout summary jq program");
  }
  return execFileSync("jq", ["-r", filter], {
    input: JSON.stringify(manifest),
    encoding: "utf8",
  });
}

// These Ubuntu helpers require Bash 4+; do not run them under macOS system Bash 3.
// Execute actual helper bodies with gh and sleep shell stubs, never host commands.
describe.skipIf(process.platform !== "linux").each(["resolve", "verify"] as const)(
  "stable closeout %s API backoff",
  (job) => {
    it.each([
      { name: "nontransient failure", message: "synthetic failure", code: 42, delays: [] },
      {
        name: "rate-limit exhaustion",
        message: "API RATE LIMIT exceeded",
        code: 42,
        delays: [5, 20, 45, 80, 125],
      },
      {
        name: "HTTP 429 exhaustion",
        message: "HTTP 429 synthetic",
        code: 42,
        delays: [5, 20, 45, 80, 125],
      },
      { name: "success", message: "synthetic success", code: 0, delays: [] },
    ])("preserves status, output, and retry budget for $name", ({ message, code, delays }) => {
      const run = readWorkflowRun(job, "Install GitHub API backoff helper");
      const helper = /<<'BASH'\n([\s\S]*?)\nBASH/u.exec(run)?.[1];
      if (!helper) {
        throw new Error("Missing API backoff helper heredoc");
      }
      const result = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          `
        set -euo pipefail
        gh() {
          printf "gh\n" >&3
          printf "%s\n" "$STUB_MESSAGE"
          return "$STUB_EXIT"
        }
        sleep() { printf "sleep:%s\n" "$1" >&3; }
        ${helper}
        gh_with_retry synthetic
      `,
        ],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH, STUB_MESSAGE: message, STUB_EXIT: String(code) },
          stdio: ["ignore", "pipe", "pipe", "pipe"],
          timeout: 5_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(code);
      expect(result.stdout).toBe(code === 0 ? `${message}\n` : "");
      if (code === 0) {
        expect(result.stderr).toBe("");
      } else {
        expect(result.stderr).toContain(message);
      }
      const trace =
        delays.length > 0 ? delays.flatMap((delay) => ["gh", `sleep:${delay}`]) : ["gh"];
      expect(result.output[3]).toBe(`${trace.join("\n")}\n`);
    });
  },
);

// The owning workflow runs on Ubuntu and uses the runner-provided jq binary.
describe.skipIf(process.platform === "win32")("stable closeout summary", () => {
  it("reports a bound historical snapshot, not current platform readiness", () => {
    const initial = verifyStableMainCloseout(params);
    expect(initial.errors).toEqual([]);
    const summary = renderSummary(initial.manifest);
    expect(summary).toContain("Recorded closeout snapshot (not current platform readiness)");
    expect(summary).toContain(`Release: ${params.tag} (${params.releaseTagSha})`);
    expect(summary).toContain(`Main: ${params.mainSha}`);
    expect(summary).toContain("Full Release Validation: 11 / attempt 2");
    expect(summary).toContain("Release Publish: 12");
    expect(summary).toContain("Apps at closeout: pending");
    for (const platform of ["macos", "windows", "android"]) {
      expect(summary).toContain(`- ${platform}: pending`);
    }
    expect(summary).toContain("Appcast at closeout: pending");

    const replay = verifyStableMainCloseout({
      ...params,
      existingManifest: initial.manifest,
      release: {
        ...params.release,
        assets: [
          { name: "OpenClaw-Android.apk", digest: "sha256:" + "c".repeat(64) },
          { name: "OpenClaw-Android-SHA256SUMS.txt", digest: "sha256:" + "d".repeat(64) },
        ],
      },
    });
    expect(replay.errors).toEqual([]);
    expect(replay.manifest).toEqual(initial.manifest);
    expect(renderSummary(replay.manifest)).toBe(summary);
    const changedAttempt = verifyStableMainCloseout({
      ...params,
      existingManifest: initial.manifest,
      fullReleaseValidationRunAttempt: "3",
    });
    expect(changedAttempt.manifest).toBeNull();
  });

  it("keeps attached assets and digest-backed legacy appcast proof distinct from pending apps", () => {
    const withMac = {
      ...params,
      mainAppcast: `https://github.com/openclaw/openclaw/releases/download/${params.tag}/OpenClaw-2026.6.8.zip`,
      release: {
        ...params.release,
        assets: ["zip", "dmg", "dSYM.zip"].map((extension) => ({
          name: `OpenClaw-2026.6.8.${extension}`,
          digest: `sha256:${"c".repeat(64)}`,
        })),
      },
    };
    const initial = verifyStableMainCloseout(withMac);
    expect(initial.errors).toEqual([]);
    const summary = renderSummary(initial.manifest);
    expect(summary).toContain("- macos: attached");
    expect(summary).toContain("- windows: pending");
    expect(summary).toContain("- android: pending");
    expect(summary).toContain("Apps at closeout: pending");
    expect(summary).toContain("Appcast at closeout: verified");
    const legacy = { ...initial.manifest };
    delete legacy.apps;
    delete legacy.appPlatforms;
    delete legacy.appcast;
    const replay = verifyStableMainCloseout({ ...withMac, existingManifest: legacy });
    expect(replay.errors).toEqual([]);
    expect(replay.manifest).toEqual(legacy);
    expect(renderSummary(replay.manifest)).toContain(
      "Appcast at closeout: verified (recorded digest)",
    );
  });

  it("does not manufacture appcast verification for an accepted snapshot without app evidence", () => {
    const initial = verifyStableMainCloseout(params);
    const legacy = { ...initial.manifest };
    delete legacy.apps;
    delete legacy.appPlatforms;
    delete legacy.appcast;
    const replay = verifyStableMainCloseout({ ...params, existingManifest: legacy });
    expect(replay.errors).toEqual([]);
    expect(replay.manifest).toEqual(legacy);
    const summary = renderSummary(replay.manifest);
    expect(summary).toContain("Apps at closeout: unknown (not recorded)");
    expect(summary).toContain("Appcast at closeout: unknown (not recorded)");
    expect(summary).not.toContain("verified");
  });
});
