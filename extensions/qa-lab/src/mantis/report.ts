import path from "node:path";
import type { MantisVideoAudit } from "./video-audit.runtime.js";

type MantisReportLine = string | undefined;

export type MantisCrabboxReportSummary = {
  artifacts: {
    reportPath: string;
    screenshotPath?: string;
    summaryPath: string;
    videoPath?: string;
  };
  crabbox: {
    bin: string;
    createdLease: boolean;
    id: string;
    provider: string;
    slug?: string;
    state?: string;
    vncCommand: string;
  };
  error?: string;
  finishedAt: string;
  outputDir: string;
  startedAt: string;
  status: "pass" | "fail";
  videoAudit?: MantisVideoAudit;
};

export function renderMantisCrabboxReport(params: {
  afterArtifacts?: MantisReportLine[];
  artifactRows: MantisReportLine[];
  beforeArtifacts?: MantisReportLine[];
  crabboxRows?: MantisReportLine[];
  headerRows: MantisReportLine[];
  summary: MantisCrabboxReportSummary;
  title: string;
}) {
  const { summary } = params;
  const { crabbox } = summary;
  const lines = [
    `# ${params.title}`,
    "",
    `Status: ${summary.status}`,
    ...params.headerRows,
    `Output: ${summary.outputDir}`,
    `Started: ${summary.startedAt}`,
    `Finished: ${summary.finishedAt}`,
    "",
    "## Crabbox",
    "",
    `- Provider: ${crabbox.provider}`,
    `- Lease: ${crabbox.id}${crabbox.slug ? ` (${crabbox.slug})` : ""}`,
    `- Created by run: ${crabbox.createdLease}`,
    `- State: ${crabbox.state ?? "unknown"}`,
    `- VNC: \`${crabbox.vncCommand}\``,
    ...(params.crabboxRows ?? []),
    "",
    ...(params.beforeArtifacts ?? []),
    "## Artifacts",
    "",
    summary.artifacts.screenshotPath
      ? `- Screenshot: \`${path.basename(summary.artifacts.screenshotPath)}\``
      : "- Screenshot: missing",
    summary.artifacts.videoPath
      ? `- Video: \`${path.basename(summary.artifacts.videoPath)}\``
      : "- Video: missing",
    ...params.artifactRows,
    "",
    ...(summary.videoAudit
      ? [
          "## Video audit",
          "",
          `Status: ${summary.videoAudit.status}`,
          `Report: [video audit](${path.relative(path.dirname(summary.artifacts.reportPath), summary.videoAudit.reportPath).split(path.sep).map(encodeURIComponent).join("/")})`,
          summary.videoAudit.status === "error"
            ? summary.videoAudit.error
            : summary.videoAudit.summary,
          "",
        ]
      : []),
    ...(params.afterArtifacts ?? []),
  ].filter((line) => line !== undefined);
  return `${lines.join("\n")}\n`;
}
