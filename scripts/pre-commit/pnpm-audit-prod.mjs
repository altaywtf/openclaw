#!/usr/bin/env node

// Production dependency audit helper using pnpm lock data and npm bulk advisories.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
// This zero-install hook runs on Node 22.22.3+, where native TypeScript stripping is enabled.
import { truncateUtf16Safe } from "../../packages/normalization-core/src/utf16-slice.ts";
import {
  cancelResponseReaderSoon,
  readBoundedResponseText as readBoundedResponseTextWithLimit,
} from "../lib/bounded-response.mjs";
import { pnpmLockfileDocuments } from "../lib/pnpm-lockfile-documents.mjs";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const BULK_ADVISORY_PATH = "/-/npm/v1/security/advisories/bulk";
const MIN_SEVERITY = "high";
/** Maximum advisory error body characters retained in messages. */
const BULK_ADVISORY_ERROR_BODY_MAX_CHARS = 4096;
const BULK_ADVISORY_RESPONSE_BODY_MAX_BYTES = 8 * 1024 * 1024;
const BULK_ADVISORY_REQUEST_TIMEOUT_MS = 120_000;
const BULK_ADVISORY_REQUEST_ATTEMPTS = 2;
const OSV_API_BASE_URL = "https://api.osv.dev/v1";
const OSV_QUERY_BATCH_SIZE = 1000;
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;
const SEVERITY_RANK = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};
const TOP_LEVEL_INDENT = 0;
const SECTION_ENTRY_INDENT = 2;
const NESTED_SECTION_INDENT = 4;
const MAPPING_ENTRY_INDENT = 6;
const NESTED_MAPPING_ENTRY_INDENT = 8;
const SNAPSHOT_SECTIONS = ["dependencies", "optionalDependencies"];
const IMPORTER_SECTIONS = ["dependencies", "optionalDependencies"];
const LOCAL_REFERENCE_PREFIXES = ["file:", "link:", "portal:", "workspace:"];
// GitHub's GHSA-3q49-cfcf-g5fm feed includes an overbroad ">=0" range alongside
// the compromised @mistralai/mistralai versions. Keep the production audit
// blocking for the compromised releases while allowing pinned safe locks.
const AUDIT_ADVISORY_VERSION_OVERRIDES = [
  {
    packageName: "@mistralai/mistralai",
    advisoryIds: new Set(["1118204", "GHSA-3q49-cfcf-g5fm"]),
    unaffectedVersions: new Set(["2.2.1", "2.2.5"]),
  },
];

export class AdvisoryRequestTimeoutError extends Error {}

/** @typedef {{ write: (chunk: string) => boolean }} AuditOutput */
/**
 * @typedef {object} PnpmAuditOptions
 * @property {string} [rootDir]
 * @property {typeof fetch} [fetchImpl]
 * @property {AuditOutput} [stdout]
 * @property {AuditOutput} [stderr]
 * @property {string} [minSeverity]
 * @property {boolean} [allowOsvFallback]
 */

function normalizeAuditLevel(level) {
  const normalized = String(level ?? "").toLowerCase();
  if (normalized in SEVERITY_RANK) {
    return normalized;
  }
  throw new Error(
    `Unsupported audit level "${String(level)}". Expected one of: ${Object.keys(SEVERITY_RANK).join(", ")}`,
  );
}

export function stripVersionDecorators(reference) {
  const openParenIndex = reference.indexOf("(");
  if (openParenIndex === -1) {
    return reference;
  }
  return reference.slice(0, openParenIndex);
}

export function parseSnapshotKey(snapshotKey) {
  let separatorIndex = -1;
  let parenDepth = 0;
  for (let index = 1; index < snapshotKey.length; index += 1) {
    const character = snapshotKey[index];
    if (character === "(") {
      parenDepth += 1;
      continue;
    }
    if (character === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (character === "@" && parenDepth === 0) {
      separatorIndex = index;
    }
  }
  if (separatorIndex <= 0) {
    throw new Error(`Unable to parse pnpm snapshot key "${snapshotKey}".`);
  }
  const packageName = snapshotKey.slice(0, separatorIndex);
  const reference = snapshotKey.slice(separatorIndex + 1);
  return {
    packageName,
    reference,
    version: stripVersionDecorators(reference),
  };
}

function isLocalReference(reference) {
  return LOCAL_REFERENCE_PREFIXES.some((prefix) => reference.startsWith(prefix));
}

function countIndentation(line) {
  let indentation = 0;
  while (indentation < line.length && line[indentation] === " ") {
    indentation += 1;
  }
  return indentation;
}

function isIgnorableYamlLine(trimmed) {
  return !trimmed || trimmed.startsWith("#");
}

function unquoteYamlString(value) {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"');
  }
  return value;
}

function parseYamlScalar(value) {
  return unquoteYamlString(value.trim());
}

function splitInlineYamlMapEntries(text) {
  const entries = [];
  let current = "";
  let quote = null;
  let depth = 0;

  for (const character of text) {
    if (quote) {
      current += character;
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "{" || character === "[" || character === "(") {
      depth += 1;
      current += character;
      continue;
    }
    if (character === "}" || character === "]" || character === ")") {
      depth = Math.max(0, depth - 1);
      current += character;
      continue;
    }
    if (character === "," && depth === 0) {
      const entry = current.trim();
      if (entry) {
        entries.push(entry);
      }
      current = "";
      continue;
    }
    current += character;
  }

  const entry = current.trim();
  if (entry) {
    entries.push(entry);
  }
  return entries;
}

