import path from "node:path";
import type { JSHandle, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = captureProof
  ? createControlUiE2eArtifactDir("chat-submit-responsiveness")
  : undefined;

async function withChatPage(run: (page: Page) => Promise<void>): Promise<void> {
  const viewport = { height: 900, width: 1280 };
  const context = await suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
    ...(proofDir ? { recordVideo: { dir: path.join(proofDir, "video"), size: viewport } } : {}),
  });
  try {
    await run(await context.newPage());
  } finally {
    await suite.closeBrowserContext(context);
  }
}

async function holdChatOutboxWrites(page: Page): Promise<JSHandle<{ release: () => void }>> {
  return page.evaluateHandle(async () => {
    let database: IDBDatabase | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("openclaw-control-ui");
        request.onsuccess = () => resolve(request.result);
        request.addEventListener("error", () =>
          reject(request.error ?? new Error("IndexedDB request failed")),
        );
      });
      if (candidate.objectStoreNames.contains("chatOutboxes")) {
        database = candidate;
        break;
      }
      candidate.close();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    if (!database) {
      throw new Error("Chat outbox metadata store did not open");
    }
    let hold = true;
    const transaction = database.transaction("chatOutboxes", "readwrite");
    const next = () => {
      const request = transaction.objectStore("chatOutboxes").get("hold-admission");
      request.onsuccess = () => {
        if (hold) {
          next();
        }
      };
    };
    next();
    transaction.oncomplete = () => database.close();
    return { release: () => (hold = false) };
  });
}

