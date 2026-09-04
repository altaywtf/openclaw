import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const EXPECTED_NODE = "v26.8.1";
const EXPECTED_PNPM = "12.1.0";
const MAX_DIFF_ENTRIES = 30;
const MAX_SUMMARY_BYTES = 256 * 1024;
const command = process.argv[2];
const args = process.argv.slice(3);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  return JSON.stringify(value) ?? "undefined";
}

function run(bin, commandArgs, options = {}) {
  const logFile = options.logFile;
  const logFd = logFile ? fs.openSync(logFile, "a") : undefined;
  try {
    const result = spawnSync(bin, commandArgs, {
      cwd: options.cwd,
      env: options.env,
      encoding: options.capture ? "utf8" : undefined,
      stdio: options.capture
        ? ["ignore", "pipe", "pipe"]
        : logFd === undefined
          ? "inherit"
          : ["ignore", logFd, logFd],
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`${bin} ${commandArgs.join(" ")} exited ${result.status}`);
    }
    return options.capture ? result.stdout.trim() : "";
  } finally {
    if (logFd !== undefined) {
      fs.closeSync(logFd);
    }
  }
}

function instrument(root) {
  const sourcePath = path.join(root, "scripts/lib/compiler-input-snapshot.mts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const fieldMarker = "  private tools?: string;\n  readonly rootDir: string;";
  const signatureMarker =
    "  signature(config: string, args: string[], inputs: string[], outputRoot?: string) {\n" +
    "    const parsed = this.config(config);";
  const sealMarker =
    "  ) {\n" +
    "    const signature = this.signature(config, args, inputs, outputRoot);\n" +
    "    if (\n" +
    "      before.namespace(outputRoot) !== this.namespace(outputRoot) ||";
  if (
    !source.includes(fieldMarker) ||
    !source.includes(signatureMarker) ||
    !source.includes(sealMarker)
  ) {
    throw new Error("compiler snapshot diagnostic marker missing");
  }

  const fields = `  private tools?: string;
  private diagnosticSealing = false;
  private readonly diagnosticTopologyNamespaces = new Set<string>();
  readonly rootDir: string;`;

  const signature = `  signature(config: string, args: string[], inputs: string[], outputRoot?: string) {
    const diagnosticEvent = this.diagnosticSealing
      ? "seal"
      : inputs.length > 0
        ? "lookup-stored"
        : "lookup-empty";
    const diagnosticFile = process.env.OPENCLAW_DECLARATION_CACHE_DIAGNOSTIC_FILE;
    if (diagnosticFile) {
      const parseGroup = () =>
        args
          .map((arg) => {
            try {
              return JSON.parse(arg);
            } catch {
              return null;
            }
          })
          .find((value) => value && typeof value === "object" && "name" in value)?.name ?? null;
      const group = parseGroup();
      const missingInputs = inputs.filter(
        (file) => !fs.existsSync(path.resolve(this.rootDir, file)),
      );
      fs.mkdirSync(path.dirname(diagnosticFile), { recursive: true });
      fs.appendFileSync(
        diagnosticFile,
        \`\${JSON.stringify({
          phase: "before-hash",
          event: diagnosticEvent,
          group,
          config,
          inputs,
          missingInputs,
        })}\\n\`,
      );
      try {
        const parsedDiagnostic = this.config(config);
        const namespace = this.namespace(outputRoot);
        let includeTopology = false;
        if (!this.diagnosticTopologyNamespaces.has(namespace)) {
          this.diagnosticTopologyNamespaces.add(namespace);
          const topologyMarker = \`\${diagnosticFile}.topology-\${namespace}\`;
          try {
            fs.closeSync(fs.openSync(topologyMarker, "wx"));
            includeTopology = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
              throw error;
            }
          }
        }
        const normalize = (value: unknown) =>
          JSON.parse(
            JSON.stringify(value, (_key, candidate: unknown) => {
              const normalized =
                typeof candidate === "string" ? path.normalize(candidate) : candidate;
              return normalized === this.rootDir
                ? "."
                : typeof normalized === "string" &&
                    normalized.startsWith(\`\${this.rootDir}\${path.sep}\`)
                  ? portableRelativePath(this.rootDir, normalized)
                  : candidate;
            }),
          );
        const hashOrMissing = (file: string) => {
          try {
            return { path: normalize(file), hash: this.hash(file) };
          } catch (error) {
            return {
              path: normalize(file),
              missing: !fs.existsSync(path.resolve(this.rootDir, file)),
              error: error instanceof Error ? error.name : "unknown",
            };
          }
        };
        const topologyEntries = (this.topology ?? [])
          .filter(
            ({ directory }) =>
              !outputRoot ||
              (directory !== outputRoot && !directory.startsWith(\`\${outputRoot}\${path.sep}\`)),
          )
          .map(({ name }) => ({ name, nameHash: digest(name) }));
        const payload = {
          phase: "components",
          event: diagnosticEvent,
          group,
          config,
          namespace,
          ...(includeTopology ? { topologyEntries } : {}),
          outputRoot: normalize(outputRoot),
          toolchain: this.toolchain(),
          toolInputs: this.toolInputs().map(hashOrMissing),
          identityArgs: normalize(args),
          options: normalize(parsedDiagnostic.options),
          roots: parsedDiagnostic.roots.map((file) =>
            portableRelativePath(this.rootDir, file),
          ),
          configFiles: parsedDiagnostic.files.map(hashOrMissing),
          inputs: inputs.map(hashOrMissing),
          missingInputs,
          runtime: {
            node: process.versions.node,
            platform: process.platform,
            arch: process.arch,
          },
        };
        fs.appendFileSync(diagnosticFile, \`\${JSON.stringify(payload)}\\n\`);
      } catch (error) {
        fs.appendFileSync(
          diagnosticFile,
          \`\${JSON.stringify({
            phase: "components-error",
            event: diagnosticEvent,
            group,
            error: error instanceof Error ? error.message : String(error),
          })}\\n\`,
        );
      }
    }
    const parsed = this.config(config);`;

  const seal = `  ) {
    this.diagnosticSealing = true;
    let signature: string;
    try {
      signature = this.signature(config, args, inputs, outputRoot);
    } finally {
      this.diagnosticSealing = false;
    }
    if (
      before.namespace(outputRoot) !== this.namespace(outputRoot) ||`;

  fs.writeFileSync(
    sourcePath,
    source
      .replace(fieldMarker, fields)
      .replace(signatureMarker, signature)
      .replace(sealMarker, seal),
  );
  return digest(fs.readFileSync(sourcePath));
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function eventCounts(entries) {
  const counts = {};
  for (const entry of entries) {
    const key = `${entry.phase}:${entry.event}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function readPartialEvents(file) {
  if (!fs.existsSync(file)) {
    return { entries: [], parseErrors: 0 };
  }
  const entries = [];
  let parseErrors = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      parseErrors += 1;
    }
  }
  return { entries, parseErrors };
}

function logTail(file) {
  if (!fs.existsSync(file)) {
    return { present: false, lines: [] };
  }
  const size = fs.statSync(file).size;
  const length = Math.min(size, 8 * 1024);
  const bytes = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, bytes, 0, length, size - length);
  } finally {
    fs.closeSync(fd);
  }
  return {
    present: true,
    lines: bytes.toString("utf8").split("\n").slice(-40),
  };
}

function partialEventSummary(file) {
  const { entries, parseErrors } = readPartialEvents(file);
  return {
    parseErrors,
    eventCounts: eventCounts(entries),
    groups: [
      ...new Set(entries.map((entry) => entry.group).filter((group) => typeof group === "string")),
    ]
      .toSorted((left, right) => left.localeCompare(right))
      .slice(0, MAX_DIFF_ENTRIES),
    componentErrors: entries
      .filter((entry) => entry.phase === "components-error")
      .slice(0, MAX_DIFF_ENTRIES)
      .map(({ event, group, error }) => ({ event, group, error })),
    missingInputs: entries
      .filter((entry) => entry.phase === "before-hash" && entry.missingInputs?.length)
      .slice(0, MAX_DIFF_ENTRIES)
      .map(({ event, group, missingInputs }) => ({ event, group, missingInputs })),
  };
}

function failureEvidence(params) {
  return {
    cold: {
      events: partialEventSummary(params.coldEvents),
      logTail: logTail(params.coldLog),
    },
    warm: {
      events: partialEventSummary(params.warmEvents),
      logTail: logTail(params.warmLog),
    },
  };
}

function topologyByNamespace(entries) {
  return new Map(
    entries
      .filter((entry) => entry.phase === "components" && entry.topologyEntries)
      .map((entry) => [entry.namespace, entry.topologyEntries]),
  );
}

function selectedByGroup(entries, event) {
  const selected = new Map();
  for (const entry of entries) {
    if (
      entry.phase === "components" &&
      entry.event === event &&
      entry.group &&
      !selected.has(entry.group)
    ) {
      selected.set(entry.group, entry);
    }
  }
  return selected;
}

function multiset(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const key = stable(entry);
    counts.set(key, { entry, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  return counts;
}

function multisetDiff(left, right) {
  const leftCounts = multiset(left);
  const rightCounts = multiset(right);
  const leftOnly = [];
  const rightOnly = [];
  let leftOnlyCount = 0;
  let rightOnlyCount = 0;
  for (const [key, value] of leftCounts) {
    const count = Math.max(0, value.count - (rightCounts.get(key)?.count ?? 0));
    leftOnlyCount += count;
    if (count > 0 && leftOnly.length < MAX_DIFF_ENTRIES) {
      leftOnly.push({ ...value.entry, count });
    }
  }
  for (const [key, value] of rightCounts) {
    const count = Math.max(0, value.count - (leftCounts.get(key)?.count ?? 0));
    rightOnlyCount += count;
    if (count > 0 && rightOnly.length < MAX_DIFF_ENTRIES) {
      rightOnly.push({ ...value.entry, count });
    }
  }
  return { leftOnlyCount, rightOnlyCount, leftOnly, rightOnly };
}

function compactValue(value) {
  if (Array.isArray(value)) {
    return {
      count: value.length,
      digest: digest(stable(value)),
      sample: value.slice(0, MAX_DIFF_ENTRIES),
    };
  }
  return value;
}

function componentComparison(left, right, field) {
  const changed = stable(left[field]) !== stable(right[field]);
  return {
    changed,
    coldDigest: digest(stable(left[field])),
    warmDigest: digest(stable(right[field])),
    ...(changed ? { cold: compactValue(left[field]), warm: compactValue(right[field]) } : {}),
  };
}

function readRecords(cacheRoot) {
  if (!fs.existsSync(cacheRoot)) {
    return {};
  }
  return Object.fromEntries(
    fs
      .readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const file = path.join(cacheRoot, entry.name, "stamp.json");
        return fs.existsSync(file) ? [[entry.name, JSON.parse(fs.readFileSync(file, "utf8"))]] : [];
      }),
  );
}

function recordComparisons(coldRoot, warmRoot) {
  const cold = readRecords(coldRoot);
  const warm = readRecords(warmRoot);
  return [...new Set([...Object.keys(cold), ...Object.keys(warm)])]
    .filter((name) => name.startsWith("tsdown-"))
    .toSorted()
    .map((name) => {
      const left = cold[name];
      const right = warm[name];
      const leftOutputs = Object.entries(left?.outputs ?? {}).map(([pathName, hash]) => ({
        name: pathName,
        hash,
      }));
      const rightOutputs = Object.entries(right?.outputs ?? {}).map(([pathName, hash]) => ({
        name: pathName,
        hash,
      }));
      return {
        name,
        coldPresent: Boolean(left),
        warmPresent: Boolean(right),
        signatureChanged: left?.signature !== right?.signature,
        inputsChanged: stable(left?.inputs) !== stable(right?.inputs),
        outputsChanged: stable(left?.outputs) !== stable(right?.outputs),
        outputInventoryDiff: multisetDiff(leftOutputs, rightOutputs),
      };
    });
}

function sanitizeString(value, replacements) {
  let result = value;
  for (const [needle, replacement] of replacements) {
    if (needle) {
      result = result.replaceAll(needle, replacement);
    }
  }
  result = result.replace(/[A-Za-z]:\\[^\s"'`,)}\]]+/gu, "<absolute-path>");
  result = result.replace(
    /(^|[\s"'=(,:])\/[^\s"'`,)}\]]+/gu,
    (_match, prefix) => `${prefix}<absolute-path>`,
  );
  return result;
}

function sanitize(value, replacements) {
  if (typeof value === "string") {
    return sanitizeString(value, replacements);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry, replacements));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        sanitizeString(key, replacements),
        sanitize(entry, replacements),
      ]),
    );
  }
  return value;
}

