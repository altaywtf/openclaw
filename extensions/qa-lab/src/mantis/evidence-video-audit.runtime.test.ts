import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditMantisEvidence } from "./evidence-video-audit.runtime.js";

const mocks = vi.hoisted(() => ({ auditMantisVideo: vi.fn() }));
vi.mock("./video-audit.runtime.js", () => mocks);

describe("Mantis evidence video audit", () => {
  let repoRoot: string;
  let outputDir: string;
  let manifestPath: string;

  beforeEach(async () => {
    repoRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "mantis-evidence-audit-")),
    );
    outputDir = path.join(repoRoot, "evidence");
    manifestPath = path.join(outputDir, "mantis-evidence.json");
    await fs.mkdir(outputDir);
    mocks.auditMantisVideo.mockReset();
  });
  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  async function writeManifest(
    paths = ["baseline/run.webm", "candidate/run.webm"],
    priorPass = true,
  ) {
    const manifest = {
      schemaVersion: 2,
      id: "web-ui-chat-proof",
      title: "Web UI proof",
      scenario: "web-ui-chat-proof",
      comparison: {
        baseline: { expectationMet: true, status: "fail" },
        candidate: { expectationMet: priorPass, status: priorPass ? "pass" : "fail" },
        pass: priorPass,
        outcome: priorPass ? "pass" : "fail",
      },
      artifacts: paths.map((videoPath) => ({
        kind: "fullVideo",
        lane: videoPath.startsWith("baseline/") ? "baseline" : "candidate",
        path: videoPath,
        targetPath: videoPath,
        required: false,
      })),
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    return manifest;
  }

  async function writeRecordings() {
    for (const lane of ["baseline", "candidate"]) {
      await fs.mkdir(path.join(outputDir, lane));
      await fs.writeFile(path.join(outputDir, lane, "run.webm"), "recording");
    }
  }

  function mockAuditResults(statuses: string[]) {
    let index = 0;
    mocks.auditMantisVideo.mockImplementation(async ({ videoPath }: { videoPath: string }) => {
      expect(await fs.readFile(videoPath, "utf8")).toBe("recording");
      const status = statuses[index];
      const directory = await fs.mkdtemp(path.join(outputDir, "audit-stub-"));
      const reportPath = path.join(directory, "audit.md");
      const summaryPath = path.join(directory, "audit.json");
      await fs.writeFile(reportPath, `Status: ${status}`);
      await fs.writeFile(summaryPath, JSON.stringify({ status }));
      index += 1;
      return {
        status,
        reportPath,
        summaryPath,
        ...(status === "error" ? { error: "Google authentication unavailable" } : {}),
      };
    });
  }

  it.each([
    { baseline: "fail", candidate: "pass", priorPass: true, expected: "pass" },
    { baseline: "fail", candidate: "fail", priorPass: true, expected: "fail" },
    { baseline: "error", candidate: "pass", priorPass: true, expected: "blocked" },
    { baseline: "fail", candidate: "error", priorPass: true, expected: "blocked" },
    { baseline: "pass", candidate: "pass", priorPass: false, expected: "fail" },
  ])(
    "keeps baseline $baseline and candidate $candidate evidence at $expected",
    async ({ baseline, candidate, priorPass, expected }) => {
      const original = await writeManifest(undefined, priorPass);
      await writeRecordings();
      const events = [
        { id: "final", timestampMs: 200, description: "Gateway final reply emitted" },
      ];
      await fs.writeFile(
        path.join(outputDir, "candidate", "web-ui-chat-events.json"),
        JSON.stringify(events),
      );
      mockAuditResults([baseline, candidate]);

      const result = await auditMantisEvidence({ repoRoot, manifestPath });
      expect(result.status).toBe(expected);
      expect(result.outputDir).toBe(outputDir);
      expect(result.manifestPath).not.toBe(manifestPath);
      expect(JSON.parse(await fs.readFile(manifestPath, "utf8"))).toEqual(original);
      const audited = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
      expect(audited.comparison).toMatchObject({ pass: expected === "pass", outcome: expected });
      expect(audited.videoAudit.reviews.map((review: { status: string }) => review.status)).toEqual(
        [baseline, candidate],
      );
      expect(
        audited.artifacts.filter((artifact: { kind: string }) => artifact.kind === "report"),
      ).toHaveLength(3);
      const targets = audited.artifacts.map(
        (artifact: { targetPath: string }) => artifact.targetPath,
      );
      expect(new Set(targets).size).toBe(targets.length);
      expect(mocks.auditMantisVideo).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          events,
          videoPath: path.join(outputDir, "candidate", "run.webm"),
        }),
      );
      for (const artifact of audited.artifacts) {
        expect(path.resolve(outputDir, artifact.path).startsWith(`${outputDir}${path.sep}`)).toBe(
          true,
        );
      }
    },
  );

  it.each([{ paths: [] }, { paths: ["candidate/missing.webm"] }])(
    "records blocked proof for missing recordings: $paths",
    async ({ paths }) => {
      await writeManifest(paths);
      const result = await auditMantisEvidence({ repoRoot, manifestPath });
      expect(result.status).toBe("blocked");
      expect(mocks.auditMantisVideo).not.toHaveBeenCalled();
      const audited = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
      expect(audited.comparison.pass).toBe(false);
      expect(audited.comparison.candidate.expectationMet).toBe(false);
    },
  );

  it("retains earlier audit evidence when rerun against the same capture", async () => {
    await writeManifest();
    await writeRecordings();
    mockAuditResults(["fail", "pass", "fail", "pass"]);
    const first = await auditMantisEvidence({ repoRoot, manifestPath });
    const firstBytes = await fs.readFile(first.manifestPath);
    const second = await auditMantisEvidence({ repoRoot, manifestPath });
    expect(first.manifestPath).not.toBe(second.manifestPath);
    expect(await fs.readFile(first.manifestPath)).toEqual(firstBytes);
    expect(mocks.auditMantisVideo).toHaveBeenCalledTimes(4);
  });

  it("does not treat baseline-only video as candidate coverage", async () => {
    await writeManifest(["baseline/run.webm"]);
    await writeRecordings();
    mockAuditResults(["fail"]);
    const result = await auditMantisEvidence({ repoRoot, manifestPath });
    expect(result.status).toBe("blocked");
    const audited = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    expect(audited.videoAudit.missingLanes).toEqual(["candidate"]);
  });

  it("accepts the existing schema 2 manifest contract without optional outcome", async () => {
    const manifest = await writeManifest();
    const { outcome: _outcome, ...comparison } = manifest.comparison;
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, comparison }));
    await writeRecordings();
    mockAuditResults(["fail", "pass"]);
    expect((await auditMantisEvidence({ repoRoot, manifestPath })).status).toBe("pass");
  });

  it("blocks oversized event evidence before passing it to inference", async () => {
    await writeManifest();
    await writeRecordings();
    await fs.writeFile(
      path.join(outputDir, "candidate", "web-ui-chat-events.json"),
      " ".repeat(4097),
    );
    mockAuditResults(["pass"]);
    const result = await auditMantisEvidence({ repoRoot, manifestPath });
    expect(result.status).toBe("blocked");
    expect(mocks.auditMantisVideo).toHaveBeenCalledOnce();
    const audited = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    expect(audited.videoAudit.reviews[1].error).toEqual(expect.any(String));
    expect(audited.videoAudit.reviews[1].error).not.toBe("");
  });

  it("rejects a manifest selecting media outside its bundle", async () => {
    await writeManifest(["../private.webm"]);
    await expect(auditMantisEvidence({ repoRoot, manifestPath })).rejects.toThrow();
    expect(mocks.auditMantisVideo).not.toHaveBeenCalled();
  });

  it("blocks symlink media that selects a file outside its bundle", async () => {
    await writeManifest(["outside.webm"]);
    await fs.writeFile(path.join(repoRoot, "private.webm"), "private");
    await fs.symlink(path.join(repoRoot, "private.webm"), path.join(outputDir, "outside.webm"));
    const result = await auditMantisEvidence({ repoRoot, manifestPath });
    expect(result.status).toBe("blocked");
    expect(mocks.auditMantisVideo).not.toHaveBeenCalled();
  });
});
