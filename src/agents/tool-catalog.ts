/**
 * Core tool catalog and profile defaults.
 * Drives built-in profile allowlists, group expansion, and UI section metadata
 * for OpenClaw-owned tools.
 *
 * This module is bundled into the Control UI via tool-policy-shared. Keep it
 * pure data + tiny pure functions: a value import of server config/runtime
 * modules here drags the whole gateway graph into the ui build and breaks it.
 */
import {
  AGENTS_WAIT_TOOL_DISPLAY_SUMMARY,
  ASK_USER_TOOL_DISPLAY_SUMMARY,
  CRON_TOOL_DISPLAY_SUMMARY,
  EXEC_TOOL_DISPLAY_SUMMARY,
  PROCESS_TOOL_DISPLAY_SUMMARY,
  SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
  SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
  SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
  SKILL_WORKSHOP_TOOL_DISPLAY_SUMMARY,
  SUGGEST_TASK_TOOL_DISPLAY_SUMMARY,
  DISMISS_TASK_TOOL_DISPLAY_SUMMARY,
} from "./tool-description-presets.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";

/** Built-in tool profile ids exposed in config and UI. */
export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

/** Allow/deny policy generated from a built-in tool profile. */
type ToolProfilePolicy = {
  allow?: string[];
  deny?: string[];
};

type CoreToolSection = {
  id: string;
  label: string;
  tools: Array<{
    id: string;
    label: string;
    description: string;
  }>;
};

type CoreToolDefinition = {
  id: keyof typeof CORE_TOOL_DESCRIPTIONS;
  sectionId: string;
  profiles: ToolProfileId[];
  includeInOpenClawGroup?: boolean;
};

const CORE_TOOL_SECTION_ORDER: Array<{ id: string; label: string }> = [
  { id: "fs", label: "Files" },
  { id: "runtime", label: "Runtime" },
  { id: "web", label: "Web" },
  { id: "memory", label: "Memory" },
  { id: "sessions", label: "Sessions" },
  { id: "ui", label: "UI" },
  { id: "messaging", label: "Messaging" },
  { id: "automation", label: "Automation" },
  { id: "nodes", label: "Nodes" },
  { id: "agents", label: "Agents" },
  { id: "media", label: "Media" },
];

// Policy consumers need ids and membership, not catalog copy. Keep descriptions
// separate so the browser policy bundle can omit them and their preset imports.
const CORE_TOOL_DESCRIPTIONS = {
  read: "Read file contents",
  write: "Create or overwrite files",
  edit: "Make precise edits",
  apply_patch: "Patch files",
  exec: EXEC_TOOL_DISPLAY_SUMMARY,
  process: PROCESS_TOOL_DISPLAY_SUMMARY,
  code_execution: "Run sandboxed remote analysis",
  secrets: "Request and manage write-only credentials",
  web_search: "Search the web",
  web_fetch: "Fetch web content",
  x_search: "Search X posts",
  memory_search: "Semantic search",
  memory_get: "Read memory files",
  sessions: "Session settings: label, pin, archive, groups",
  sessions_list: SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
  sessions_history: SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
  sessions_search: SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
  conversations_list: "List exact external conversation addresses",
  conversations_send: "Send to an exact external conversation",
  conversations_turn: "Send and wait for a correlated external reply",
  sessions_send: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
  sessions_spawn: SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
  github_identity_status: "Inspect the effective GitHub identity and credential health",
  github_publish: "Publish the reconciled session worktree as a draft GitHub pull request",
  agents_wait: AGENTS_WAIT_TOOL_DISPLAY_SUMMARY,
  sessions_yield: "End turn to receive sub-agent results",
  subagents: "Background work: subagents, media gen, automation runs. list/cancel.",
  session_status: SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
  suggest_task: SUGGEST_TASK_TOOL_DISPLAY_SUMMARY,
  dismiss_task: DISMISS_TASK_TOOL_DISPLAY_SUMMARY,
  browser: "Control web browser",
  screen: "Drive operator web UI",
  dashboard: "Read and arrange the session dashboard",
  terminal: "Use shared operator terminals with policy-governed input",
  portal: "Expose local web apps through the gateway",
  canvas: "Control node Canvas surfaces when the Canvas plugin is enabled",
  show_widget: "Show an interactive widget on chat or an auto-fitting dashboard",
  message: "Send messages",
  heartbeat_respond: "Accept heartbeat outcomes for post-turn handling",
  [AUTOMATIONS_TOOL_NAME]: CRON_TOOL_DISPLAY_SUMMARY,
  gateway: "Read Gateway config/schema; owner-only OpenClaw self-update",
  nodes: "Nodes + devices",
  computer: "Control a paired computer node desktop",
  mobile_ui: "Observe and control a paired Android app",
  agents_list: "List agents",
  get_goal: "Get current thread goal",
  create_goal: "Create a thread goal",
  update_goal: "Complete or block a thread goal",
  progress_card: "Maintain the session progress card",
  ask_user: ASK_USER_TOOL_DISPLAY_SUMMARY,
  skill_workshop: SKILL_WORKSHOP_TOOL_DISPLAY_SUMMARY,
  view_image: "Image understanding",
  image_generate: "Image generation",
  music_generate: "Music generation",
  video_generate: "Video generation",
  tts: "Text-to-speech conversion",
};