function parseInlineYamlMap(rawValue) {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  const body = trimmed.slice(1, -1).trim();
  if (!body) {
    return {};
  }

  const result = {};
  for (const entry of splitInlineYamlMapEntries(body)) {
    const mapping = parseYamlMappingLine(entry);
    if (!mapping?.value) {
      continue;
    }
    result[mapping.key] = parseYamlScalar(mapping.value);
  }
  return result;
}

function findYamlMappingSeparator(line) {
  let quote = null;
  let depth = 0;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "{" || character === "[" || character === "(") {
      depth += 1;
      continue;
    }
    if (character === "}" || character === "]" || character === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (character !== ":" || depth !== 0) {
      continue;
    }

    const nextCharacter = line[index + 1];
    if (nextCharacter === undefined || /\s/u.test(nextCharacter)) {
      return index;
    }
  }

  return -1;
}

function parseYamlMappingLine(line) {
  const separatorIndex = findYamlMappingSeparator(line);
  if (separatorIndex === -1) {
    return null;
  }
  return {
    key: parseYamlScalar(line.slice(0, separatorIndex)),
    value: line.slice(separatorIndex + 1).trim(),
  };
}

function isNamedYamlSection(trimmed, sectionNames) {
  return sectionNames.some((sectionName) => trimmed === `${sectionName}:`);
}

function readNestedVersionValue(lines, startIndex, parentIndent) {
  let index = startIndex;
  let version = null;

  while (index < lines.length) {
    const nestedLine = lines[index];
    const nestedTrimmed = nestedLine.trim();
    const nestedIndentation = countIndentation(nestedLine);
    if (isIgnorableYamlLine(nestedTrimmed)) {
      index += 1;
      continue;
    }
    if (nestedIndentation <= parentIndent) {
      break;
    }
    if (nestedIndentation === NESTED_MAPPING_ENTRY_INDENT) {
      const nestedEntry = parseYamlMappingLine(nestedTrimmed);
      if (nestedEntry?.key === "version") {
        version = parseYamlScalar(nestedEntry.value);
      }
    }
    index += 1;
  }

  return { nextIndex: index, version };
}

function collectIndentedStringMap(lines, startIndex, entryIndent) {
  const entries = {};
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    const indentation = countIndentation(line);

    if (isIgnorableYamlLine(trimmed)) {
      index += 1;
      continue;
    }
    if (indentation < entryIndent) {
      break;
    }
    if (indentation !== entryIndent) {
      index += 1;
      continue;
    }

    const entry = parseYamlMappingLine(trimmed);
    if (entry?.value) {
      entries[entry.key] = parseYamlScalar(entry.value);
    }
    index += 1;
  }

  return { entries, nextIndex: index };
}

function collectImporterDependencyReferences(lines, startIndex) {
  const references = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    const indentation = countIndentation(line);

    if (isIgnorableYamlLine(trimmed)) {
      index += 1;
      continue;
    }
    if (indentation < MAPPING_ENTRY_INDENT) {
      break;
    }
    if (indentation > MAPPING_ENTRY_INDENT) {
      index += 1;
      continue;
    }

    const entry = parseYamlMappingLine(trimmed);
    index += 1;
    if (!entry) {
      continue;
    }

    if (entry.value) {
      const inlineMap = parseInlineYamlMap(entry.value);
      if (inlineMap && typeof inlineMap.version === "string") {
        references.push({ dependencyName: entry.key, reference: inlineMap.version });
        continue;
      }
      references.push({ dependencyName: entry.key, reference: parseYamlScalar(entry.value) });
      continue;
    }

    const nestedVersion = readNestedVersionValue(lines, index, MAPPING_ENTRY_INDENT);
    index = nestedVersion.nextIndex;
    if (nestedVersion.version) {
      references.push({ dependencyName: entry.key, reference: nestedVersion.version });
    }
  }

  return {
    nextIndex: index,
    references,
  };
}

function collectSnapshotDependencies(lines, startIndex) {
  const result = collectIndentedStringMap(lines, startIndex, MAPPING_ENTRY_INDENT);
  return { dependencies: result.entries, nextIndex: result.nextIndex };
}