function buildSummary(params) {
  const coldEntries = readJsonLines(params.coldEvents);
  const warmEntries = readJsonLines(params.warmEvents);
  const coldTopology = topologyByNamespace(coldEntries);
  const warmTopology = topologyByNamespace(warmEntries);
  const cold = selectedByGroup(coldEntries, "seal");
  const warm = selectedByGroup(warmEntries, "lookup-stored");
  const fields = [
    "namespace",
    "outputRoot",
    "toolchain",
    "toolInputs",
    "config",
    "identityArgs",
    "options",
    "roots",
    "configFiles",
    "inputs",
    "runtime",
  ];
  const groups = [...new Set([...cold.keys(), ...warm.keys()])]
    .toSorted((left, right) => left.localeCompare(right))
    .map((group) => {
      const left = cold.get(group);
      const right = warm.get(group);
      if (!left || !right) {
        return {
          group,
          missingSelection: !left ? "cold-seal" : "warm-lookup-stored",
        };
      }
      const components = Object.fromEntries(
        fields.map((field) => [field, componentComparison(left, right, field)]),
      );
      return {
        group,
        changedComponents: fields.filter((field) => components[field].changed),
        missingInputs: {
          cold: left.missingInputs ?? [],
          warm: right.missingInputs ?? [],
        },
        components,
        topologyDiff: multisetDiff(
          coldTopology.get(left.namespace) ?? [],
          warmTopology.get(right.namespace) ?? [],
        ),
      };
    });
  return {
    status: "completed",
    sourceSha: params.sourceSha,
    runtime: params.runtime,
    selection: {
      cold: "seal",
      warm: "lookup-stored",
      note: "warm post-recompile seal events are excluded",
    },
    instrumentation: params.instrumentation,
    eventCounts: {
      cold: eventCounts(coldEntries),
      warm: eventCounts(warmEntries),
    },
    groups,
    records: recordComparisons(params.coldCache, params.warmCache),
  };
}

