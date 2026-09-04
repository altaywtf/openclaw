// Composer undo/redo regression: controlled draft synchronization must not
// clobber the visible editor's history bookkeeping (#131708).
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeComposerUndoRedo = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

const COMPOSER_EDITOR = ".agent-chat__composer-editor .cm-content";
const COMPOSER_SOURCE = ".agent-chat__composer-source";
const TYPED_TEXT = "hello world test";

let browser: Browser | null = null;
let page: Page | null = null;
let server: ControlUiE2eServer | null = null;

describeComposerUndoRedo("chat composer undo/redo", () => {
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: chromiumExecutablePath,
      headless: true,
    });
    server = await startControlUiE2eServer();
    page = await browser.newPage();
    await installMockGateway(page);
    await page.goto(`${server.baseUrl}chat/main`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.locator(COMPOSER_EDITOR).waitFor({ timeout: 30_000 });
  });

  afterAll(async () => {
    await page?.close();
    await server?.close();
    await browser?.close();
  });

  it("keeps redo working after undo in the rich editor", async () => {
    const editor = page!.locator(COMPOSER_EDITOR);
    const source = page!.locator(COMPOSER_SOURCE);
    await editor.click();
    await editor.pressSequentially(TYPED_TEXT);
    expect(await source.inputValue()).toBe(TYPED_TEXT);

    await page!.keyboard.press("ControlOrMeta+a");
    await page!.keyboard.press("Backspace");
    expect(await source.inputValue()).toBe("");

    await page!.keyboard.press("ControlOrMeta+z");
    expect(await source.inputValue()).toBe(TYPED_TEXT);

    // Redo must re-apply the deletion while preserving the exact Markdown
    // source that the composer sends to the Gateway.
    await page!.keyboard.press("ControlOrMeta+Shift+z");
    expect(await source.inputValue()).toBe("");
  });
});
