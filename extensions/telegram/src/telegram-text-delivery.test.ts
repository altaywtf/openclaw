import { describe, expect, it, vi } from "vitest";
import { TELEGRAM_RICH_REQUEST_BYTE_LIMIT } from "./rich-plain-fallback.js";
import { deliverTelegramTextPage } from "./telegram-text-delivery.js";

describe("deliverTelegramTextPage", () => {
  it("degrades an oversized rich page to plain chunks before it reaches Telegram", async () => {
    // Telegram never answers request bodies past the byte budget, so the rich attempt must be
    // skipped up front instead of waiting on a hung request with no fallback trigger.
    const cell = "x".repeat(200);
    const rows = Array.from({ length: 90 }, () => ({ cells: [{ text: cell }, { text: cell }] }));
    const richMessage = { blocks: [{ type: "table", rows }] };
    expect(Buffer.byteLength(JSON.stringify(richMessage))).toBeGreaterThan(
      TELEGRAM_RICH_REQUEST_BYTE_LIMIT,
    );
    const plainText = Array.from({ length: 90 }, () => `${cell} ${cell}`).join("\n");
    const sendRich = vi.fn(async () => "rich");
    const sendPlain = vi.fn(async (text: string) => `plain:${text.length}`);
    const warn = vi.fn();

    const delivered = await deliverTelegramTextPage({
      page: { plainText, richMessage } as never,
      context: "test send",
      warn,
      sender: { sendPlain, sendHtml: vi.fn(async () => "html"), sendRich },
    });

    expect(sendRich).not.toHaveBeenCalled();
    expect(sendPlain.mock.calls.length).toBeGreaterThan(1);
    expect(delivered.every((part) => part.result.startsWith("plain:"))).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("degrade=plain-fallback:rich-payload-too-large"),
    );
  });

  it("sends a rich page within the byte budget as one rich message", async () => {
    const richMessage = { blocks: [{ type: "paragraph", text: "hello" }] };
    const sendRich = vi.fn(async () => "rich");
    const sendPlain = vi.fn(async () => "plain");

    const delivered = await deliverTelegramTextPage({
      page: { plainText: "hello", richMessage } as never,
      context: "test send",
      warn: vi.fn(),
      sender: { sendPlain, sendHtml: vi.fn(async () => "html"), sendRich },
    });

    expect(sendRich).toHaveBeenCalledOnce();
    expect(sendPlain).not.toHaveBeenCalled();
    expect(delivered.map((part) => part.result)).toEqual(["rich"]);
  });
});
