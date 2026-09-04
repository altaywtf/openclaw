import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const verifierPath = path.resolve("scripts/docker/verify-fs-safe-native.mjs");

it("skips native binding proof for a legacy fs-safe package without native exports", () => {
  const root = tempDirs.make("openclaw-fs-safe-legacy-");
  const packageRoot = path.join(root, "app");
  const fsSafeRoot = path.join(packageRoot, "node_modules", "@openclaw", "fs-safe");
  mkdirSync(path.join(fsSafeRoot, "dist"), { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), "{}\n");
  writeFileSync(
    path.join(fsSafeRoot, "package.json"),
    JSON.stringify({
      name: "@openclaw/fs-safe",
      type: "module",
      exports: { "./config": "./dist/config.js" },
    }),
  );
  writeFileSync(
    path.join(fsSafeRoot, "dist", "config.js"),
    "export function configureFsSafePython() {}\n",
  );

  const result = spawnSync(
    process.execPath,
    [verifierPath, "--package-root", packageRoot, "--mode", "require"],
    { encoding: "utf8" },
  );

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("does not support native bindings");
});

it("requires durability support when fs-safe advertises native bindings", () => {
  const root = tempDirs.make("openclaw-fs-safe-incomplete-native-");
  const packageRoot = path.join(root, "app");
  const fsSafeRoot = path.join(packageRoot, "node_modules", "@openclaw", "fs-safe");
  mkdirSync(path.join(fsSafeRoot, "dist"), { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), "{}\n");
  writeFileSync(
    path.join(fsSafeRoot, "package.json"),
    JSON.stringify({
      name: "@openclaw/fs-safe",
      type: "module",
      exports: { "./config": "./dist/config.js" },
    }),
  );
  writeFileSync(
    path.join(fsSafeRoot, "dist", "config.js"),
    "export function configureFsSafeNative() {}\n",
  );

  const result = spawnSync(
    process.execPath,
    [verifierPath, "--package-root", packageRoot, "--mode", "require"],
    { encoding: "utf8" },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Package subpath './durability'");
});