function parsePnpmLockfileSections(lockfileText) {
  // Keep this parser dependency-free: security-fast runs this hook without pnpm install.
  // It only needs the small pnpm-lock subset used to collect production snapshots.
  const importers = [];
  const snapshots = {};
  const lines = lockfileText.split(/\r?\n/u);
  let currentTopLevelSection = null;
  let hasImportersSection = false;
  let hasSnapshotsSection = false;

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const trimmed = line.trim();
    const indentation = countIndentation(line);

    if (isIgnorableYamlLine(trimmed)) {
      index += 1;
      continue;
    }

    if (indentation === TOP_LEVEL_INDENT && trimmed.endsWith(":")) {
      currentTopLevelSection = parseYamlScalar(trimmed.slice(0, -1));
      if (currentTopLevelSection === "importers") {
        hasImportersSection = true;
      }
      if (currentTopLevelSection === "snapshots") {
        hasSnapshotsSection = true;
      }
      index += 1;
      continue;
    }

    if (
      currentTopLevelSection === "importers" &&
      indentation === SECTION_ENTRY_INDENT &&
      trimmed.endsWith(":")
    ) {
      index += 1;
      while (index < lines.length) {
        const nestedLine = lines[index];
        const nestedTrimmed = nestedLine.trim();
        const nestedIndentation = countIndentation(nestedLine);

        if (isIgnorableYamlLine(nestedTrimmed)) {
          index += 1;
          continue;
        }
        if (nestedIndentation <= SECTION_ENTRY_INDENT) {
          break;
        }
        if (
          nestedIndentation === NESTED_SECTION_INDENT &&
          isNamedYamlSection(nestedTrimmed, IMPORTER_SECTIONS)
        ) {
          const result = collectImporterDependencyReferences(lines, index + 1);
          importers.push(...result.references);
          index = result.nextIndex;
          continue;
        }
        index += 1;
      }
      continue;
    }

    if (currentTopLevelSection === "snapshots" && indentation === SECTION_ENTRY_INDENT) {
      const snapshotEntry = parseYamlMappingLine(trimmed);
      if (!snapshotEntry) {
        index += 1;
        continue;
      }
      if (snapshotEntry.value) {
        snapshots[snapshotEntry.key] = {};
        index += 1;
        continue;
      }

      const snapshotKey = snapshotEntry.key;
      const snapshot = {};
      index += 1;
      while (index < lines.length) {
        const nestedLine = lines[index];
        const nestedTrimmed = nestedLine.trim();
        const nestedIndentation = countIndentation(nestedLine);

        if (isIgnorableYamlLine(nestedTrimmed)) {
          index += 1;
          continue;
        }
        if (nestedIndentation <= SECTION_ENTRY_INDENT) {
          break;
        }
        if (
          nestedIndentation === NESTED_SECTION_INDENT &&
          isNamedYamlSection(nestedTrimmed, SNAPSHOT_SECTIONS)
        ) {
          const result = collectSnapshotDependencies(lines, index + 1);
          snapshot[nestedTrimmed.slice(0, -1)] = result.dependencies;
          index = result.nextIndex;
          continue;
        }
        index += 1;
      }
      snapshots[snapshotKey] = snapshot;
      continue;
    }

    index += 1;
  }

  return { hasImportersSection, hasSnapshotsSection, importers, snapshots };
}

function resolveSnapshot({ dependencyName, reference, snapshots }) {
  if (isLocalReference(reference)) {
    return null;
  }

  const directKey = `${dependencyName}@${reference}`;
  if (directKey in snapshots) {
    return {
      snapshotKey: directKey,
      ...parseSnapshotKey(directKey),
    };
  }

  if (reference in snapshots) {
    return {
      snapshotKey: reference,
      ...parseSnapshotKey(reference),
    };
  }

  if (reference.startsWith("npm:")) {
    const aliasKey = reference.slice(4);
    if (aliasKey in snapshots) {
      return {
        snapshotKey: aliasKey,
        ...parseSnapshotKey(aliasKey),
      };
    }
  }

  throw new Error(
    `Unable to resolve pnpm snapshot for dependency "${dependencyName}" with reference "${reference}".`,
  );
}

export function collectProdResolvedPackagesFromLockfile(lockfileText) {
  const lockfile = parsePnpmLockfileSections(pnpmLockfileDocuments(lockfileText).dependencies);
  if (!lockfile.hasImportersSection) {
    throw new Error("pnpm-lock.yaml is missing the importers section.");
  }
  if (!lockfile.hasSnapshotsSection) {
    throw new Error("pnpm-lock.yaml is missing the snapshots section.");
  }

  const versionsByPackage = new Map();
  const seenSnapshots = new Set();
  const queue = [...lockfile.importers];

  while (queue.length > 0) {
    const next = queue.pop();
    if (!next) {
      continue;
    }
    const resolved = resolveSnapshot({
      dependencyName: next.dependencyName,
      reference: next.reference,
      snapshots: lockfile.snapshots,
    });
    if (!resolved) {
      continue;
    }

    let versions = versionsByPackage.get(resolved.packageName);
    if (!versions) {
      versions = new Set();
      versionsByPackage.set(resolved.packageName, versions);
    }
    versions.add(resolved.version);

    if (seenSnapshots.has(resolved.snapshotKey)) {
      continue;
    }
    seenSnapshots.add(resolved.snapshotKey);

    const snapshot = lockfile.snapshots[resolved.snapshotKey];
    if (!snapshot || typeof snapshot !== "object") {
      continue;
    }
    for (const sectionName of SNAPSHOT_SECTIONS) {
      const dependencies = snapshot[sectionName];
      if (!dependencies || typeof dependencies !== "object") {
        continue;
      }
      for (const [dependencyName, reference] of Object.entries(dependencies)) {
        if (typeof reference !== "string") {
          continue;
        }
        queue.push({ dependencyName, reference });
      }
    }
  }

  return versionsByPackage;
}

export function collectAllResolvedPackagesFromLockfile(lockfileText) {
  const versionsByPackage = new Map();
  for (const document of Object.values(pnpmLockfileDocuments(lockfileText))) {
    if (document === null) {
      continue;
    }
    const lockfile = parsePnpmLockfileSections(document);
    if (!lockfile.hasSnapshotsSection) {
      throw new Error("pnpm-lock.yaml is missing the snapshots section.");
    }

    for (const snapshotKey of Object.keys(lockfile.snapshots)) {
      const resolved = parseSnapshotKey(snapshotKey);
      let versions = versionsByPackage.get(resolved.packageName);
      if (!versions) {
        versions = new Set();
        versionsByPackage.set(resolved.packageName, versions);
      }
      versions.add(resolved.version);
    }
  }

  return versionsByPackage;
}

