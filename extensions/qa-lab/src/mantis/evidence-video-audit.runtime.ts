import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import { ensureRepoBoundDirectory, isRepoRootRelativeRef } from "../cli-paths.js";
import {
  auditMantisVideo,
  mantisVideoAuditSchema,
  type MantisVideoAudit,
} from "./video-audit.runtime.js";

const artifactSchema = z
  .object({
    kind: z.string().min(1).max(64),
    lane: z.enum(["baseline", "candidate", "run"]),
    label: z.string().max(512).optional(),
    path: z.string().min(1).max(1024).refine(isRepoRootRelativeRef),
  })
  .passthrough();
const laneSchema = z
  .object({ expectationMet: z.boolean(), fixed: z.boolean().optional() })
  .passthrough();
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
const smokeResultsSchema = z
  .array(
    z
      .object({
        lane: z.enum(["baseline", "candidate"]),
        summaryPath: z.string().min(1).max(1024),
        exitCode: z.number().int().min(0).max(255),
      })
      .strict(),
  )
  .max(8);
const smokeSummarySchema = z.object({
  status: z.enum(["pass", "fail"]),
  error: z.string().optional(),
  videoAudit: z.object({
    status: z.enum(["pass", "fail", "error"]),
    summaryPath: z.string(),
    reportPath: z.string(),
  }),
});
type VideoReview = {
  lane: "baseline" | "candidate" | "run";
  path: string;
  status: "pass" | "fail" | "error" | "missing";
  reportPath?: string;
  error?: string;
};
export type MantisEvidenceAuditOptions = {
  repoRoot: string;
  manifestPath: string;
  smokeResults?: unknown;
};

