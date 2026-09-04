// Control UI E2E proves that Markdown becomes rich text in the composer itself.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat composer rich text",
});

suite.define(() => {
  it("formats Markdown in place while preserving the Markdown sent to the Gateway", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const editor = page.locator(".agent-chat__composer-editor .cm-content");
      const source = page.locator(".agent-chat__composer-combobox textarea");
      const draft =
        "> A quoted note\n\n**Bold direction** with `inline code`\n\n- First task\n- Second task";

      await expect.poll(() => editor.isVisible()).toBe(true);
      await expect
        .poll(() => source.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("0");
      await expect
        .poll(() => page.locator(".agent-chat__composer-markdown-preview").count())
        .toBe(0);
      await editor.fill(draft);

      await expect
        .poll(() => page.locator(".cm-line.chat-composer-rich-quote").textContent())
        .toContain("A quoted note");
      await expect
        .poll(() => page.locator(".chat-composer-rich-strong").textContent())
        .toBe("Bold direction");
      await expect
        .poll(() => page.locator(".chat-composer-rich-code").textContent())
        .toBe("inline code");
      await expect.poll(() => page.locator(".chat-composer-rich-list-item").count()).toBe(2);
      await expect.poll(() => editor.textContent()).not.toContain("**");

      await page.getByRole("button", { name: "Send message" }).click();
      const request = await gateway.waitForRequest("chat.send");
      expect(requireRecord(request.params).message).toBe(draft);
    });
  });

  it("keeps a long rich draft scrollable inside the composer", async () => {
    await suite.withPage({ viewport: { width: 900, height: 700 } }, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const editor = page.locator(".agent-chat__composer-editor .cm-content");
      const scroller = page.locator(".agent-chat__composer-editor .cm-scroller");
      await editor.fill(
        Array.from({ length: 16 }, (_, index) => `- **Task ${index + 1}**`).join("\n"),
      );

      await expect
        .poll(() =>
          scroller.evaluate((element) => ({
            clientHeight: element.clientHeight,
            overflowY: getComputedStyle(element).overflowY,
            scrollHeight: element.scrollHeight,
          })),
        )
        .toMatchObject({ overflowY: "auto" });
      const dimensions = await scroller.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
      expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
    });
  });
});