/**
 * @param {Map<string, Set<string>>} versionsByPackage
 * @returns {Record<string, string[]>}
 */
export function createBulkAdvisoryPayload(versionsByPackage) {
  return Object.fromEntries(
    [...versionsByPackage.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([packageName, versions]) => [
        packageName,
        [...versions].toSorted((left, right) => left.localeCompare(right)),
      ]),
  );
}

function normalizeSeverity(severity) {
  if (typeof severity !== "string") {
    return "info";
  }
  return severity.toLowerCase();
}

function advisoryMatchesOverride(advisory, override) {
  const advisoryIds = [advisory?.id, ...(advisory?.aliases ?? [])].map((id) => String(id ?? ""));
  const advisoryUrl = typeof advisory?.url === "string" ? advisory.url : "";
  return (
    advisoryIds.some((id) => override.advisoryIds.has(id)) ||
    [...override.advisoryIds].some((id) => advisoryUrl.includes(id))
  );
}

function shouldSuppressAdvisoryFinding({ packageName, advisory, versionsByPackage }) {
  if (!versionsByPackage) {
    return false;
  }
  const override = AUDIT_ADVISORY_VERSION_OVERRIDES.find(
    (candidate) =>
      candidate.packageName === packageName && advisoryMatchesOverride(advisory, candidate),
  );
  if (!override) {
    return false;
  }
  const resolvedVersions = versionsByPackage.get(packageName);
  if (!resolvedVersions || resolvedVersions.size === 0) {
    return false;
  }
  return [...resolvedVersions].every((version) => override.unaffectedVersions.has(version));
}

export function filterFindingsBySeverity(advisoriesByPackage, minSeverity, versionsByPackage) {
  const threshold = normalizeAuditLevel(minSeverity);
  const findings = [];

  for (const [packageName, advisories] of Object.entries(advisoriesByPackage ?? {})) {
    if (!Array.isArray(advisories)) {
      continue;
    }
    for (const advisory of advisories) {
      if (!advisory || typeof advisory !== "object") {
        continue;
      }
      const severity = normalizeSeverity(advisory.severity);
      if ((SEVERITY_RANK[severity] ?? -1) < SEVERITY_RANK[threshold]) {
        continue;
      }
      if (shouldSuppressAdvisoryFinding({ packageName, advisory, versionsByPackage })) {
        continue;
      }
      findings.push({
        packageName,
        id: advisory.id ?? "unknown",
        severity,
        title: advisory.title ?? "Untitled advisory",
        url: advisory.url ?? null,
        vulnerableVersions: advisory.vulnerable_versions ?? null,
      });
    }
  }

  findings.sort((left, right) => {
    const severityDelta =
      (SEVERITY_RANK[right.severity] ?? -1) - (SEVERITY_RANK[left.severity] ?? -1);
    if (severityDelta !== 0) {
      return severityDelta;
    }
    return left.packageName.localeCompare(right.packageName);
  });

  return findings;
}

function chunkEntries(entries, size) {
  const chunks = [];
  for (let index = 0; index < entries.length; index += size) {
    chunks.push(entries.slice(index, index + size));
  }
  return chunks;
}

export function resolveRegistryBaseUrl() {
  const configured =
    process.env.npm_config_registry ??
    process.env.NPM_CONFIG_REGISTRY ??
    process.env.pnpm_config_registry ??
    process.env.PNPM_CONFIG_REGISTRY ??
    process.env.npm_config_userconfig_registry ??
    DEFAULT_REGISTRY;
  return configured.replace(/\/+$/u, "");
}

export function canFallbackToOsv(
  registryBaseUrl = resolveRegistryBaseUrl(),
  scopedRegistryUrls = [],
) {
  return (
    registryBaseUrl === DEFAULT_REGISTRY &&
    scopedRegistryUrls.every((url) => url.replace(/\/+$/u, "") === DEFAULT_REGISTRY)
  );
}

function parseNpmrcRegistryUrls(npmrcText, packageScopes) {
  const urls = [];
  for (const line of npmrcText.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const scope = key.endsWith(":registry") ? key.slice(0, -":registry".length) : null;
    if (key === "registry" || (scope !== null && packageScopes.has(scope))) {
      urls.push(line.slice(separator + 1).trim());
    }
  }
  return urls;
}