function writeSummary(summaryFile, summary, replacements) {
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
  const sanitized = sanitize(summary, replacements);
  const bytes = `${JSON.stringify(sanitized, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX_SUMMARY_BYTES) {
    const fallback = sanitize(
      {
        status: "summary-too-large",
        sourceSha: summary.sourceSha,
        size: Buffer.byteLength(bytes),
        groupChanges: (summary.groups ?? []).map((group) => ({
          group: group.group,
          changedComponents: group.changedComponents,
          missingSelection: group.missingSelection,
        })),
      },
      replacements,
    );
    fs.writeFileSync(summaryFile, `${JSON.stringify(fallback, null, 2)}\n`);
    return;
  }
  fs.writeFileSync(summaryFile, bytes);
}

function assertOwned(markerFile, ownerToken, scratchRoot) {
  const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
  if (marker.ownerToken !== ownerToken || marker.scratchRoot !== scratchRoot) {
    throw new Error("scratch ownership marker mismatch");
  }
}

function removeOwnedScratch(markerFile, ownerToken, scratchRoot) {
  assertOwned(markerFile, ownerToken, scratchRoot);
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}

function cloneAndInstall(sourceRoot, scratchRoot, expectedSha, env, logFile) {
  run("git", ["clone", "--no-local", "--no-hardlinks", sourceRoot, scratchRoot], {
    logFile,
  });
  const actualSha = run("git", ["rev-parse", "HEAD"], {
    cwd: scratchRoot,
    capture: true,
  });
  if (actualSha !== expectedSha) {
    throw new Error(`clone SHA mismatch: expected ${expectedSha}, got ${actualSha}`);
  }
  run(
    "pnpm",
    [
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
      "--store-dir",
      env.OPENCLAW_DECLARATION_CACHE_PNPM_STORE,
    ],
    { cwd: scratchRoot, env, logFile },
  );
  return instrument(scratchRoot);
}

function runBuild(root, env, eventFile, logFile) {
  run("pnpm", ["build"], {
    cwd: root,
    env: {
      ...env,
      OPENCLAW_DECLARATION_CACHE_DIAGNOSTIC_FILE: eventFile,
    },
    logFile,
  });
}

function runIndependentBuilds(expectedSha) {
  const sourceRoot = process.cwd();
  const actualSha = run("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    capture: true,
  });
  if (actualSha !== expectedSha) {
    throw new Error(`source SHA mismatch: expected ${expectedSha}, got ${actualSha}`);
  }
  if (process.version !== EXPECTED_NODE) {
    throw new Error(`Node mismatch: expected ${EXPECTED_NODE}, got ${process.version}`);
  }
  const pnpmVersion = run("pnpm", ["--version"], { capture: true });
  if (pnpmVersion !== EXPECTED_PNPM) {
    throw new Error(`pnpm mismatch: expected ${EXPECTED_PNPM}, got ${pnpmVersion}`);
  }

  const requiredPath = (name) => {
    const value = process.env[name];
    if (!value) {
      throw new Error(`missing required environment path: ${name}`);
    }
    return path.resolve(value);
  };
  const runnerTemp = requiredPath("RUNNER_TEMP");
  const scratchRoot = requiredPath("OPENCLAW_DECLARATION_CACHE_SCRATCH_SOURCE");
  const evidenceRoot = requiredPath("OPENCLAW_DECLARATION_CACHE_EVIDENCE_DIR");
  const expectedScratch = path.join(runnerTemp, "openclaw-declaration-cache", "source");
  const expectedEvidence = path.join(runnerTemp, "openclaw-declaration-cache-evidence");
  if (
    scratchRoot !== expectedScratch ||
    evidenceRoot !== expectedEvidence ||
    scratchRoot === sourceRoot ||
    evidenceRoot === sourceRoot
  ) {
    throw new Error("fixed scratch source path mismatch");
  }
  const ownerToken = `${process.env.GITHUB_RUN_ID ?? "local"}:${process.env.GITHUB_RUN_ATTEMPT ?? "0"}`;
  const scratchParent = path.dirname(scratchRoot);
  const markerFile = path.join(scratchParent, ".declaration-cache-owner.json");
  const runnerOnly = path.join(evidenceRoot, "runner-only");
  const summaryFile = path.join(evidenceRoot, "summary.json");
  const coldEvents = path.join(runnerOnly, "cold-signatures.jsonl");
  const warmEvents = path.join(runnerOnly, "warm-signatures.jsonl");
  const coldCache = path.join(runnerOnly, "cold-build-cache");
  const warmCache = path.join(runnerOnly, "warm-build-cache");
  const coldLog = path.join(runnerOnly, "cold-build.log");
  const warmLog = path.join(runnerOnly, "warm-build.log");
  const replacements = [
    [scratchRoot, "<scratch-source>"],
    [sourceRoot, "<immutable-source>"],
    [evidenceRoot, "<evidence-root>"],
    [runnerTemp, "<runner-temp>"],
    [process.env.HOME ?? "", "<home>"],
  ].toSorted((left, right) => right[0].length - left[0].length);
  let instrumentation = {};
  let stage = "preflight";

  fs.rmSync(evidenceRoot, { recursive: true, force: true });
  fs.mkdirSync(runnerOnly, { recursive: true });
  fs.mkdirSync(scratchParent, { recursive: true });
  if (fs.existsSync(scratchRoot) || fs.existsSync(markerFile)) {
    throw new Error("owned scratch path is not initially empty");
  }
  fs.writeFileSync(markerFile, `${JSON.stringify({ ownerToken, scratchRoot })}\n`, {
    flag: "wx",
  });

  const env = {
    ...process.env,
    CI: "1",
    OPENCLAW_BUILD_CACHE: "1",
    OPENCLAW_BUILD_PRIVATE_QA: "1",
    OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
    OPENCLAW_DECLARATION_CACHE_PNPM_STORE: path.join(scratchParent, "pnpm-store"),
  };

  try {
    stage = "cold-clone-install";
    const coldInstrumentation = cloneAndInstall(sourceRoot, scratchRoot, expectedSha, env, coldLog);
    stage = "cold-build";
    runBuild(scratchRoot, env, coldEvents, coldLog);
    stage = "cold-archive";
    fs.cpSync(path.join(scratchRoot, ".artifacts/build-all-cache"), coldCache, {
      recursive: true,
    });

    stage = "cold-cleanup";
    removeOwnedScratch(markerFile, ownerToken, scratchRoot);
    stage = "warm-clone-install";
    const warmInstrumentation = cloneAndInstall(sourceRoot, scratchRoot, expectedSha, env, warmLog);
    instrumentation = {
      coldHash: coldInstrumentation,
      warmHash: warmInstrumentation,
      identical: coldInstrumentation === warmInstrumentation,
    };
    stage = "warm-restore";
    fs.mkdirSync(path.join(scratchRoot, ".artifacts"), { recursive: true });
    fs.cpSync(coldCache, path.join(scratchRoot, ".artifacts/build-all-cache"), {
      recursive: true,
    });
    stage = "warm-build";
    runBuild(scratchRoot, env, warmEvents, warmLog);
    stage = "warm-archive";
    fs.cpSync(path.join(scratchRoot, ".artifacts/build-all-cache"), warmCache, {
      recursive: true,
    });

    stage = "summarize";
    const summary = buildSummary({
      sourceSha: expectedSha,
      runtime: {
        node: process.version,
        pnpm: pnpmVersion,
        platform: process.platform,
        arch: process.arch,
      },
      instrumentation,
      coldEvents,
      warmEvents,
      coldCache,
      warmCache,
    });
    writeSummary(summaryFile, summary, replacements);
    process.stdout.write(
      `sanitized diagnostic summary written (${summary.groups.length} groups)\n`,
    );
  } catch (error) {
    writeSummary(
      summaryFile,
      {
        status: "failed",
        sourceSha: expectedSha,
        runtime: {
          node: process.version,
          pnpm: pnpmVersion,
          platform: process.platform,
          arch: process.arch,
        },
        instrumentation,
        stage,
        error: error instanceof Error ? error.message : String(error),
        partialEvidence: failureEvidence({
          coldEvents,
          warmEvents,
          coldLog,
          warmLog,
        }),
      },
      replacements,
    );
    throw error;
  } finally {
    if (fs.existsSync(scratchRoot)) {
      removeOwnedScratch(markerFile, ownerToken, scratchRoot);
    }
  }
}

if (command === "instrument") {
  process.stdout.write(`${instrument(path.resolve(args[0] ?? "."))}\n`);
} else if (command === "run") {
  runIndependentBuilds(args[0]);
} else {
  throw new Error("usage: declaration-cache-diagnostic.mjs instrument <root> | run <sha>");
}
