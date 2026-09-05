import type { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  buildOauthProviderAuthResult,
  buildOpenAICodexCredentialExtra,
  hasUsableOAuthCredential,
  readCodexCliCredentialsCached,
  resolveOpenAICodexAuthIdentity,
  resolveOpenAICodexImportProfileName,
  updateAuthProfileStoreWithLock,
} from "./provider-auth.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("supports the provider-auth imports and credential read used by @openclaw/codex@2026.8.1", async () => {
  const publishedImports = {
    applyAuthProfileConfig,
    buildApiKeyCredential,
    buildOauthProviderAuthResult,
    buildOpenAICodexCredentialExtra,
    hasUsableOAuthCredential,
    readCodexCliCredentialsCached,
    resolveOpenAICodexAuthIdentity,
    resolveOpenAICodexImportProfileName,
    updateAuthProfileStoreWithLock,
  };
  for (const [name, helper] of Object.entries(publishedImports)) {
    expect(helper, name).toBeTypeOf("function");
  }

  const codexHome = tempDirs.make("openclaw-sdk-codex-auth-");
  const access = [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify({ exp: 1_800_000_000 })).toString("base64url"),
    "signature",
  ].join(".");
  await fs.writeFile(
    path.join(codexHome, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        access_token: access,
        refresh_token: "legacy-refresh",
        account_id: "legacy-account",
        id_token: "legacy-id-token",
      },
    }),
  );

  expect(
    readCodexCliCredentialsCached({
      codexHome,
      allowKeychainPrompt: false,
      platform: "linux",
      ttlMs: 0,
    }),
  ).toEqual({
    type: "oauth",
    provider: "openai",
    access,
    refresh: "legacy-refresh",
    expires: 1_800_000_000_000,
    accountId: "legacy-account",
    idToken: "legacy-id-token",
  });
});

it.each([
  { mode: "legacy OAuth", fields: {}, readable: true },
  { mode: "legacy API key", fields: { OPENAI_API_KEY: "" }, readable: false },
  { mode: "API key", fields: { auth_mode: "apikey" }, readable: false },
  {
    mode: "ChatGPT",
    fields: { auth_mode: "chatgpt", OPENAI_API_KEY: "stale-api-key" },
    readable: true,
  },
  { mode: "ChatGPT auth tokens", fields: { auth_mode: "chatgptauthtokens" }, readable: true },
])("preserves the shipped $mode credential selection", async ({ fields, readable }) => {
  const codexHome = tempDirs.make("openclaw-sdk-codex-mode-");
  await fs.writeFile(
    path.join(codexHome, "auth.json"),
    JSON.stringify({
      ...fields,
      tokens: { access_token: "legacy-access", refresh_token: "legacy-refresh" },
    }),
  );
  const credential = readCodexCliCredentialsCached({ codexHome, platform: "linux", ttlMs: 0 });
  if (readable) {
    expect(credential).toMatchObject({ access: "legacy-access", refresh: "legacy-refresh" });
  } else {
    expect(credential).toBeNull();
  }
});

it("invalidates cached credentials on file changes and retains file-based fallback expiry", async () => {
  const codexHome = tempDirs.make("openclaw-sdk-codex-cache-");
  const authPath = path.join(codexHome, "auth.json");
  for (const [refresh, timestamp] of [
    ["first-refresh", 1_800_000_000_000],
    ["second-refresh", 1_800_000_060_000],
  ] as const) {
    await fs.writeFile(
      authPath,
      JSON.stringify({
        tokens: { access_token: "legacy-access", refresh_token: refresh },
        last_refresh: "2026-01-01T00:00:00Z",
      }),
    );
    await fs.utimes(authPath, new Date(timestamp), new Date(timestamp));
    expect(
      readCodexCliCredentialsCached({ codexHome, platform: "linux", ttlMs: 60_000 }),
    ).toMatchObject({
      access: "legacy-access",
      refresh,
      expires: timestamp + 60 * 60 * 1000,
    });
  }
});

it("keeps prompt-enabled Keychain credentials separate from no-prompt cache entries", () => {
  const codexHome = tempDirs.make("openclaw-sdk-codex-keychain-");
  const execSyncMock = vi.fn<typeof execSync>().mockReturnValue(
    JSON.stringify({
      tokens: { access_token: "keychain-access", refresh_token: "keychain-refresh" },
      last_refresh: "2026-01-01T00:00:00Z",
    }),
  );
  const options = { codexHome, platform: "darwin", ttlMs: 60_000, execSync: execSyncMock } as const;
  expect(readCodexCliCredentialsCached({ ...options, allowKeychainPrompt: false })).toBeNull();
  expect(execSyncMock).not.toHaveBeenCalled();
  expect(readCodexCliCredentialsCached({ ...options, allowKeychainPrompt: true })).toMatchObject({
    access: "keychain-access",
    refresh: "keychain-refresh",
    expires: Date.parse("2026-01-01T01:00:00Z"),
  });
  expect(readCodexCliCredentialsCached({ ...options, allowKeychainPrompt: false })).toBeNull();
  expect(execSyncMock).toHaveBeenCalledTimes(1);
  const account = `cli|${createHash("sha256").update(codexHome).digest("hex").slice(0, 16)}`;
  expect(execSyncMock).toHaveBeenCalledWith(
    `security find-generic-password -s "Codex Auth" -a "${account}" -w`,
    { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
  );
});
