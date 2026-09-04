import { execFileSync } from "node:child_process";
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

function renderSummary(manifest: unknown) {
  const workflow = parse(
    readFileSync(".github/workflows/openclaw-stable-main-closeout.yml", "utf8"),
  ) as { jobs: { verify: { steps: { name: string; run?: string }[] } } };
  const run = workflow.jobs.verify.steps.find(
    (step) => step.name === "Verify stable state and write closeout manifest",
  )?.run;
  // Execute the workflow-owned jq program, not a test copy of its rendering.
  const filter = /^jq -r '([\s\S]*?)' \\\n/mu.exec(run ?? "")?.[1];
  if (!filter) {
    throw new Error("Missing closeout summary jq program");
  }
  return execFileSync("jq", ["-r", filter], {
    input: JSON.stringify(manifest),
    encoding: "utf8",
  });
}

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
