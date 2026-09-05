import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditMantisVideo } from "./video-audit.runtime.js";

const mocks = vi.hoisted(() => ({ understand: vi.fn() }));
vi.mock("openclaw/plugin-sdk/media-understanding-runtime", () => ({
  runMediaUnderstandingFile: mocks.understand,
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: () => ({
    tools: { media: { models: [{ provider: "other", capabilities: ["video"] }] } },
  }),
}));

const cleanReport = {
  summary: "No observed defects.",
  coverage: "The full visible flow.",
  complete: true,
  findings: [],
};
const temporalReport = {
  ...cleanReport,
  summary: "A partial reply disappears before final completion.",
  findings: [
    {
      startMs: 1250,
      endMs: 1400,
      observation: "Streamed text vanishes briefly.",
      expected: "The partial reply stays visible.",
      causeHypothesis: "A render replacement may remove the partial message.",
      evidenceEventIds: ["delta-1"],
    },
  ],
};

describe("Mantis agentic video audit", () => {
  let repoRoot: string;
  let videoPath: string;
  beforeEach(async () => {
    repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mantis-video-audit-")));
    videoPath = path.join(repoRoot, "recording.mp4");
    await fs.writeFile(videoPath, "finalized recording fixture");
    mocks.understand.mockReset().mockResolvedValue({
      provider: "google",
      model: "gemini-3.8-flash",
      text: JSON.stringify(cleanReport),
      output: { processing: { mode: "agentic", verified: true } },
    });
  });
  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it.each([false, true])(
    "sends the finalized video and retains replay evidence (fenced JSON: %s)",
    async (fenced) => {
      if (fenced) {
        mocks.understand.mockResolvedValue({
          provider: "google",
          model: "gemini-3.8-flash",
          text: "```json\n" + JSON.stringify(cleanReport) + "\n```",
          output: { processing: { mode: "agentic", verified: true } },
        });
      }
      const opts = { repoRoot, outputDir: path.join(repoRoot, "audits"), videoPath };
      const first = await auditMantisVideo(opts);
      const second = await auditMantisVideo(opts);
      expect(first.status).toBe("pass");
      expect(second.summaryPath).not.toBe(first.summaryPath);
      expect(JSON.parse(await fs.readFile(first.summaryPath, "utf8"))).toMatchObject({
        status: "pass",
        model: "gemini-3.8-flash",
        processing: "agentic",
        findings: [],
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(mocks.understand).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: "video",
          filePath: videoPath,
          cfg: expect.objectContaining({
            tools: expect.objectContaining({
              media: expect.objectContaining({
                models: [
                  { provider: "google", model: "gemini-3.8-flash", capabilities: ["video"] },
                ],
              }),
            }),
          }),
        }),
      );
    },
  );

  it("reports a temporal defect and links only supplied recording-relative events", async () => {
    mocks.understand.mockResolvedValueOnce({
      provider: "google",
      model: "gemini-3.8-flash",
      text: JSON.stringify(temporalReport),
      output: { processing: { mode: "agentic", verified: true } },
    });
    const result = await auditMantisVideo({
      repoRoot,
      outputDir: path.join(repoRoot, "audits"),
      videoPath,
      events: [{ id: "delta-1", timestampMs: 1200, description: "Gateway emitted a text delta." }],
    });
    expect(result.status).toBe("fail");
    expect(await fs.readFile(result.reportPath, "utf8")).toContain("1250–1400 ms");
    expect(await fs.readFile(result.reportPath, "utf8")).toContain("Cause hypothesis (unverified)");
    expect(mocks.understand).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('"timestampMs":1200') }),
    );
  });

  it.each([
    {
      name: "unverified navigation",
      override: { output: { processing: { mode: "agentic", verified: false } } },
    },
    { name: "substituted provider", override: { provider: "other" } },
    { name: "invalid report", override: { text: "not JSON" } },
    {
      name: "incomplete coverage",
      override: { text: JSON.stringify({ ...cleanReport, complete: false }) },
    },
    { name: "invented evidence", override: { text: JSON.stringify(temporalReport) } },
    {
      name: "reversed timestamps",
      override: {
        text: JSON.stringify({
          ...cleanReport,
          findings: [
            { ...temporalReport.findings[0], startMs: 1500, endMs: 1000, evidenceEventIds: [] },
          ],
        }),
      },
    },
  ])("records $name as an audit error, never a clean verdict", async ({ override }) => {
    mocks.understand.mockResolvedValueOnce({
      provider: "google",
      model: "gemini-3.8-flash",
      text: JSON.stringify(cleanReport),
      output: { processing: { mode: "agentic", verified: true } },
      ...override,
    });
    const result = await auditMantisVideo({
      repoRoot,
      outputDir: path.join(repoRoot, "audits"),
      videoPath,
    });
    expect(result.status).toBe("error");
    expect(JSON.parse(await fs.readFile(result.summaryPath, "utf8"))).toMatchObject({
      status: "error",
      error: expect.any(String),
    });
  });

  it("retains a provider failure without deleting the source recording", async () => {
    mocks.understand.mockRejectedValueOnce(new Error("Provider authentication unavailable"));
    const result = await auditMantisVideo({
      repoRoot,
      outputDir: path.join(repoRoot, "audits"),
      videoPath,
    });
    expect(result).toMatchObject({ status: "error", error: "Provider authentication unavailable" });
    expect(await fs.readFile(videoPath, "utf8")).toBe("finalized recording fixture");
  });
});
