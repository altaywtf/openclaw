import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  cronListResponse,
  waitForCronPage,
} from "./cron-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("CronPage model catalog", () => {
  it.each(["config.changed", "chat.metadata.changed"])(
    "updates mounted automation model suggestions after %s without reconnecting",
    async (event) => {
      let models = [{ id: "synthetic/first", name: "First", provider: "synthetic" }];
      const fallbackRequest = createRequest();
      const request = vi.fn(async (method: string, _params?: unknown) =>
        method === "models.list" ? { models } : fallbackRequest(method),
      );
      const gateway = createGateway(createTestGatewayClient(request), true);
      const page = createPage(createContext(gateway));
      await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["synthetic/first"]));
      const draft = page.cron.cronForm;

      models = [{ id: "synthetic/published", name: "Published", provider: "synthetic" }];
      gateway.emitEvent({ type: "event", event, payload: {} });

      await waitForCronPage(() =>
        expect(page.cronModelSuggestions).toEqual(["synthetic/published"]),
      );
      expect(page.cron.cronForm).toBe(draft);
      expect(
        request.mock.calls
          .filter(([method]) => method === "models.list")
          .every(([, params]) => !(params as { refresh?: boolean }).refresh),
      ).toBe(true);
    },
  );

  it.each(["transport", "refresh"] as const)(
    "keeps automation model choices and shows %s failures until recovery",
    async (failure) => {
      let failing = false;
      let models = [{ id: "synthetic/first", name: "First", provider: "synthetic" }];
      const fallbackRequest = createRequest();
      const request = vi.fn(async (method: string) => {
        if (method !== "models.list") {
          return fallbackRequest(method);
        }
        if (failing && failure === "transport") {
          throw new Error("Catalog unavailable");
        }
        return failing ? { models: [], refreshFailed: true } : { models };
      });
      const gateway = createGateway(createTestGatewayClient(request), true);
      const page = createPage(createContext(gateway), { render: true });
      await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["synthetic/first"]));
      const draft = page.cron.cronForm;

      failing = true;
      gateway.emitEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
      await waitForCronPage(() =>
        expect(page.querySelector('[role="alert"]')?.textContent?.trim()).toBeTruthy(),
      );
      expect(page.cronModelSuggestions).toEqual(["synthetic/first"]);
      expect(page.cron.cronForm).toBe(draft);

      failing = false;
      models = [{ id: "synthetic/recovered", name: "Recovered", provider: "synthetic" }];
      gateway.emitEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
      await waitForCronPage(() =>
        expect(page.cronModelSuggestions).toEqual(["synthetic/recovered"]),
      );
      await page.updateComplete;
      expect(page.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it("rejects model suggestions from an earlier connection epoch", async () => {
    const staleModels = createDeferred<{ models: Array<{ id: string }> }>();
    let modelRequestCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "models.list") {
        modelRequestCount += 1;
        return modelRequestCount === 1 ? staleModels.promise : { models: [{ id: "fresh/model" }] };
      }
      if (method === "cron.list") {
        return cronListResponse([]);
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, hasMore: false };
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, false);
    const page = createPage(createContext(gateway));
    await page.updateComplete;

    gateway.emitSnapshot({ phase: "connected" });
    await waitForCronPage(() => expect(modelRequestCount).toBe(1));
    gateway.emitSnapshot({ phase: "stopped" });
    gateway.emitSnapshot({ phase: "connected" });
    await waitForCronPage(() => expect(page.cronModelSuggestions).toEqual(["fresh/model"]));

    staleModels.resolve({ models: [{ id: "stale/model" }] });
    await Promise.resolve();
    await Promise.resolve();

    expect(page.cronModelSuggestions).toEqual(["fresh/model"]);
  });
});
