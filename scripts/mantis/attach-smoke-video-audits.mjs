#!/usr/bin/env node
import { closeSync, fstatSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

const [manifestArg, ...args] = process.argv.slice(2);
if (!manifestArg || args.length % 4 !== 0 || args.length > 32) {
  throw new Error(
    "Usage: attach-smoke-video-audits.mjs <manifest> [--smoke <baseline|candidate> <summary> <exit-code>]",
  );
}
const manifestPath = realpathSync(manifestArg);
const evidenceRoot = path.dirname(manifestPath);

function boundedArtifact(filePath) {
  const absolute = path.resolve(filePath);
  const relative = path.relative(evidenceRoot, absolute);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Video audit artifact escapes the evidence directory.");
  }
  if (realpathSync(absolute) !== absolute) {
    throw new Error("Video audit artifact must not traverse symlinks.");
  }
  const fd = openSync(absolute, "r");
  try {
    const maxBytes = 256 * 1024;
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new Error("Video audit artifact must be a file of at most 256 KiB.");
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes <= maxBytes) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) {
        break;
      }
      bytes += count;
    }
    if (bytes > maxBytes) {
      throw new Error("Video audit artifact exceeds 256 KiB.");
    }
    return {
      relative: relative.split(path.sep).join("/"),
      text: buffer.toString("utf8", 0, bytes),
    };
  } finally {
    closeSync(fd);
  }
}

const manifest = JSON.parse(boundedArtifact(manifestPath).text);
if (
  manifest.schemaVersion !== 2 ||
  !manifest.comparison?.candidate ||
  !Array.isArray(manifest.artifacts)
) {
  throw new Error("Expected a Mantis schemaVersion 2 evidence manifest.");
}
const reviews = [];
let smokeFailed = false;
for (let index = 0; index < args.length; index += 4) {
  const [flag, lane, summaryArg, exitArg] = args.slice(index, index + 4);
  if (
    flag !== "--smoke" ||
    !["baseline", "candidate"].includes(lane) ||
    !/^\d{1,3}$/u.test(exitArg)
  ) {
    throw new Error("Invalid smoke audit arguments.");
  }
  const review = { lane, status: "error" };
  reviews.push(review);
  try {
    const summaryFile = boundedArtifact(summaryArg);
    const summary = JSON.parse(summaryFile.text);
    if (!["pass", "fail"].includes(summary.status)) {
      throw new Error("Smoke summary has no valid outcome.");
    }
    const auditFile = boundedArtifact(summary.videoAudit.summaryPath);
    const audit = JSON.parse(auditFile.text);
    const reportFile = boundedArtifact(summary.videoAudit.reportPath);
    if (
      audit.provider !== "google" ||
      audit.model !== "gemini-3.8-flash" ||
      audit.processing !== "agentic" ||
      !["pass", "fail", "error"].includes(audit.status) ||
      audit.status !== summary.videoAudit.status ||
      (summary.status === "pass" && audit.status !== "pass") ||
      (audit.status !== "error" &&
        (audit.complete !== true ||
          !Array.isArray(audit.findings) ||
          (audit.status === "pass") !== (audit.findings.length === 0)))
    ) {
      throw new Error("Smoke video audit is incomplete or inconsistent with its persisted report.");
    }
    review.status = audit.status;
    review.reportPath = reportFile.relative;
    if (audit.status === "error") {
      review.error = String(audit.error).slice(0, 500);
    }
    // A baseline finding is reproduction evidence. Other smoke failures still
    // veto success, even when a separate video audit happened to pass.
    const expectedExit = summary.status === "pass" ? 0 : 1;
    smokeFailed ||=
      Number(exitArg) !== expectedExit ||
      (summary.status !== "pass" && !(audit.status === "fail" && !summary.error));
    for (const [kind, file, label] of [
      ["metadata", summaryFile, "Desktop smoke summary"],
      ["metadata", auditFile, "Video audit JSON"],
      ["report", reportFile, "Video audit report"],
    ]) {
      if (!manifest.artifacts.some((artifact) => artifact.path === file.relative)) {
        manifest.artifacts.push({
          kind,
          lane,
          label,
          path: file.relative,
          targetPath: file.relative,
        });
      }
    }
  } catch (error) {
    review.error = String(error.message ?? error).slice(0, 500);
  }
}

const blocked =
  manifest.comparison.outcome === "blocked" || reviews.some((review) => review.status === "error");
const candidateDefect = reviews.some(
  (review) => review.lane === "candidate" && review.status === "fail",
);
const priorPass =
  manifest.comparison.pass === true &&
  manifest.comparison.candidate.expectationMet === true &&
  (manifest.comparison.baseline?.expectationMet ?? true);
const status = blocked
  ? "blocked"
  : priorPass && !candidateDefect && !smokeFailed
    ? "pass"
    : "fail";
const note =
  reviews.length === 0
    ? "Desktop video audit skipped: no desktop capture was requested. Functional evidence only."
    : `Desktop video audit ${status}. Baseline defects remain reproduction evidence; candidate defects veto pass. Smoke failures also veto pass.`;
manifest.comparison = {
  ...manifest.comparison,
  candidate: {
    ...manifest.comparison.candidate,
    expectationMet:
      manifest.comparison.candidate.expectationMet && !candidateDefect && !blocked && !smokeFailed,
    fixed:
      manifest.comparison.candidate.expectationMet && !candidateDefect && !blocked && !smokeFailed,
  },
  pass: status === "pass",
  outcome: status,
  verdictNote: [manifest.comparison.verdictNote, note].filter(Boolean).join(" "),
};
manifest.videoAudit = { status: reviews.length === 0 ? "skipped" : status, reviews };
const reportPath = "mantis-smoke-video-audits.md";
writeFileSync(
  path.join(evidenceRoot, reportPath),
  [
    "# Mantis desktop video audits",
    "",
    note,
    "",
    ...reviews.map(
      (review) =>
        `- ${review.lane}: ${review.status}${review.reportPath ? ` ([report](${review.reportPath}))` : ""}${review.error ? ` — ${review.error}` : ""}`,
    ),
    "",
  ].join("\n"),
);
manifest.artifacts.push({
  kind: "report",
  lane: "run",
  label: "Desktop video audit results",
  path: reportPath,
  targetPath: reportPath,
});
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${status}\n`);
