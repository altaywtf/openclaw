// Control UI E2E proves that Markdown is readable while it is being composed.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat composer Markdown preview",
});

suite.define(() => {
  it("renders the draft with the same rich text structures as a chat message", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const draft =
        "> A quoted note\n\n**Bold direction** with `inline code`\n\n- First task\n- Second task";
      const lines = draft.split("\n");
      for (const [index, line] of lines.entries()) {
        await composer.pressSequentially(line);
        if (index < lines.length - 1) {
          await composer.press("Shift+Enter");
        }
      }

      const preview = page.locator(".agent-chat__composer-markdown-preview");
      await expect
        .poll(() => preview.locator("blockquote").textContent())
        .toContain("A quoted note");
      await expect.poll(() => preview.locator("strong").textContent()).toBe("Bold direction");
      await expect.poll(() => preview.locator("code").textContent()).toBe("inline code");
      await expect
        .poll(() => preview.locator("li").allTextContents())
        .toEqual(["First task", "Second task"]);
      await expect.poll(() => composer.inputValue()).toContain("**Bold direction**");
    });
  });
});
