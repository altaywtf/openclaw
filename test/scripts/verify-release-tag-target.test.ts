import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const root = process.cwd();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sha = "a".repeat(40);
const moved = "b".repeat(40);
const tag = "v2026.8.1";
const workflow = parse(readFileSync(".github/workflows/linux-app-release.yml", "utf8"));
type Step = {
  name: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
const steps = workflow.jobs.publish.steps as Step[];
const attachment = "Attach bundles to the release";
const channel = "Publish desktop test update channel";
type State = {
  tagSha: string;
  readError?: boolean;
  driftOn?: "upload" | "download" | "create";
  failUpload?: boolean;
  channelExists: boolean;
  channelVersion: string;
  events: string[];
  writes: { operation: string; name: string; bytes: string; clobber: boolean }[];
};

function fixture(overrides: Partial<State> = {}) {
  const cwd = tempDirs.make("linux-app-publication-");
  const bin = path.join(cwd, "bin");
  const release = path.join(cwd, "dist/release");
  mkdirSync(bin);
  mkdirSync(release, { recursive: true });
  const checkout = steps.find((entry) => entry.name === "Checkout trusted release tooling");
  const sparseCheckout = checkout?.with?.["sparse-checkout"];
  const files = (typeof sparseCheckout === "string" ? sparseCheckout : "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  for (const file of files) {
    const destination = path.join(cwd, ".release-tooling", file);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(root, file), destination);
  }
  symlinkSync(process.execPath, path.join(bin, "node"));
  writeFileSync(path.join(bin, "package.json"), '{"type":"commonjs"}');
  for (const name of ["OpenClaw.AppImage", "OpenClaw.deb", "latest-desktop-test.json"]) {
    writeFileSync(path.join(release, name), `candidate ${name}`);
  }
  const statePath = path.join(cwd, "github.json");
  const initial: State = {
    tagSha: sha,
    channelExists: true,
    channelVersion: "2026.7.1",
    events: [],
    writes: [],
    ...overrides,
  };
  writeFileSync(statePath, JSON.stringify(initial));
  // This is the only GitHub transport in the subprocess environment. All writes
  // land in a local fixture; the production shell and verifier run unmocked.
  writeFileSync(
    path.join(bin, "gh"),
    `#!${process.execPath}
` +
      String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.MOCK_STATE, 'utf8'));
