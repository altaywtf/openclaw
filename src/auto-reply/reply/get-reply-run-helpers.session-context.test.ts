import { expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { TemplateContext } from "../templating.js";
import { resolvePromptSessionContextForSystemEvent } from "./get-reply-run-helpers.js";
import { REPLY_OPERATION_RUN_STATE } from "./reply-operation-run-state.js";

const sessionEntry: SessionEntry = {
  sessionId: "session",
  updatedAt: 1,
  chatType: "channel",
  groupChannel: "#later",
  delivery: normalizeSessionDeliveryState({
    context: {
      channel: "discord",
      to: "later-target",
      accountId: "later-account",
      threadId: "later-thread",
    },
  }),
};

it.each([
  {},
  { OriginatingChannel: "telegram", OriginatingTo: "original-target" },
  {
    OriginatingChannel: "discord",
    OriginatingTo: "later-target",
    MessageThreadId: "later-thread",
  },
  {
    OriginatingChannel: "discord",
    OriginatingTo: "later-target",
    AccountId: "later-account",
  },
  {
    OriginatingChannel: "telegram",
    OriginatingTo: "original-target",
    AccountId: "original-account",
    MessageThreadId: "original-thread",
  },
] as const)("preserves the captured completion route including absent fields: %j", (route) => {
  const sessionCtx: TemplateContext = {
    Body: "command completed",
    InternalTurnSource: "exec",
    Provider: "webchat",
    ...route,
  };
  const params = {
    sessionCtx,
    sessionEntry,
    opts: { [REPLY_OPERATION_RUN_STATE]: { backgroundTurn: { trigger: "background" as const } } },
  };
  expect(resolvePromptSessionContextForSystemEvent(params)).toEqual(sessionCtx);
});

it("uses stored group facts only for the same captured conversation", () => {
  const sessionCtx: TemplateContext = {
    Body: "completion",
    Provider: "discord",
    OriginatingChannel: "discord",
    OriginatingTo: "later-target",
    AccountId: "later-account",
    MessageThreadId: "later-thread",
  };
  expect(
    resolvePromptSessionContextForSystemEvent({
      sessionCtx,
      sessionEntry,
      opts: { [REPLY_OPERATION_RUN_STATE]: { backgroundTurn: { trigger: "background" } } },
    }),
  ).toEqual({ ...sessionCtx, ChatType: "channel", GroupChannel: "#later" });
});

it.each(["heartbeat", "cron", "exec"] as const)(
  "retains persisted context for legacy %s wakes",
  (source) => {
    const sessionCtx: TemplateContext = { Body: "wake", InternalTurnSource: source };
    expect(resolvePromptSessionContextForSystemEvent({ sessionCtx, sessionEntry })).toMatchObject({
      Provider: "discord",
      ChatType: "channel",
      GroupChannel: "#later",
      OriginatingTo: "later-target",
      AccountId: "later-account",
      MessageThreadId: "later-thread",
    });
  },
);