const CORE_TOOL_DEFINITIONS: CoreToolDefinition[] = [
  {
    id: "read",
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "write",
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "edit",
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "apply_patch",
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "exec",
    sectionId: "runtime",
    profiles: ["coding"],
  },
  {
    id: "process",
    sectionId: "runtime",
    profiles: ["coding"],
  },
  {
    id: "code_execution",
    sectionId: "runtime",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "secrets",
    sectionId: "runtime",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "web_search",
    sectionId: "web",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "web_fetch",
    sectionId: "web",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "x_search",
    sectionId: "web",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "memory_search",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "memory_get",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_list",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_history",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_search",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "conversations_list",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "conversations_send",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "conversations_turn",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_send",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_spawn",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "github_identity_status",
    sectionId: "sessions",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "github_publish",
    sectionId: "sessions",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "agents_wait",
    sectionId: "sessions",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_yield",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "subagents",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "session_status",
    sectionId: "sessions",
    profiles: ["minimal", "coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "suggest_task",
    sectionId: "sessions",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "dismiss_task",
    sectionId: "sessions",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "browser",
    sectionId: "ui",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "screen",
    sectionId: "ui",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "dashboard",
    sectionId: "ui",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "terminal",
    sectionId: "ui",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "portal",
    sectionId: "ui",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "canvas",
    sectionId: "ui",
    profiles: [],
  },
  {
    id: "show_widget",
    sectionId: "ui",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "message",
    sectionId: "messaging",
    profiles: ["messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "heartbeat_respond",
    sectionId: "automation",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: AUTOMATIONS_TOOL_NAME,
    sectionId: "automation",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "gateway",
    sectionId: "automation",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "nodes",
    sectionId: "nodes",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "computer",
    sectionId: "nodes",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "mobile_ui",
    sectionId: "nodes",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "agents_list",
    sectionId: "agents",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "get_goal",
    sectionId: "agents",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "create_goal",
    sectionId: "agents",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "update_goal",
    sectionId: "agents",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "progress_card",
    sectionId: "agents",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "ask_user",
    sectionId: "agents",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "skill_workshop",
    sectionId: "agents",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "view_image",
    sectionId: "media",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "image_generate",
    sectionId: "media",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "music_generate",
    sectionId: "media",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "video_generate",
    sectionId: "media",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "tts",
    sectionId: "media",
    profiles: [],
    includeInOpenClawGroup: true,
  },
];

const CORE_TOOL_BY_ID = new Map<string, CoreToolDefinition>(
  CORE_TOOL_DEFINITIONS.map((tool) => [tool.id, tool]),
);

// Section membership is static; capability filtering and response objects stay per request.
const CORE_TOOL_SECTIONS = CORE_TOOL_SECTION_ORDER.map(({ id, label }) => ({
  id,
  label,
  tools: CORE_TOOL_DEFINITIONS.filter((tool) => tool.sectionId === id),
}));

function listCoreToolIdsForProfile(profile: ToolProfileId): string[] {
  return CORE_TOOL_DEFINITIONS.filter((tool) => tool.profiles.includes(profile)).map(
    (tool) => tool.id,
  );
}

const CORE_TOOL_PROFILES: Record<ToolProfileId, ToolProfilePolicy> = {
  minimal: {
    allow: listCoreToolIdsForProfile("minimal"),
  },
  coding: {
    allow: [...listCoreToolIdsForProfile("coding"), "bundle-mcp"],
  },
  messaging: {
    allow: [...listCoreToolIdsForProfile("messaging"), "bundle-mcp"],
  },
  full: {
    allow: ["*"],
  },
};

function buildCoreToolGroupMap() {
  const sectionToolMap = new Map<string, string[]>();
  for (const tool of CORE_TOOL_DEFINITIONS) {
    const groupId = `group:${tool.sectionId}`;
    const list = sectionToolMap.get(groupId) ?? [];
    list.push(tool.id);
    sectionToolMap.set(groupId, list);
  }
  const openclawTools = CORE_TOOL_DEFINITIONS.filter((tool) => tool.includeInOpenClawGroup).map(
    (tool) => tool.id,
  );
  return {
    "group:openclaw": openclawTools,
    ...Object.fromEntries(sectionToolMap.entries()),
  };
}

/** Built-in core tool groups keyed by group id. */
export const CORE_TOOL_GROUPS = buildCoreToolGroupMap();

/** Profile options shown in model/tool configuration UIs. */
export const PROFILE_OPTIONS = [
  { id: "minimal", label: "Minimal" },
  { id: "coding", label: "Coding" },
  { id: "messaging", label: "Messaging" },
  { id: "full", label: "Full" },
] as const;

/** Resolves the allow/deny policy for a built-in tool profile. */
export function resolveCoreToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  if (!profile) {
    return undefined;
  }
  const resolved = CORE_TOOL_PROFILES[profile as ToolProfileId];
  if (!resolved) {
    return undefined;
  }
  if (!resolved.allow && !resolved.deny) {
    return undefined;
  }
  return {
    allow: resolved.allow ? [...resolved.allow] : undefined,
    deny: resolved.deny ? [...resolved.deny] : undefined,
  };
}

/** Lists core tools grouped into UI sections. */
export function listCoreToolSections(params?: {
  swarmEnabled?: boolean;
  githubPublicationAvailable?: boolean;
}): CoreToolSection[] {
  // Callers resolve the swarm gate and pass the fact in; resolving config here
  // would couple this ui-shared module to the server graph.
  const swarmEnabled = params?.swarmEnabled === true;
  return CORE_TOOL_SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
    tools: section.tools
      .filter(
        (tool) =>
          (tool.id !== "agents_wait" || swarmEnabled) &&
          (tool.id !== "github_identity_status" ||
            params?.githubPublicationAvailable !== undefined) &&
          (tool.id !== "github_publish" || params?.githubPublicationAvailable === true),
      )
      .map((tool) => ({
        id: tool.id,
        label: tool.id,
        description: CORE_TOOL_DESCRIPTIONS[tool.id],
      })),
  })).filter((section) => section.tools.length > 0);
}

/** Lists built-in profile ids that include a core tool. */
export function resolveCoreToolProfiles(toolId: string): ToolProfileId[] {
  const tool = CORE_TOOL_BY_ID.get(toolId);
  if (!tool) {
    return [];
  }
  return [...tool.profiles];
}

/** Returns true when a tool id is a known core tool. */
export function isKnownCoreToolId(toolId: string): boolean {
  return CORE_TOOL_BY_ID.has(toolId);
}
