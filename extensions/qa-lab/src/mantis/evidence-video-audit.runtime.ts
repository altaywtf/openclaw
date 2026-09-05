import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import { ensureRepoBoundDirectory, isRepoRootRelativeRef } from "../cli-paths.js";
import { auditMantisVideo } from "./video-audit.runtime.js";

const artifactSchema = z
  .object({
    kind: z.string().min(1).max(64),
    lane: z.enum(["baseline", "candidate", "run"]),
    label: z.string().max(512).optional(),
    path: z.string().min(1).max(1024).refine(isRepoRootRelativeRef),
  })
  .passthrough();
const laneSchema = z.object({ expectationMet: z.boolean() }).passthrough();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    id: z.string().min(1).max(256),
    title: z.string().min(1).max(512),
    scenario: z.string().min(1).max(256),
    summary: z.string().max(4096).optional(),
    comparison: z
      .object({
        baseline: laneSchema.optional(),
        candidate: laneSchema,
        pass: z.boolean(),
        outcome: z.enum(["pass", "fail", "blocked"]).optional(),
        verdictNote: z.string().max(4096).optional(),
      })
      .passthrough(),
    artifacts: z.array(artifactSchema).max(128),
  })
  .passthrough();
type VideoReview = {
  lane: "baseline" | "candidate" | "run";
  path: string;
  status: "pass" | "fail" | "error" | "missing";
  reportPath?: string;
  summaryPath?: string;
  error?: string;
};

function isMissingFile(error: unknown) {
  return isRecord(error) && (error.code === "ENOENT" || error.code === "not-found");
}