const save = () => fs.writeFileSync(process.env.MOCK_STATE, JSON.stringify(state));
const drift = (event) => { if (state.driftOn === event) state.tagSha = 'b'.repeat(40); };
if (args[0] === 'api') {
  state.events.push('verify');
  save();
  // Require cache revalidation at the actual CLI/API boundary, not in a source grep.
  if (args[args.indexOf('-H') + 1] !== 'Cache-Control: max-age=0') {
    console.error('Tag lookup must request cache revalidation'); process.exit(2);
  }
  // A same-named branch must never substitute for the exact tag namespace.
  if (decodeURIComponent(args[1]) !== 'repos/example/repository/commits/refs/tags/v2026.8.1') {
    console.error('Wrong tag namespace'); process.exit(2);
  }
  if (state.readError) { console.error('HTTP 503'); process.exit(1); }
  console.log(state.tagSha);
} else if (args[0] === 'release' && args[1] === 'view') {
  state.events.push('view'); save();
  if (!state.channelExists) process.exit(1);
  if (args.includes('--json')) console.log('true');
} else if (args[0] === 'release' && args[1] === 'download') {
  const dir = args[args.indexOf('--dir')+1];
  fs.mkdirSync(dir, {recursive:true});
  fs.writeFileSync(path.join(dir,'latest-desktop-test.json'), JSON.stringify({version:state.channelVersion}));
  state.events.push('download'); drift('download'); save();
} else if (args[0] === 'release' && args[1] === 'create') {
  state.events.push('create');
  state.writes.push({operation:'create',name:args[2],bytes:'',clobber:false});
  state.channelExists=true; drift('create'); save();
} else if (args[0] === 'release' && args[1] === 'upload') {
  for (const file of args.filter(arg => arg.startsWith('dist/release/'))) {
    state.events.push('upload');
    state.writes.push({operation:'upload',name:path.basename(file),bytes:fs.readFileSync(file,'utf8'),clobber:args.includes('--clobber')});
    drift('upload'); save();
    if (state.failUpload) { state.failUpload=false; save(); process.exit(42); }
  }
} else { console.error('Unexpected gh invocation'); process.exit(2); }
`,
    { mode: 0o755 },
  );
  const readState = () => JSON.parse(readFileSync(statePath, "utf8")) as State;
  const update = (value: Partial<State>) =>
    writeFileSync(statePath, JSON.stringify({ ...readState(), ...value }));
  const run = (name: string) => {
    const step = steps.find((entry) => entry.name === name);
    if (!step?.run) {
      throw new Error(`Missing workflow step: ${name}`);
    }
    const env: Record<string, string> = {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: cwd,
      RUNNER_TEMP: cwd,
      MOCK_STATE: statePath,
      GITHUB_REPOSITORY: "example/repository",
      RELEASE_TAG: tag,
      TAG_SHA: sha,
      DESKTOP_TEST_CHANNEL_TAG: "desktop-test",
    };
    // Resolve the workflow's actual env wiring, not a test-only SHA override.
    for (const [key, value] of Object.entries(step.env ?? {})) {
      if (value === "${{ needs.validate_release.outputs.release_tag }}") {
        env[key] = tag;
      } else if (value === "${{ needs.validate_release.outputs.tag_sha }}") {
        env[key] = sha;
      } else if (value === "${{ github.token }}") {
        env[key] = "";
      } else if (!value.includes("${{")) {
        env[key] = value;
      } else {
        throw new Error(`Unresolved workflow env: ${key}`);
      }
    }
    if (!("TAG_SHA" in (step.env ?? {}))) {
      delete env.TAG_SHA;
    }
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run],
      {
        cwd,
        env,
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    if (result.error) {
      throw result.error;
    }
    return { code: result.status, output: result.stdout + result.stderr, state: readState() };
  };
  return { run, update };
}

describe.skipIf(process.platform === "win32")("Linux publication source binding", () => {
  it("checks the validated tag before each asset and retains existing upload semantics", () => {
    const result = fixture().run(attachment);
    expect(result.code, result.output).toBe(0);
    expect(
      steps.find((entry) => entry.name === "Checkout trusted release tooling")?.with,
    ).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
    });
    expect(result.state.events).toEqual([
      "verify",
      "upload",
      "verify",
      "upload",
      "verify",
      "upload",
    ]);
    expect(result.state.writes).toHaveLength(3);
    expect(
      result.state.writes.every(
        (write) => write.clobber && write.bytes === `candidate ${write.name}`,
      ),
    ).toBe(true);
  });

  it.each([
    ["moved tag", { tagSha: moved }],
    ["missing tag", { tagSha: "" }],
    ["malformed response", { tagSha: "null" }],
    ["API error", { readError: true }],
  ] satisfies [string, Partial<State>][])(
    "refuses all attachment writes for %s",
    (_name, state) => {
      const result = fixture(state).run(attachment);
      expect(result.code).not.toBe(0);
      expect(result.state.writes).toEqual([]);
    },
  );

  it("stops remaining attachments when the tag moves after one upload", () => {
    const result = fixture({ driftOn: "upload" }).run(attachment);
    expect(result.code).not.toBe(0);
    expect(result.state.writes).toHaveLength(1);
    expect(result.state.events).toEqual(["verify", "upload", "verify"]);
  });

  it.each([false, true])("rechecks a partial-operation retry (tag drift: %s)", (drift) => {
    const test = fixture({ failUpload: true });
    const partial = test.run(attachment);
    expect(partial.code).toBe(42);
    expect(partial.state.writes).toHaveLength(1);
    if (drift) {
      test.update({ tagSha: moved });
    }
    const retry = test.run(attachment);
    expect(retry.code === 0, retry.output).toBe(!drift);
    // This prerequisite deliberately preserves manual clobber recovery; it
    // does not claim that a same-SHA rebuild is an identical-byte replay.
    expect(retry.state.writes).toHaveLength(drift ? 1 : 4);
  });

  it("checks source identity after channel reads, immediately before replacement", () => {
    const result = fixture({ driftOn: "download" }).run(channel);
    expect(result.code).not.toBe(0);
    expect(result.state.writes).toEqual([]);
    expect(result.state.events.at(-1)).toBe("verify");
  });

  it("checks source identity separately before channel creation and upload", () => {
    const result = fixture({ channelExists: false, driftOn: "create" }).run(channel);
    expect(result.code).not.toBe(0);
    expect(result.state.writes.map((write) => write.operation)).toEqual(["create"]);
    expect(result.state.events).toEqual(["view", "verify", "create", "verify"]);
  });

  it.each([false, true])("preserves channel publication (existing: %s)", (channelExists) => {
    const result = fixture({ channelExists }).run(channel);
    expect(result.code, result.output).toBe(0);
    expect(result.state.writes.map((write) => write.operation)).toEqual(
      channelExists ? ["upload"] : ["create", "upload"],
    );
  });

  it("leaves a newer desktop channel untouched", () => {
    const result = fixture({ channelVersion: "2026.9.1", tagSha: moved }).run(channel);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("leaving it unchanged");
    expect(result.state.writes).toEqual([]);
  });
});
