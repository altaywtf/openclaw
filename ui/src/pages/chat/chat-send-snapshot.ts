import { parseSlashCommand } from "../../lib/chat/commands.ts";
import { observeOutboxRecoveryOwner } from "../../lib/chat/outbox-payload-store.runtime.ts";
import type { ChatHost } from "./chat-send-contract.ts";
export {
  chatSubmitKey,
  clearSubmittedComposerState,
  ownsSubmittedComposerState,
  snapshotChatAttachments,
} from "./chat-send-composer.ts";

export function isChatResetCommand(text: string): boolean {
  const parsed = parseSlashCommand(text);
  return (
    parsed?.command.key === "new" ||
    (parsed?.command.key === "reset" && !/^soft(?:\s|$)/i.test(parsed.args))
  );
}

export function captureSubmittedCredentialOwner(host: ChatHost): () => boolean {
  const gatewayUrl = host.settings?.gatewayUrl;
  const incognito = host.selectedChatSessionIncognito;
  const recoveryOwner = observeOutboxRecoveryOwner(host);
  return () =>
    host.settings?.gatewayUrl === gatewayUrl &&
    host.selectedChatSessionIncognito === incognito &&
    observeOutboxRecoveryOwner(host) === recoveryOwner;
}

export function prependReplyQuote(
  message: string,
  replyTarget: NonNullable<ChatHost["chatReplyTarget"]>,
): string {
  const label = replyTarget.senderLabel?.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1") ?? "User";
  const text = replyTarget.text.trim();
  if (!text.includes("\n")) {
    return `> **${label}:** ${text}\n\n${message}`;
  }
  const quoted = text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `> **${label}:**\n${quoted}\n\n${message}`;
}