/** Audit captured media using trusted harness code, never the candidate checkout. */
export async function auditMantisEvidence(opts: {
  repoRoot: string;
  manifestPath: string;
}): Promise<{ outputDir: string; manifestPath: string; status: "pass" | "fail" | "blocked" }> {
  const repoRoot = await fs.realpath(opts.repoRoot);
  const sourcePath = path.resolve(repoRoot, opts.manifestPath);
  const outputDir = await ensureRepoBoundDirectory(
    repoRoot,
    path.dirname(sourcePath),
    "Mantis evidence audit",
  );
  const bundle = await root(outputDir);
  const source = await bundle.read(path.basename(sourcePath), { maxBytes: 256 * 1024 });
  const manifest = manifestSchema.parse(JSON.parse(source.buffer.toString("utf8")));
  const videos = manifest.artifacts.filter((artifact) => artifact.kind === "fullVideo");
  if (videos.length > 8) {
    throw new Error(
      "Mantis evidence audit supports at most eight recordings per invocation. Split the evidence bundle.",
    );
  }
  const reviews: VideoReview[] = [];
  const artifacts = [...manifest.artifacts];
  for (const video of videos) {
    const review: VideoReview = { lane: video.lane, path: video.path, status: "error" };
    reviews.push(review);
    try {
      // Open through the bundle root before handing a canonical path to media
      // inference: artifact paths must never select files outside this capture.
      const opened = await bundle.open(video.path);
      const videoPath = opened.realPath;
      await opened.handle.close();
      let events: unknown;
      const eventPath = path.join(path.dirname(video.path), "web-ui-chat-events.json");
      try {
        const eventFile = await bundle.read(eventPath, { maxBytes: 4096 });
        events = JSON.parse(eventFile.buffer.toString("utf8"));
      } catch (error) {
        if (!isMissingFile(error)) {
          throw error;
        }
      }
      const audit = await auditMantisVideo({
        repoRoot,
        outputDir,
        videoPath,
        events,
        prompt:
          video.lane === "baseline"
            ? "Inspect the baseline UI recording and report temporal defects. A baseline defect is reproduction evidence; do not assume candidate behavior from it."
            : "Inspect this candidate UI recording for transient streaming and rendering defects. Judge only the recorded actions and use supplied recording-relative events for causal hypotheses.",
      });
      review.status = audit.status;
      if (audit.status === "error") {
        review.error = audit.error.slice(0, 500);
      }
      review.reportPath = path.relative(outputDir, audit.reportPath);
      review.summaryPath = path.relative(outputDir, audit.summaryPath);
      for (const [kind, artifactPath] of [
        ["report", review.reportPath],
        ["metadata", review.summaryPath],
      ] as const) {
        artifacts.push({
          kind,
          lane: video.lane,
          label: `Video audit ${kind}: ${video.path}`,
          path: artifactPath,
          targetPath: artifactPath,
        });
      }
    } catch (error) {
      review.status = isMissingFile(error) ? "missing" : "error";
      review.error = formatErrorMessage(error).slice(0, 500);
    }
  }
  const requiredLanes = manifest.comparison.baseline ? ["baseline", "candidate"] : ["candidate"];
  const missingLanes = requiredLanes.filter((lane) => !videos.some((video) => video.lane === lane));
  const priorPass =
    manifest.comparison.pass &&
    manifest.comparison.candidate.expectationMet &&
    (manifest.comparison.baseline?.expectationMet ?? true);
  const blocked =
    (!priorPass && manifest.comparison.outcome === "blocked") ||
    missingLanes.length > 0 ||
    reviews.some((review) => review.status === "missing" || review.status === "error");
  const candidateDefect = reviews.some(
    (review) => review.lane !== "baseline" && review.status === "fail",
  );
  const status = blocked ? "blocked" : priorPass && !candidateDefect ? "pass" : "fail";
  const counts = {
    clean: reviews.filter((review) => review.status === "pass").length,
    defects: reviews.filter((review) => review.status === "fail").length,
    unavailable: reviews.filter((review) => review.status === "error").length,
    missing: reviews.filter((review) => review.status === "missing").length + missingLanes.length,
  };
  const note =
    videos.length === 0
      ? "Video audit blocked: no full recordings were supplied. Capture a video and rerun."
      : `Video audit ${status}: ${counts.clean} clean, ${counts.defects} with defects, ${counts.unavailable} unavailable, ${counts.missing} missing. Baseline defects remain reproduction evidence; candidate defects veto pass.`;
  const suffix = randomUUID();
  const reportPath = path.join(outputDir, `mantis-evidence-video-audit-${suffix}.md`);
  const summaryPath = path.join(outputDir, `mantis-evidence-video-audit-${suffix}.json`);
  const manifestPath = path.join(outputDir, `mantis-evidence-audited-${suffix}.json`);
  const summary = {
    status,
    sourceManifest: path.basename(sourcePath),
    counts,
    missingLanes,
    reviews,
  };
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  await fs.writeFile(
    reportPath,
    [
      "# Mantis evidence video audit",
      "",
      note,
      "",
      ...missingLanes.map(
        (lane) => `- Missing recording lane: ${lane}. Capture its video and rerun.`,
      ),
      ...reviews.map(
        (review) =>
          `- ${review.lane}: ${review.path} — ${review.status}${review.reportPath ? ` ([report](${review.reportPath}))` : ""}${review.error ? ` — ${review.error}` : ""}`,
      ),
      "",
    ].join("\n"),
    { flag: "wx" },
  );
  for (const [kind, artifactPath] of [
    ["report", reportPath],
    ["metadata", summaryPath],
  ] as const) {
    artifacts.push({
      kind,
      lane: "run",
      label: "Mantis evidence video audit",
      path: path.basename(artifactPath),
      targetPath: path.basename(artifactPath),
    });
  }
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        comparison: {
          ...manifest.comparison,
          candidate: {
            ...manifest.comparison.candidate,
            expectationMet:
              manifest.comparison.candidate.expectationMet && !candidateDefect && !blocked,
          },
          pass: status === "pass",
          outcome: status,
          verdictNote: [manifest.comparison.verdictNote, note].filter(Boolean).join(" "),
        },
        artifacts,
        videoAudit: summary,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  return { outputDir, manifestPath, status };
}