suite.define(() => {
  it("keeps the composer intact when the crash journal is unavailable", async () => {
    await withChatPage(async (page) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await page.evaluate(() => {
        // oxlint-disable-next-line typescript/unbound-method -- the wrapper restores `this` via call.
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
          if (key.startsWith("openclaw.control.chatPending.v1:")) {
            throw new DOMException("quota exceeded", "QuotaExceededError");
          }
          return setItem.call(this, key, value);
        };
      });
      await composer.fill("keep this unsent prompt");
      await composer.press("Meta+Enter");

      await expect.poll(() => composer.inputValue()).toBe("keep this unsent prompt");
      await page
        .getByRole("alert")
        .filter({ hasText: "Could not store this message for reconnect" })
        .waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it("journals a cleared prompt if the page closes before IndexedDB admission", async () => {
    await withChatPage(async (page) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const gate = await holdChatOutboxWrites(page);
      await composer.fill("recover this pending admission");
      await composer.press("Meta+Enter");
      await expect.poll(() => composer.inputValue()).toBe("");

      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
      await expect
        .poll(() =>
          page.evaluate(() =>
            Object.keys(localStorage)
              .filter((key) => key.startsWith("openclaw.control.chatPending.v1:"))
              .flatMap((key) => {
                const stored = JSON.parse(localStorage.getItem(key) ?? "{}") as {
                  sessions?: Record<string, { queue?: Array<{ text?: string }> }>;
                };
                return Object.values(stored.sessions ?? {}).flatMap((row) => row.queue ?? []);
              })
              .map((item) => item.text),
          ),
        )
        .toContain("recover this pending admission");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await gate.evaluate((value) => value.release());
      await gate.dispose();
    });
  });

  it("keeps a removed pending admission retired", async () => {
    await withChatPage(async (page) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("discard before delivery");
      await gateway.setOnline(false);
      await gateway.closeLatest();
      const gate = await holdChatOutboxWrites(page);

      await composer.press("Enter");
      const queued = page.locator(".chat-queue__item", { hasText: "discard before delivery" });
      await queued.waitFor();
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "retirement-admitted.png") });
      }
      await page.evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
      );
      expect(
        await page.evaluate(() =>
          Object.keys(localStorage)
            .filter((key) => key.startsWith("openclaw.control.chatPending.v1:"))
            .map((key) => localStorage.getItem(key) ?? "")
            .join("\n"),
        ),
      ).toContain("discard before delivery");
      await queued.locator(".chat-queue__remove").evaluate((button: HTMLElement) => button.click());
      await queued.waitFor({ state: "detached" });
      await composer.fill("next draft stays mine");
      await page.evaluate(() => {
        const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put");
        if (!descriptor) {
          throw new Error("IndexedDB put descriptor unavailable");
        }
        Object.defineProperty(IDBObjectStore.prototype, "put", {
          ...descriptor,
          value(this: IDBObjectStore, record: unknown, key?: IDBValidKey) {
            if (this.name === "chatOutboxes") {
              throw new DOMException("quota exceeded", "QuotaExceededError");
            }
            return Reflect.apply(
              descriptor.value,
              this,
              key === undefined ? [record] : [record, key],
            );
          },
        });
      });
      await gate.evaluate((value) => value.release());
      await gate.dispose();
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
      const journal = await page.evaluate(() =>
        Object.keys(localStorage)
          .filter((key) => key.startsWith("openclaw.control.chatPending.v1:"))
          .map((key) => localStorage.getItem(key) ?? "")
          .join("\n"),
      );
      expect(journal).not.toContain("discard before delivery");
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "retirement-resumed.png") });
      }
      expect(await page.getByRole("alert").allTextContents()).toEqual([]);
      expect(await composer.inputValue()).toBe("next draft stays mine");
      expect(await page.locator(".chat-queue__item").count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it("journals a durable removal before its IndexedDB delete settles", async () => {
    await withChatPage(async (page) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("remove this durable prompt");
      await gateway.setOnline(false);
      await gateway.closeLatest();
      await composer.press("Enter");
      const queued = page.locator(".chat-queue__item", { hasText: "remove this durable prompt" });
      await queued.waitFor();
      await expect
        .poll(() =>
          page.evaluate(() =>
            Object.keys(localStorage)
              .filter((key) => key.startsWith("openclaw.control.chatPending.v1:"))
              .map((key) => localStorage.getItem(key) ?? "")
              .join("\n"),
          ),
        )
        .not.toContain("remove this durable prompt");
      const itemId = await page.evaluate(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("openclaw-control-ui");
          request.addEventListener("success", () => resolve(request.result), { once: true });
          request.addEventListener(
            "error",
            () => reject(request.error ?? new Error("failed to open the Control UI database")),
            { once: true },
          );
        });
        try {
          const request = database.transaction("chatOutboxes").objectStore("chatOutboxes").getAll();
          const documents = await new Promise<
            Array<{ sessions?: Record<string, { queue?: Array<{ id: string }> }> }>
          >((resolve, reject) => {
            request.addEventListener("success", () => resolve(request.result), { once: true });
            request.addEventListener(
              "error",
              () => reject(request.error ?? new Error("failed to read chat outboxes")),
              { once: true },
            );
          });
          return documents.flatMap((document) =>
            Object.values(document.sessions ?? {}).flatMap((session) => session.queue ?? []),
          )[0]?.id;
        } finally {
          database.close();
        }
      });
      expect(itemId).toBeTruthy();
      const gate = await holdChatOutboxWrites(page);
      await queued.locator(".chat-queue__remove").evaluate((button: HTMLElement) => button.click());
      await expect
        .poll(() =>
          page.evaluate(() =>
            Object.keys(localStorage)
              .filter((key) => key.startsWith("openclaw.control.chatPending.v1:"))
              .flatMap((key) => {
                const stored = JSON.parse(localStorage.getItem(key) ?? "{}") as {
                  retired?: string[];
                };
                return stored.retired ?? [];
              }),
          ),
        )
        .toContain(itemId);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
      await gate.evaluate((value) => value.release());
      await gate.dispose();
      await queued.waitFor({ state: "detached" });
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it("accepts a second prompt while durability and acknowledgment remain pending", async () => {
    await withChatPage(async (page) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor();
      const gate = await holdChatOutboxWrites(page);
      await composer.fill("first prompt");
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "before-submit.png") });
        await page.waitForTimeout(400);
      }
      await composer.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement;
        const order: string[] = [];
        let submissionStarted = false;
        const record = (value: string) => {
          order.push(value);
          textarea.dataset.submitTaskOrder = JSON.stringify(order);
        };
        const tracksOutbox = (key: string, value: string | null) =>
          submissionStarted &&
          key.startsWith("openclaw.control.chatComposer") &&
          value?.includes('"queue":') === true;
        // oxlint-disable-next-line typescript/unbound-method -- the wrapper restores `this` via call.
        const getItem = Storage.prototype.getItem;
        Storage.prototype.getItem = function (this: Storage, key: string) {
          const value = getItem.call(this, key);
          if (tracksOutbox(key, value)) {
            record("storage:getItem");
          }
          return value;
        };
        // oxlint-disable-next-line typescript/unbound-method -- the wrapper restores `this` via call.
        const removeItem = Storage.prototype.removeItem;
        Storage.prototype.removeItem = function (this: Storage, key: string) {
          if (tracksOutbox(key, getItem.call(this, key))) {
            record("storage:removeItem");
          }
          return removeItem.call(this, key);
        };
        // oxlint-disable-next-line typescript/unbound-method -- the wrapper restores `this` via call.
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
          if (tracksOutbox(key, value)) {
            record("storage:setItem");
          }
          return setItem.call(this, key, value);
        };
        const send = Object.getOwnPropertyDescriptor(WebSocket.prototype, "send")
          ?.value as WebSocket["send"];
        WebSocket.prototype.send = function (data) {
          if (
            typeof data === "string" &&
            (JSON.parse(data) as { method?: string }).method === "chat.send"
          ) {
            const frame = JSON.parse(data) as { params?: { message?: string } };
            record(`transport:${frame.params?.message ?? ""}`);
          }
          Reflect.apply(send, this, [data]);
        };
        textarea.addEventListener(
          "keydown",
          function onSubmit(event) {
            // Meta+Enter emits a modifier keydown first; only submission queues the next input.
            if (event.key !== "Enter") {
              return;
            }
            submissionStarted = true;
            textarea.removeEventListener("keydown", onSubmit, true);
            const channel = new MessageChannel();
            channel.port1.addEventListener(
              "message",
              () => {
                channel.port1.close();
                channel.port2.close();
                textarea.value = "second prompt";
                textarea.dispatchEvent(
                  new InputEvent("input", {
                    bubbles: true,
                    data: "second prompt",
                    inputType: "insertText",
                  }),
                );
                record("next-input-task");
                submissionStarted = false;
              },
              { once: true },
            );
            channel.port1.start();
            channel.port2.postMessage(undefined);
          },
          { capture: true },
        );
      });

      await composer.press("Meta+Enter");
      await expect
        .poll(async () =>
          JSON.parse((await composer.getAttribute("data-submit-task-order")) ?? "[]"),
        )
        .toEqual(["next-input-task"]);
      expect(await composer.inputValue()).toBe("second prompt");
      await composer.press("Meta+Enter");
      await expect.poll(() => composer.inputValue()).toBe("");
      await expect.poll(() => page.locator(".chat-queue__item").count()).toBe(2);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "next-prompt-ready.png") });
      }
      await gateway.deferNext("chat.send");
      await gate.evaluate((value) => value.release());
      await gate.dispose();
      const first = await gateway.waitForRequest("chat.send");
      expect(first.params).toMatchObject({ message: "first prompt" });
      await gateway.resolveDeferred("chat.send");
      await gateway.emitChatFinal({
        runId: String((first.params as { idempotencyKey?: string }).idempotencyKey),
        text: "first complete",
      });
      const second = await gateway.waitForRequest("chat.send", { after: 1 });
      expect(second.params).toMatchObject({ message: "second prompt" });
      await expect
        .poll(async () =>
          JSON.parse((await composer.getAttribute("data-submit-task-order")) ?? "[]"),
        )
        .toEqual(["next-input-task", "transport:first prompt", "transport:second prompt"]);
    });
  });

  it("hands off consecutive prompts before an authoritative history refresh settles", async () => {
    await withChatPage(async (page) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor();
      const priorHistory = (await gateway.getRequests("chat.history")).length;
      await gateway.deferNext("chat.history");
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [],
        hasActiveRun: false,
        message: { content: [{ text: "history fence" }], role: "assistant" },
        messageId: "history-fence",
        messageSeq: 1,
        session: {
          activeRunIds: [],
          hasActiveRun: false,
          key: "agent:main:main",
          kind: "direct",
          status: "done",
          updatedAt: Date.now(),
        },
        sessionKey: "agent:main:main",
      });
      await gateway.waitForRequest("chat.history", { after: priorHistory });

      await composer.fill("first history-fenced prompt");
      await composer.press("Meta+Enter");
      await expect.poll(() => composer.inputValue()).toBe("");
      await composer.fill("second history-fenced prompt");
      await composer.press("Meta+Enter");
      await expect.poll(() => composer.inputValue()).toBe("");
      await expect.poll(() => page.locator(".chat-queue__item").count()).toBe(2);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await gateway.deferNext("chat.send");
      await gateway.resolveDeferred("chat.history", {
        messages: [],
        sessionInfo: { key: "main", hasActiveRun: false, status: "done" },
      });
      const first = await gateway.waitForRequest("chat.send");
      expect(first.params).toMatchObject({ message: "first history-fenced prompt" });
      await gateway.resolveDeferred("chat.send");
      await gateway.emitChatFinal({
        runId: String((first.params as { idempotencyKey?: string }).idempotencyKey),
        text: "first history-fenced prompt complete",
      });
      const second = await gateway.waitForRequest("chat.send", { after: 1 });
      expect(second.params).toMatchObject({ message: "second history-fenced prompt" });
    });
  });
});
