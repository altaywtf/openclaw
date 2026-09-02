import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readWorkspaceFileCache,
  retireWorkspaceFileCache,
  writeWorkspaceFileCache,
} from "./workspace-file-cache.js";

const MIB = 1024 * 1024;
let workspaceRoot = "";

beforeEach(() => {
  workspaceRoot = path.resolve(`/workspace-cache-${randomUUID()}`);
});

afterEach(() => {
  retireWorkspaceFileCache(workspaceRoot);
});

function cacheFile(name: string, sizeBytes: number, identity = name): string {
  const filePath = path.join(workspaceRoot, name);
  writeWorkspaceFileCache({
    filePath,
    content: "x".repeat(sizeBytes),
    identity,
  });
  return filePath;
}

describe("workspace file cache", () => {
  it("evicts the oldest content above the six-file byte budget", () => {
    const oldest = cacheFile("oldest", 2 * MIB);
    for (let index = 1; index < 6; index += 1) {
      cacheFile(`entry-${index}`, 2 * MIB);
    }
    const newest = cacheFile("newest", 1);

    expect(readWorkspaceFileCache(oldest, "oldest")).toBeUndefined();
    expect(readWorkspaceFileCache(newest, "newest")).toBe("x");
  });

  it("promotes hits before weighted eviction", () => {
    const first = cacheFile("first", 2 * MIB);
    const second = cacheFile("second", 2 * MIB);
    for (let index = 2; index < 6; index += 1) {
      cacheFile(`entry-${index}`, 2 * MIB);
    }
    expect(readWorkspaceFileCache(first, "first")).toHaveLength(2 * MIB);

    cacheFile("newest", 1);

    expect(readWorkspaceFileCache(second, "second")).toBeUndefined();
    expect(readWorkspaceFileCache(first, "first")).toHaveLength(2 * MIB);
  });

  it("subtracts replaced bytes before applying the limit", () => {
    const replaced = cacheFile("replaced", 2 * MIB, "old");
    writeWorkspaceFileCache({ filePath: replaced, content: "x", identity: "new" });
    const peers = Array.from({ length: 5 }, (_, index) => cacheFile(`peer-${index}`, 2 * MIB));

    expect(readWorkspaceFileCache(replaced, "new")).toBe("x");
    for (const [index, peer] of peers.entries()) {
      expect(readWorkspaceFileCache(peer, `peer-${index}`)).toHaveLength(2 * MIB);
    }
  });

  it("releases byte accounting on identity mismatch", () => {
    const stale = cacheFile("stale", 2 * MIB, "old");
    expect(readWorkspaceFileCache(stale, "new")).toBeUndefined();
    const peers = Array.from({ length: 6 }, (_, index) => cacheFile(`peer-${index}`, 2 * MIB));

    for (const [index, peer] of peers.entries()) {
      expect(readWorkspaceFileCache(peer, `peer-${index}`)).toHaveLength(2 * MIB);
    }
  });

  it("retires contained entries without evicting sibling roots", () => {
    const contained = cacheFile("contained", 1);
    const siblingRoot = `${workspaceRoot}-sibling`;
    const sibling = path.join(siblingRoot, "sibling");
    writeWorkspaceFileCache({ filePath: sibling, content: "s", identity: "sibling" });

    try {
      retireWorkspaceFileCache(workspaceRoot);

      expect(readWorkspaceFileCache(contained, "contained")).toBeUndefined();
      expect(readWorkspaceFileCache(sibling, "sibling")).toBe("s");
    } finally {
      retireWorkspaceFileCache(siblingRoot);
    }
  });
});