function parsePnpmRegistryUrls(configText) {
  const urls = [];
  const dynamicRegistry = "<dynamic-registry>";
  let registrySectionIndent = null;
  for (const line of configText.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (registrySectionIndent !== null && indent <= registrySectionIndent) {
      registrySectionIndent = null;
    }
    const registrySection = /^(?:namedRegistries|registries):/u.test(trimmed);
    if (registrySection) {
      registrySectionIndent = indent;
    }
    const registry = trimmed.match(/^registry:\s*["']?(https?:\/\/[^\s"']+)/u)?.[1];
    if (registry) {
      urls.push(registry);
    } else if (trimmed.startsWith("registry:")) {
      urls.push(dynamicRegistry);
    }
    if (registrySection || (registrySectionIndent !== null && indent > registrySectionIndent)) {
      for (const match of trimmed.matchAll(/https?:\/\/[^\s,"'[\]{}]+/gu)) {
        urls.push(match[0].replace(/:$/u, ""));
      }
      if (trimmed.includes("${")) {
        urls.push(dynamicRegistry);
      }
    }
  }
  return urls;
}

function resolvePnpmGlobalConfigDir() {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "pnpm");
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Preferences", "pnpm");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
      "pnpm",
      "config",
    );
  }
  return path.join(homedir(), ".config", "pnpm");
}

export async function resolveConfiguredRegistryUrls({ rootDir, payload }) {
  const packageScopes = new Set(
    Object.keys(payload)
      .filter((packageName) => packageName.startsWith("@") && packageName.includes("/"))
      .map((packageName) => packageName.slice(0, packageName.indexOf("/")).toLowerCase()),
  );
  const urls = [];
  for (const [key, value] of Object.entries(process.env)) {
    const normalizedKey = key.toLowerCase().replace(/^(?:npm|pnpm)_config_/u, "");
    const scope = normalizedKey.endsWith(":registry")
      ? normalizedKey.slice(0, -":registry".length)
      : null;
    if ((normalizedKey === "registry" || (scope !== null && packageScopes.has(scope))) && value) {
      urls.push(value);
    }
  }
  const defaultNpmPrefix =
    process.platform === "win32"
      ? path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "npm")
      : path.dirname(path.dirname(process.execPath));
  const npmPrefixes = [
    process.env.npm_config_prefix,
    process.env.NPM_CONFIG_PREFIX,
    process.env.pnpm_config_prefix,
    process.env.PNPM_CONFIG_PREFIX,
    defaultNpmPrefix,
  ].filter(Boolean);
  const configPaths = new Set([
    path.join(homedir(), ".npmrc"),
    path.join(rootDir, ".npmrc"),
    process.env.npm_config_userconfig,
    process.env.NPM_CONFIG_USERCONFIG,
    process.env.npm_config_globalconfig,
    process.env.NPM_CONFIG_GLOBALCONFIG,
    ...npmPrefixes.map((prefix) => path.join(prefix, "etc", "npmrc")),
  ]);
  for (const configPath of configPaths) {
    if (!configPath) {
      continue;
    }
    const npmrcText = await readFile(configPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") {
        return "";
      }
      throw error;
    });
    urls.push(...parseNpmrcRegistryUrls(npmrcText, packageScopes));
  }
  const pnpmGlobalConfigDir = resolvePnpmGlobalConfigDir();
  const globalPnpmrcText = await readFile(path.join(pnpmGlobalConfigDir, "rc"), "utf8").catch(
    (error) => {
      if (error?.code === "ENOENT") {
        return "";
      }
      throw error;
    },
  );
  urls.push(...parseNpmrcRegistryUrls(globalPnpmrcText, packageScopes));
  const pnpmConfigPaths = [
    path.join(rootDir, "pnpm-workspace.yaml"),
    path.join(pnpmGlobalConfigDir, "config.yaml"),
  ];
  for (const configPath of pnpmConfigPaths) {
    const configText = await readFile(configPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") {
        return "";
      }
      throw error;
    });
    urls.push(...parsePnpmRegistryUrls(configText));
  }
  return urls;
}

function parsePositiveIntegerEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function resolveBulkAdvisoryRequestTimeoutMs() {
  return clampBulkAdvisoryTimeoutMs(
    parsePositiveIntegerEnv(
      "OPENCLAW_PNPM_AUDIT_BULK_TIMEOUT_MS",
      BULK_ADVISORY_REQUEST_TIMEOUT_MS,
    ),
  );
}

function resolveBulkAdvisoryResponseBodyMaxBytes() {
  return parsePositiveIntegerEnv(
    "OPENCLAW_PNPM_AUDIT_BULK_RESPONSE_MAX_BYTES",
    BULK_ADVISORY_RESPONSE_BODY_MAX_BYTES,
  );
}

function clampBulkAdvisoryTimeoutMs(valueMs) {
  const value = Number.isFinite(valueMs) ? valueMs : BULK_ADVISORY_REQUEST_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(value), 1), MAX_TIMER_TIMEOUT_MS);
}

/**
 * @template T
 * @param {{ label: string, timeoutMs: number, run: (options: { signal: AbortSignal, timeoutPromise: Promise<never> }) => Promise<T> }} options
 * @returns {Promise<T>}
 */
