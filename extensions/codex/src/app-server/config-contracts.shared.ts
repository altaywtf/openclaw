export type OpenClawExecMode = "deny" | "allowlist" | "ask" | "auto" | "full";
export type OpenClawExecSecurity = "deny" | "allowlist" | "full";
export type OpenClawExecAsk = "off" | "on-miss" | "always";
export type OpenClawExecApprovalFloorsForCodexAppServer = {
  security?: OpenClawExecSecurity;
  ask?: OpenClawExecAsk;
};
export type OpenClawExecPolicyForCodexAppServer = {
  mode: OpenClawExecMode;
  security: OpenClawExecSecurity;
  ask: OpenClawExecAsk;
  touched: boolean;
};
export type OpenClawExecPolicy = OpenClawExecPolicyForCodexAppServer;

export type CodexAppServerCommandSource = "managed" | "resolved-managed" | "config" | "env";
export type CodexPluginDestructivePolicy = boolean | "auto" | "ask";
export type CodexPluginDestructiveApprovalMode = "allow" | "deny" | "auto" | "ask";

export const CODEX_APP_SERVER_PROVIDER_ID_PATTERN =
  /^\s*(?!(?:[cC][oO][nN][sS][tT][rR][uU][cC][tT][oO][rR]|[pP][rR][oO][tT][oO][tT][yY][pP][eE])\s*$)[A-Za-z0-9][A-Za-z0-9_-]*\s*$/;
export const CODEX_PLUGIN_MARKETPLACE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export type CodexPluginMarketplaceName = string;

export type ResolvedCodexPluginPolicy = {
  configKey: string;
  marketplaceName: CodexPluginMarketplaceName;
  pluginName: string;
  enabled: boolean;
  allowDestructiveActions: boolean;
  destructiveApprovalMode: CodexPluginDestructiveApprovalMode;
};

export type ResolvedCodexPluginsPolicy = {
  configured: boolean;
  enabled: boolean;
  allowAllPlugins: boolean;
  allowDestructiveActions: boolean;
  destructiveApprovalMode: CodexPluginDestructiveApprovalMode;
  pluginPolicies: ResolvedCodexPluginPolicy[];
};