/** Candidate artifacts always receive fresh inference; only explicit trusted smoke inputs reuse it. */
export async function auditMantisEvidence(opts: MantisEvidenceAuditOptions): Promise<{
  outputDir: string;
  manifestPath: string;
  reportPath: string;
  status: "pass" | "fail" | "blocked";
}> {
  const repoRoot = await fs.realpath(opts.repoRoot);
  const sourcePath = path.resolve(repoRoot, opts.manifestPath);
  const outputDir = await ensureRepoBoundDirectory(
    repoRoot,
    path.dirname(sourcePath),
    "Mantis evidence audit",
  );
  const bundle = await root(outputDir);
  async function readArtifact(filePath: string) {
    const relative = path.relative(outputDir, path.resolve(repoRoot, filePath));
    const file = await bundle.read(relative, { maxBytes: 256 * 1024 });
    return file.buffer.toString("utf8");
  }
  const manifest = manifestSchema.parse(JSON.parse(await readArtifact(sourcePath)));
  const smokeResults =
    opts.smokeResults === undefined ? undefined : smokeResultsSchema.parse(opts.smokeResults);
  const videos = manifest.artifacts.filter((artifact) => artifact.kind === "fullVideo");
  const sources =
    smokeResults?.map((smoke) => ({ ...smoke, kind: "smoke" as const })) ??
    videos.map(({ lane, path: videoPath }) => ({ lane, path: videoPath, kind: "video" as const }));
  if (sources.length > 8) {
    throw new Error(
      "Mantis evidence audit supports at most eight recordings per invocation. Split the evidence bundle.",
    );
  }
  const reviews: VideoReview[] = [];
  const artifacts = [...manifest.artifacts];
  let smokeFailed = false;
  for (const source of sources) {
    const review: VideoReview = {
      lane: source.lane,
      path:
        source.kind === "smoke"
          ? path.relative(outputDir, path.resolve(repoRoot, source.summaryPath))
          : source.path,
      status: "error",
    };
    reviews.push(review);
    try {
      let audit: MantisVideoAudit;
      const auditArtifacts: [string, string][] = [];
      if (source.kind === "smoke") {
        const summary = smokeSummarySchema.parse(
          JSON.parse(await readArtifact(source.summaryPath)),
        );
        audit = mantisVideoAuditSchema.parse(
          JSON.parse(await readArtifact(summary.videoAudit.summaryPath)),
        );
        await readArtifact(summary.videoAudit.reportPath);
        if (
          audit.status !== summary.videoAudit.status ||
          audit.summaryPath !== summary.videoAudit.summaryPath ||
          audit.reportPath !== summary.videoAudit.reportPath ||
          (summary.status === "pass" && audit.status !== "pass")
        ) {
          throw new Error("Smoke video audit is inconsistent with its persisted report.");
        }
        // Baseline defects are reproduction evidence; independent smoke/process failures still veto pass.
        smokeFailed ||=
          source.exitCode !== (summary.status === "pass" ? 0 : 1) ||
          (summary.status !== "pass" && !(audit.status === "fail" && !summary.error));
        auditArtifacts.push(["metadata", source.summaryPath]);
      } else {
        // Resolve media through the capture root before sending it to inference.
        const opened = await bundle.open(source.path);
        const videoPath = opened.realPath;
        await opened.handle.close();
        audit = await auditMantisVideo({
          repoRoot,
          outputDir,
          videoPath,
          prompt:
            source.lane === "baseline"
              ? "Inspect the baseline UI recording and report temporal defects. Baseline defects are reproduction evidence; do not assume candidate behavior from them."
              : "Inspect the candidate UI recording for transient streaming and rendering defects. Judge only recorded actions and distinguish observations from causal hypotheses.",
        });
      }
      review.status = audit.status;
      if (audit.status === "error") {
        review.error = audit.error.slice(0, 500);
      }
      review.reportPath = path.relative(outputDir, audit.reportPath);
      auditArtifacts.push(["report", audit.reportPath], ["metadata", audit.summaryPath]);
      for (const [kind, filePath] of auditArtifacts) {
        const relative = path.relative(outputDir, path.resolve(repoRoot, filePath));
        if (!artifacts.some((artifact) => artifact.path === relative)) {
          artifacts.push({
            kind,
            lane: source.lane,
            label: `Video audit ${kind}: ${review.path}`,
            path: relative,
            targetPath: relative,
          });
        }
      }
    } catch (error) {
      review.status =
        isRecord(error) && (error.code === "ENOENT" || error.code === "not-found")
          ? "missing"
          : "error";
      review.error = formatErrorMessage(error).slice(0, 500);
    }
  }
  const requiredLanes =
    smokeResults?.length === 0
      ? []
      : smokeResults === undefined && manifest.comparison.baseline
        ? ["baseline", "candidate"]
        : ["candidate"];
  const missingLanes = requiredLanes.filter(
    (lane) => !sources.some((source) => source.lane === lane),
  );
  const priorPass =
    manifest.comparison.pass &&
    manifest.comparison.candidate.expectationMet &&
    (manifest.comparison.baseline?.expectationMet ?? true);
  const blocked =
    manifest.comparison.outcome === "blocked" ||
    missingLanes.length > 0 ||
    reviews.some((review) => review.status === "missing" || review.status === "error");
  const candidateDefect = reviews.some(
    (review) => review.lane !== "baseline" && review.status === "fail",
  );
  const status = blocked
    ? "blocked"
    : priorPass && !candidateDefect && !smokeFailed
      ? "pass"
      : "fail";
  const skipped = smokeResults !== undefined && sources.length === 0;
  const note = skipped
    ? "Desktop video audit skipped: no desktop capture was requested. Functional evidence only."
    : `Video audit ${status}. Baseline defects remain reproduction evidence; candidate defects and smoke failures veto pass.`;
  const suffix = randomUUID();
  const reportPath = path.join(outputDir, `mantis-evidence-video-audit-${suffix}.md`);
  const manifestPath = path.join(outputDir, `mantis-evidence-audited-${suffix}.json`);
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
  artifacts.push({
    kind: "report",
    lane: "run",
    label: "Mantis evidence video audit",
    path: path.basename(reportPath),
    targetPath: path.basename(reportPath),
  });
  const expectationMet =
    manifest.comparison.candidate.expectationMet && !candidateDefect && !blocked && !smokeFailed;
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        comparison: {
          ...manifest.comparison,
          candidate: {
            ...manifest.comparison.candidate,
            expectationMet,
            ...(manifest.comparison.candidate.fixed === undefined ? {} : { fixed: expectationMet }),
          },
          pass: status === "pass",
          outcome: status,
          verdictNote: [manifest.comparison.verdictNote, note].filter(Boolean).join(" "),
        },
        artifacts,
        videoAudit: {
          status: skipped ? "skipped" : status,
          sourceManifest: path.basename(sourcePath),
          missingLanes,
          reviews,
        },
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  return { outputDir, manifestPath, reportPath, status };
}