export async function withAdvisoryRequestTimeout({ label, timeoutMs, run }) {
  const resolvedTimeoutMs = clampBulkAdvisoryTimeoutMs(timeoutMs);
  const controller = new AbortController();
  let timeout;
  /** @type {Promise<never>} */
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new AdvisoryRequestTimeoutError(
        `${label} exceeded timeout of ${resolvedTimeoutMs}ms`,
      );
      controller.abort(error);
      reject(error);
    }, resolvedTimeoutMs);
  });
  try {
    return await Promise.race([run({ signal: controller.signal, timeoutPromise }), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function readBoundedResponseText(response, maxBytes, label, options = {}) {
  return await readBoundedResponseTextWithLimit(response, label, maxBytes, {
    signal: options.signal,
    timeoutPromise: options.timeoutPromise,
    formatTooLargeMessage: (messageLabel, bytes) => `${messageLabel} exceeded ${bytes} bytes`,
    createTooLargeError: (message) => Object.assign(new Error(message), { code: "ETOOBIG" }),
  });
}

export async function readBoundedBulkAdvisoryErrorText(
  response,
  maxChars = BULK_ADVISORY_ERROR_BODY_MAX_CHARS,
  options = {},
) {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  let canceled = false;

  try {
    while (text.length <= maxChars) {
      const read = reader.read();
      const readWithTimeout = options.timeoutPromise
        ? Promise.race([
            read,
            options.timeoutPromise.catch((error) => {
              canceled = true;
              cancelResponseReaderSoon(reader);
              throw error;
            }),
          ])
        : read;
      const { done, value } = await readWithTimeout;
      if (done) {
        text += decoder.decode();
        break;
      }

      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) {
        text = truncateUtf16Safe(text, maxChars);
        truncated = true;
        break;
      }
    }
  } finally {
    if (truncated) {
      await reader.cancel().catch(() => undefined);
    } else if (!canceled) {
      reader.releaseLock();
    }
  }

  return truncated ? `${text}\n[truncated]` : text;
}

async function readBulkAdvisoryJson(response, maxBytes, options = {}) {
  const text = await readBoundedResponseText(
    response,
    maxBytes,
    "Bulk advisory response body",
    options,
  );
  if (!text.trim()) {
    throw new Error("Bulk advisory response body was empty");
  }
  return JSON.parse(text);
}

export async function fetchBulkAdvisories({
  payload,
  fetchImpl = fetch,
  registryBaseUrl = resolveRegistryBaseUrl(),
  responseBodyMaxBytes = resolveBulkAdvisoryResponseBodyMaxBytes(),
  timeoutMs = resolveBulkAdvisoryRequestTimeoutMs(),
}) {
  const url = `${registryBaseUrl}${BULK_ADVISORY_PATH}`;
  return await withAdvisoryRequestTimeout({
    label: "Bulk advisory request",
    timeoutMs,
    run: async ({ signal, timeoutPromise }) => {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal,
      });

      if (!response.ok) {
        const bodyText = await readBoundedBulkAdvisoryErrorText(response, undefined, {
          timeoutPromise,
        });
        throw new Error(
          `Bulk advisory request failed (${response.status} ${response.statusText}): ${bodyText}`,
        );
      }

      return await readBulkAdvisoryJson(response, responseBodyMaxBytes, {
        signal,
        timeoutPromise,
      });
    },
  });
}

function isBulkAdvisoryTimeoutError(error) {
  return error instanceof AdvisoryRequestTimeoutError;
}

export async function fetchBulkAdvisoriesWithRetry({
  attempts = BULK_ADVISORY_REQUEST_ATTEMPTS,
  onRetry = () => {},
  ...options
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchBulkAdvisories(options);
    } catch (error) {
      if (attempt === attempts || !isBulkAdvisoryTimeoutError(error)) {
        throw error;
      }
      onRetry({ attempt, error });
    }
  }
  throw new Error("Bulk advisory retry loop exhausted unexpectedly");
}

