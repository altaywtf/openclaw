import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditMantisEvidence } from "./evidence-video-audit.runtime.js";

const mocks = vi.hoisted(() => ({ auditMantisVideo: vi.fn() }));
vi.mock("./video-audit.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./video-audit.runtime.js")>()),
  ...mocks,
}));

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
        candidate: {
          expectationMet: priorPass,
          fixed: priorPass,
          status: priorPass ? "pass" : "fail",
        },
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
  async function writeAudit(status: "pass" | "fail" | "error") {
    const directory = await fs.mkdtemp(path.join(outputDir, "video-audit-"));
    const audit = {
      provider: "google",
      model: "gemini-3.8-flash",
      processing: "agentic",
      status,
      videoPath: path.join(outputDir, "candidate/run.webm"),
      reportPath: path.join(directory, "video-audit.md"),
      summaryPath: path.join(directory, "video-audit.json"),
      ...(status === "error"
        ? { error: "Google authentication unavailable" }
        : {
            summary: "Audited recording",
            coverage: "Full recording",
            complete: true,
            sha256: "a".repeat(64),
            findings:
              status === "fail"
                ? [
                    {
                      startMs: 50,
                      endMs: 75,
                      observation: "Flicker",
                      expected: "Stable text",
                      causeHypothesis: "Render update",
                    },
                  ]
                : [],
          }),
    };
    await fs.writeFile(audit.reportPath, `Status: ${status}`);
    await fs.writeFile(audit.summaryPath, JSON.stringify(audit));
    return audit;
  }
  async function writeRecordings(statuses: ("pass" | "fail" | "error")[]) {
    for (const lane of ["baseline", "candidate"]) {
      await fs.mkdir(path.join(outputDir, lane), { recursive: true });
      await fs.writeFile(path.join(outputDir, lane, "run.webm"), "recording");
    }
    for (const status of statuses) {
      mocks.auditMantisVideo.mockResolvedValueOnce(await writeAudit(status));
    }
  }
  async function writeSmoke(
    lane: "baseline" | "candidate",
    auditStatus: "pass" | "fail" | "error",
    opts: { status?: string; error?: string; exitCode?: number } = {},
  ) {
    const audit = await writeAudit(auditStatus);
    const status = opts.status ?? (auditStatus === "pass" ? "pass" : "fail");
    const summary = { status, error: opts.error, videoAudit: audit };
    const input = {
      lane,
      summaryPath: path.join(outputDir, `${lane}-smoke.json`),
      exitCode: opts.exitCode ?? (status === "pass" ? 0 : 1),
    };
    await fs.writeFile(input.summaryPath, JSON.stringify(summary));
    return { audit, summary, input };
  }
  async function readResult(smokeResults?: unknown) {
    const result = await auditMantisEvidence({ repoRoot, manifestPath, smokeResults });
    return { ...result, manifest: JSON.parse(await fs.readFile(result.manifestPath, "utf8")) };
  }

  it.each(["recordings", "smoke"] as const)(
    "reconciles %s evidence without upgrading failures or rejecting baseline defects",
    async (mode) => {
      for (const [baseline, candidate, priorPass, expected] of [
        ["fail", "pass", true, "pass"],
        ["fail", "fail", true, "fail"],
        ["error", "pass", true, "blocked"],
        ["fail", "error", true, "blocked"],
        ["pass", "pass", false, "fail"],
      ] as const) {
        const original = await writeManifest(undefined, priorPass);
        let smokeResults;
        if (mode === "smoke") {
          smokeResults = [
            (await writeSmoke("baseline", baseline)).input,
            (await writeSmoke("candidate", candidate)).input,
          ];
        } else {
          await writeRecordings([baseline, candidate]);
        }
        const result = await readResult(smokeResults);
        expect(result.status, `${baseline}/${candidate}/${priorPass}`).toBe(expected);
        expect(result.manifest.comparison).toMatchObject({
          pass: expected === "pass",
          outcome: expected,
        });
        expect(result.manifest.comparison.candidate.fixed).toBe(expected === "pass");
        expect(
          result.manifest.videoAudit.reviews.map((review: { status: string }) => review.status),
        ).toEqual([baseline, candidate]);
        expect(JSON.parse(await fs.readFile(manifestPath, "utf8"))).toEqual(original);
        expect(await fs.readFile(result.reportPath, "utf8")).toContain(expected);
        const reports = result.manifest.artifacts.filter(
          (artifact: { kind: string }) => artifact.kind === "report",
        );
        expect(reports).toHaveLength(3);
        for (const report of reports) {
          expect(await fs.readFile(path.join(outputDir, report.path), "utf8")).not.toBe("");
          expect(report.targetPath).toBe(report.path);
        }
      }
      expect(mocks.auditMantisVideo).toHaveBeenCalledTimes(mode === "smoke" ? 0 : 10);
    },
  );

  it.each([{ paths: [] }, { paths: ["candidate/missing.webm"] }, { paths: ["baseline/run.webm"] }])(
    "blocks incomplete recording coverage: %j",
    async ({ paths }) => {
      await writeManifest(paths);
      await writeRecordings(["fail"]);
      const result = await readResult();
      expect(result.status).toBe("blocked");
      expect(result.manifest.comparison.candidate.expectationMet).toBe(false);
      expect(
        result.manifest.videoAudit.missingLanes.length +
          result.manifest.videoAudit.reviews.filter(
            (review: { status: string }) => review.status === "missing",
          ).length,
      ).toBeGreaterThan(0);
    },
  );

  it("retains previous audit evidence and accepts schema 2 without optional outcome", async () => {
    const original = await writeManifest();
    const { outcome: _outcome, ...comparison } = original.comparison;
    await fs.writeFile(manifestPath, JSON.stringify({ ...original, comparison }));
    await writeRecordings(["fail", "pass", "fail", "pass"]);
    const first = await readResult();
    const bytes = await fs.readFile(first.manifestPath);
    const second = await readResult();
    expect(first.status).toBe("pass");
    expect(second.manifestPath).not.toBe(first.manifestPath);
    expect(await fs.readFile(first.manifestPath)).toEqual(bytes);
  });

  it.each(["traversal", "symlink"])(
    "rejects %s media escaping the capture bundle",
    async (failure) => {
      await writeManifest([failure === "traversal" ? "../private.webm" : "outside.webm"]);
      await fs.writeFile(path.join(repoRoot, "private.webm"), "private");
      if (failure === "traversal") {
        await expect(readResult()).rejects.toThrow();
      } else {
        await fs.symlink(path.join(repoRoot, "private.webm"), path.join(outputDir, "outside.webm"));
        expect((await readResult()).status).toBe("blocked");
      }
      expect(mocks.auditMantisVideo).not.toHaveBeenCalled();
    },
  );

  it.each([
    { priorPass: false, status: "pass", exitCode: 0 },
    { priorPass: true, status: "fail", exitCode: 1, error: "Gateway failed" },
    { priorPass: true, status: "pass", exitCode: 2 },
  ])("preserves independent smoke and process failures: %j", async ({ priorPass, ...opts }) => {
    await writeManifest([], priorPass);
    const smoke = await writeSmoke("candidate", "pass", opts);
    expect((await readResult([smoke.input])).status).toBe("fail");
    expect(mocks.auditMantisVideo).not.toHaveBeenCalled();
  });

  it.each([
    "malformed",
    "incomplete",
    "disagrees",
    "oversized",
    "outside",
    "symlink",
    "missing",
    "redirected-json",
  ])("blocks %s persisted evidence before publication", async (failure) => {
    await writeManifest([]);
    const { audit, summary, input } = await writeSmoke("candidate", "pass");
    if (failure === "malformed") {
      await fs.writeFile(audit.summaryPath, "{");
    }
    if (failure === "incomplete") {
      await fs.writeFile(audit.summaryPath, JSON.stringify({ ...audit, complete: false }));
    }
    if (failure === "disagrees") {
      await fs.writeFile(
        input.summaryPath,
        JSON.stringify({ ...summary, videoAudit: { ...audit, status: "fail" } }),
      );
    }
    if (failure === "oversized") {
      await fs.writeFile(audit.reportPath, "x".repeat(256 * 1024 + 1));
    }
    const privatePath = path.join(repoRoot, "private.md");
    await fs.writeFile(privatePath, "private content");
    if (failure === "outside") {
      await fs.writeFile(
        input.summaryPath,
        JSON.stringify({ ...summary, videoAudit: { ...audit, reportPath: privatePath } }),
      );
    }
    if (failure === "redirected-json") {
      await fs.writeFile(audit.summaryPath, JSON.stringify({ ...audit, summaryPath: privatePath }));
    }
    if (failure === "symlink") {
      await fs.rm(audit.reportPath);
      await fs.symlink(privatePath, audit.reportPath);
    }
    if (failure === "missing") {
      await fs.rm(input.summaryPath);
    }
    const result = await readResult([input]);
    expect(result.status).toBe("blocked");
    expect(result.manifest.videoAudit.reviews[0].error).toEqual(expect.any(String));
    expect(JSON.stringify(result.manifest)).not.toContain("private content");
    expect(
      result.manifest.artifacts.some((artifact: { path: string }) =>
        artifact.path.includes("private"),
      ),
    ).toBe(false);
  });

  it("only skips video inference when the caller explicitly supplies empty smoke results", async () => {
    const manifest = await writeManifest();
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, smokeResults: [], videoAudit: { status: "pass" } }),
    );
    await writeRecordings(["fail", "pass"]);
    expect((await readResult()).status).toBe("pass");
    expect(mocks.auditMantisVideo).toHaveBeenCalledTimes(2);
    const result = await readResult([]);
    expect(result.status).toBe("pass");
    expect(result.manifest.videoAudit).toMatchObject({ status: "skipped", reviews: [] });
    expect(await fs.readFile(result.reportPath, "utf8")).toContain("Functional evidence only");
    expect(mocks.auditMantisVideo).toHaveBeenCalledTimes(2);
  });

  it.each([
    { lane: "baseline" as const, status: "blocked" },
    { lane: "candidate" as const, status: "pass" },
  ])("requires candidate coverage for nonempty smoke results: $lane", async ({ lane, status }) => {
    await writeManifest([]);
    const { input } = await writeSmoke(lane, "pass");
    const result = await readResult([input]);
    expect(result.status).toBe(status);
    expect(result.manifest.videoAudit.missingLanes).toEqual(
      lane === "baseline" ? ["candidate"] : [],
    );
    expect(mocks.auditMantisVideo).not.toHaveBeenCalled();
  });

  it("bounds the explicit smoke result batch", async () => {
    await writeManifest([]);
    const { input } = await writeSmoke("candidate", "pass");
    await expect(readResult(Array.from({ length: 9 }, () => input))).rejects.toThrow();
    expect(mocks.auditMantisVideo).not.toHaveBeenCalled();
  });
});
