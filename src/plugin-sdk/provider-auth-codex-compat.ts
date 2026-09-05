import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { asNonArrayRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveOsHomeRelativePath } from "../infra/home-dir.js";
import { loadJsonFileThroughSymlink } from "../infra/json-file.js";
import { decodeOpenAICodexJwtPayload } from "./provider-openai-chatgpt-auth.js";

const CODEX_CLI_FALLBACK_EXPIRY_MS = 60 * 60 * 1000;

type CodexCliCredential = {
  type: "oauth";
  provider: "openai";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  idToken?: string;
};

type CodexCliCredentialReadOptions = {
  codexHome?: string;
  allowKeychainPrompt?: boolean;
  ttlMs?: number;
  platform?: NodeJS.Platform;
  execSync?: typeof execSync;
};

let codexCliCache: {
  value: CodexCliCredential | null;
  readAt: number;
  cacheKey: string;
  sourceFingerprint: number | null;
} | null = null;

function resolveCodexCliHome(codexHome?: string): string {
  const home = resolveOsHomeRelativePath((codexHome ?? process.env.CODEX_HOME) || "~/.codex");
  try {
    return fs.realpathSync.native(home);
  } catch {
    return home;
  }
}

function readFileMtimeMs(authPath: string): number | null {
  try {
    return fs.statSync(authPath).mtimeMs;
  } catch {
    return null;
  }
}

function resolveCodexFallbackExpiryMs(nowMs?: number): number | undefined {
  return resolveExpiresAtMsFromDurationMs(CODEX_CLI_FALLBACK_EXPIRY_MS, {
    nowMs: nowMs === undefined ? undefined : Math.floor(nowMs),
  });
}

function parseCodexOauthCredential(
  data: Record<string, unknown>,
  fallbackExpiry: number | undefined,
): CodexCliCredential | null {
  const authMode = typeof data.auth_mode === "string" ? data.auth_mode.toLowerCase() : undefined;
  if (
    authMode
      ? authMode !== "chatgpt" && authMode !== "chatgptauthtokens"
      : typeof data.OPENAI_API_KEY === "string"
  ) {
    return null;
  }
  const tokens = asNonArrayRecord(data.tokens);
  const access = tokens.access_token;
  const refresh = tokens.refresh_token;
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) {
    return null;
  }
  const exp = decodeOpenAICodexJwtPayload(access)?.exp;
  const tokenExpiry =
    typeof exp === "number" && Number.isFinite(exp) && exp > 0
      ? asDateTimestampMs(exp * 1000)
      : undefined;
  const expires = tokenExpiry ?? fallbackExpiry;
  if (expires === undefined) {
    return null;
  }
  return {
    type: "oauth",
    provider: "openai",
    access,
    refresh,
    expires,
    accountId: typeof tokens.account_id === "string" ? tokens.account_id : undefined,
    idToken: typeof tokens.id_token === "string" ? tokens.id_token : undefined,
  };
}

function readCodexKeychainCredential(
  codexHome: string,
  execSyncImpl: typeof execSync,
): CodexCliCredential | null {
  const account = `cli|${createHash("sha256").update(codexHome).digest("hex").slice(0, 16)}`;
  let raw: unknown;
  try {
    const secret = execSyncImpl(
      `security find-generic-password -s "Codex Auth" -a "${account}" -w`,
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );
    raw = JSON.parse(secret.trim());
  } catch {
    return null;
  }
  const data = asNonArrayRecord(raw);
  const lastRefreshRaw = data.last_refresh;
  const lastRefresh =
    typeof lastRefreshRaw === "string" || typeof lastRefreshRaw === "number"
      ? new Date(lastRefreshRaw).getTime()
      : Date.now();
  return parseCodexOauthCredential(
    data,
    resolveCodexFallbackExpiryMs(lastRefresh) ?? resolveCodexFallbackExpiryMs(),
  );
}

/**
 * @deprecated Synchronous v2026.8.1 Plugin SDK contract; not native auth or catalog discovery.
 * Remove only in a breaking SDK release after external callers migrate to plugin-owned auth.
 */
export function readCodexCliCredentialsCached(
  options: CodexCliCredentialReadOptions = {},
): CodexCliCredential | null {
  const codexHome = resolveCodexCliHome(options.codexHome);
  const authPath = path.join(codexHome, "auth.json");
  const platform = options.platform ?? process.platform;
  const useKeychain = platform === "darwin" && options.allowKeychainPrompt !== false;
  const read = (): CodexCliCredential | null => {
    if (useKeychain) {
      const credential = readCodexKeychainCredential(codexHome, options.execSync ?? execSync);
      if (credential) {
        return credential;
      }
    }
    const data = loadJsonFileThroughSymlink(authPath);
    return isRecord(data)
      ? parseCodexOauthCredential(
          data,
          resolveCodexFallbackExpiryMs(readFileMtimeMs(authPath) ?? undefined),
        )
      : null;
  };

  const ttlMs = options.ttlMs ?? 0;
  if (ttlMs <= 0) {
    return read();
  }
  const cacheKey = `${platform}|${authPath}:${useKeychain ? "keychain" : "file"}`;
  const now = Date.now();
  const sourceFingerprint = readFileMtimeMs(authPath);
  if (
    codexCliCache?.cacheKey === cacheKey &&
    codexCliCache.sourceFingerprint === sourceFingerprint &&
    now - codexCliCache.readAt < ttlMs
  ) {
    return codexCliCache.value;
  }
  const value = read();
  const nextFingerprint = readFileMtimeMs(authPath);
  codexCliCache =
    nextFingerprint === sourceFingerprint
      ? { value, readAt: now, cacheKey, sourceFingerprint: nextFingerprint }
      : null;
  return value;
}