async function fetchOsvJson({ path: requestPath, body, fetchImpl }) {
  return await withAdvisoryRequestTimeout({
    label: "OSV advisory request",
    timeoutMs: BULK_ADVISORY_REQUEST_TIMEOUT_MS,
    run: async ({ signal, timeoutPromise }) => {
      const response = await fetchImpl(`${OSV_API_BASE_URL}${requestPath}`, {
        method: body ? "POST" : "GET",
        headers: body ? { accept: "application/json", "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
      if (!response.ok) {
        const responseText = await readBoundedBulkAdvisoryErrorText(response, undefined, {
          timeoutPromise,
        });
        throw new Error(
          `OSV advisory request failed (${response.status} ${response.statusText}): ${responseText}`,
        );
      }
      return await readBulkAdvisoryJson(response, BULK_ADVISORY_RESPONSE_BODY_MAX_BYTES, {
        signal,
        timeoutPromise,
      });
    },
  });
}

export async function fetchOsvExactVersionAdvisories({ payload, fetchImpl = fetch }) {
  const queryEntries = Object.entries(payload).flatMap(([packageName, versions]) =>
    versions.map((version) => ({ packageName, version })),
  );
  const affectedById = new Map();

  for (const entryChunk of chunkEntries(queryEntries, OSV_QUERY_BATCH_SIZE)) {
    let pageEntries = entryChunk;
    const seenPageTokens = new Set();
    while (pageEntries.length > 0) {
      const batch = await fetchOsvJson({
        path: "/querybatch",
        body: {
          queries: pageEntries.map(({ packageName, version, pageToken }) => ({
            package: { ecosystem: "npm", name: packageName },
            version,
            ...(pageToken ? { page_token: pageToken } : {}),
          })),
        },
        fetchImpl,
      });
      if (!Array.isArray(batch?.results) || batch.results.length !== pageEntries.length) {
        throw new Error("OSV advisory response did not match the exact-version query batch");
      }
      const nextPageEntries = [];
      for (const [index, result] of batch.results.entries()) {
        for (const vulnerability of result?.vulns ?? []) {
          if (typeof vulnerability?.id !== "string") {
            throw new Error("OSV advisory response contained a vulnerability without an id");
          }
          const entry = pageEntries[index];
          const packages = affectedById.get(vulnerability.id) ?? new Map();
          const versions = packages.get(entry.packageName) ?? new Set();
          versions.add(entry.version);
          packages.set(entry.packageName, versions);
          affectedById.set(vulnerability.id, packages);
        }
        if (typeof result?.next_page_token === "string" && result.next_page_token) {
          const pageTokenKey = `${pageEntries[index].packageName}\0${pageEntries[index].version}\0${result.next_page_token}`;
          if (seenPageTokens.has(pageTokenKey)) {
            throw new Error("OSV advisory response repeated an exact-version page token");
          }
          seenPageTokens.add(pageTokenKey);
          nextPageEntries.push({ ...pageEntries[index], pageToken: result.next_page_token });
        }
      }
      pageEntries = nextPageEntries;
    }
  }

  const advisoriesByPackage = {};
  for (const [id, packages] of affectedById) {
    const advisory = await fetchOsvJson({
      path: `/vulns/${encodeURIComponent(id)}`,
      fetchImpl,
    });
    for (const [packageName, versions] of packages) {
      const packageAdvisories = advisoriesByPackage[packageName] ?? [];
      packageAdvisories.push({
        id,
        aliases: advisory?.aliases ?? [],
        severity: resolveOsvSeverity(advisory, packageName),
        title: advisory?.summary ?? "Untitled OSV advisory",
        url: `https://osv.dev/vulnerability/${encodeURIComponent(id)}`,
        vulnerable_versions: [...versions].join(", "),
      });
      advisoriesByPackage[packageName] = packageAdvisories;
    }
  }
  return advisoriesByPackage;
}

function parseCvssMetrics(vector) {
  if (typeof vector !== "string") {
    return null;
  }
  return Object.fromEntries(
    vector
      .split("/")
      .filter((part) => part.includes(":"))
      .map((part) => part.split(":", 2)),
  );
}

function roundCvssV3(score) {
  return Math.ceil((score - Number.EPSILON) * 10) / 10;
}

function resolveCvssV3BaseScore(vector) {
  const metrics = parseCvssMetrics(vector);
  if (!metrics) {
    return null;
  }
  const scopeChanged = metrics.S === "C";
  const weights = {
    AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
    AC: { L: 0.77, H: 0.44 },
    PR: scopeChanged ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 },
    UI: { N: 0.85, R: 0.62 },
    C: { H: 0.56, L: 0.22, N: 0 },
    I: { H: 0.56, L: 0.22, N: 0 },
    A: { H: 0.56, L: 0.22, N: 0 },
  };
  const values = Object.fromEntries(
    Object.entries(weights).map(([name, options]) => [name, options[metrics[name]]]),
  );
  if (Object.values(values).some((value) => typeof value !== "number")) {
    return null;
  }
  const impactBase = 1 - (1 - values.C) * (1 - values.I) * (1 - values.A);
  const impact = scopeChanged
    ? metrics.CVSS === "3.1"
      ? 7.52 * (impactBase - 0.029) - 3.25 * (impactBase * 0.9731 - 0.02) ** 13
      : 7.52 * (impactBase - 0.029) - 3.25 * (impactBase - 0.02) ** 15
    : 6.42 * impactBase;
  if (impact <= 0) {
    return 0;
  }
  const exploitability = 8.22 * values.AV * values.AC * values.PR * values.UI;
  const combined = scopeChanged ? 1.08 * (impact + exploitability) : impact + exploitability;
  return roundCvssV3(Math.min(combined, 10));
}

function resolveCvssV2BaseScore(vector) {
  const metrics = parseCvssMetrics(vector);
  if (!metrics) {
    return null;
  }
  const weights = {
    AV: { L: 0.395, A: 0.646, N: 1 },
    AC: { H: 0.35, M: 0.61, L: 0.71 },
    Au: { M: 0.45, S: 0.56, N: 0.704 },
    C: { N: 0, P: 0.275, C: 0.66 },
    I: { N: 0, P: 0.275, C: 0.66 },
    A: { N: 0, P: 0.275, C: 0.66 },
  };
  const values = Object.fromEntries(
    Object.entries(weights).map(([name, options]) => [name, options[metrics[name]]]),
  );
  if (Object.values(values).some((value) => typeof value !== "number")) {
    return null;
  }
  const impact = 10.41 * (1 - (1 - values.C) * (1 - values.I) * (1 - values.A));
  const exploitability = 20 * values.AV * values.AC * values.Au;
  const score = (0.6 * impact + 0.4 * exploitability - 1.5) * (impact === 0 ? 0 : 1.176);
  return Math.round(score * 10) / 10;
}

function severityFromCvssScore(score) {
  if (score >= 9) {
    return "critical";
  }
  if (score >= 7) {
    return "high";
  }
  if (score >= 4) {
    return "moderate";
  }
  return score > 0 ? "low" : "info";
}

export function resolveOsvSeverity(advisory, packageName) {
  const affectedPackages = (advisory?.affected ?? []).filter(
    (entry) => entry?.package?.ecosystem === "npm" && entry.package.name === packageName,
  );
  const candidates = [
    ...affectedPackages.flatMap((entry) => [
      entry?.ecosystem_specific?.severity,
      entry?.database_specific?.severity,
    ]),
    advisory?.database_specific?.severity,
  ];
  const resolvedSeverities = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const severity = normalizeSeverity(candidate);
    if (severity in SEVERITY_RANK) {
      resolvedSeverities.push(severity);
    }
  }
  const standardSeverities = [
    ...affectedPackages.flatMap((entry) => entry?.severity ?? []),
    ...(advisory?.severity ?? []),
  ];
  const scores = standardSeverities.flatMap((entry) => {
    if (typeof entry?.score !== "string") {
      return [];
    }
    const score =
      entry.type === "CVSS_V2"
        ? resolveCvssV2BaseScore(entry.score)
        : entry.type === "CVSS_V3"
          ? resolveCvssV3BaseScore(entry.score)
          : null;
    return score === null ? [] : [score];
  });
  if (scores.length > 0) {
    resolvedSeverities.push(severityFromCvssScore(Math.max(...scores)));
  }
  if (resolvedSeverities.length > 0) {
    return resolvedSeverities.toSorted(
      (left, right) => SEVERITY_RANK[right] - SEVERITY_RANK[left],
    )[0];
  }
  if (typeof advisory?.id === "string" && advisory.id.startsWith("MAL-")) {
    return "critical";
  }
  throw new Error(`OSV advisory ${String(advisory?.id ?? "unknown")} has no categorical severity`);
}

/** @param {PnpmAuditOptions} [options] */
export async function runPnpmAuditProd({
  rootDir = process.cwd(),
  fetchImpl = fetch,
  stdout = process.stdout,
  stderr = process.stderr,
  minSeverity = MIN_SEVERITY,
  allowOsvFallback = false,
} = {}) {
  const normalizedMinSeverity = normalizeAuditLevel(minSeverity);
  const lockfilePath = path.join(rootDir, "pnpm-lock.yaml");
  const lockfileText = await readFile(lockfilePath, "utf8");
  const versionsByPackage = collectProdResolvedPackagesFromLockfile(lockfileText);
  const payload = createBulkAdvisoryPayload(versionsByPackage);
  const payloadEntries = Object.entries(payload);

  if (payloadEntries.length === 0) {
    stdout.write("No production dependencies found in pnpm-lock.yaml.\n");
    return 0;
  }

  let advisoryResults = {};
  let advisorySource = "npm bulk";
  try {
    for (const payloadChunk of chunkEntries(payloadEntries, 400)) {
      const chunkPayload = Object.fromEntries(payloadChunk);
      const chunkResults = await fetchBulkAdvisoriesWithRetry({
        payload: chunkPayload,
        fetchImpl,
        onRetry: () => {
          stderr.write("[pnpm-audit-prod] Bulk advisory request timed out; retrying once.\n");
        },
      });
      Object.assign(advisoryResults, chunkResults);
    }
  } catch (error) {
    const configuredRegistryUrls = await resolveConfiguredRegistryUrls({ rootDir, payload });
    if (
      !isBulkAdvisoryTimeoutError(error) ||
      !allowOsvFallback ||
      !canFallbackToOsv(undefined, configuredRegistryUrls)
    ) {
      throw error;
    }
    stderr.write(
      "[pnpm-audit-prod] npm bulk timed out; falling back to OSV exact-version queries.\n",
    );
    advisoryResults = await fetchOsvExactVersionAdvisories({ payload, fetchImpl });
    advisorySource = "OSV exact-version fallback";
  }

  const findings = filterFindingsBySeverity(
    advisoryResults,
    normalizedMinSeverity,
    versionsByPackage,
  );
  if (findings.length === 0) {
    stdout.write(
      `No matching ${normalizedMinSeverity} or higher advisories returned by ${advisorySource} for production dependencies. ` +
        "Upstream repository advisories were not checked; this is not comprehensive vulnerability clearance.\n",
    );
    return 0;
  }

  stderr.write(
    `Found ${findings.length} ${normalizedMinSeverity} or higher advisories from ${advisorySource} in production dependencies ` +
      "(upstream repository advisories not checked):\n",
  );
  for (const finding of findings.slice(0, 25)) {
    const details = [
      `${finding.severity.toUpperCase()} ${finding.packageName}`,
      `id=${finding.id}`,
      `title=${finding.title}`,
    ];
    if (finding.vulnerableVersions) {
      details.push(`range=${finding.vulnerableVersions}`);
    }
    if (finding.url) {
      details.push(`url=${finding.url}`);
    }
    stderr.write(`- ${details.join(" · ")}\n`);
  }
  if (findings.length > 25) {
    stderr.write(`...and ${findings.length - 25} more advisories.\n`);
  }
  return 1;
}

function readSeverityValue(value, optionName) {
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  let minSeverity = MIN_SEVERITY;
  let allowOsvFallback = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-osv-fallback") {
      allowOsvFallback = true;
      continue;
    }
    if (argument === "--audit-level" || argument === "--min-severity") {
      minSeverity = readSeverityValue(argv[index + 1], argument);
      index += 1;
      continue;
    }
    if (argument.startsWith("--audit-level=")) {
      minSeverity = readSeverityValue(argument.slice("--audit-level=".length), "--audit-level");
      continue;
    }
    if (argument.startsWith("--min-severity=")) {
      minSeverity = readSeverityValue(argument.slice("--min-severity=".length), "--min-severity");
      continue;
    }
    throw new Error(`Unknown argument "${argument}".`);
  }

  return { allowOsvFallback, minSeverity };
}

async function main() {
  try {
    const { allowOsvFallback, minSeverity } = parseArgs(process.argv.slice(2));
    process.exitCode = await runPnpmAuditProd({ allowOsvFallback, minSeverity });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
  if (process.exitCode) {
    process.stderr.write(`[pnpm-audit-prod] FAILED (exit ${process.exitCode})\n`);
  }
}
