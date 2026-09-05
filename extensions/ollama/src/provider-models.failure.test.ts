import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { describe, expect, it, vi } from "vitest";
import { buildOllamaProvider } from "./provider-models.js";

describe("Ollama model discovery failures", () => {
  it.each(["http://127.0.0.1:11439", "https://ollama.com"])(
    "catalog cutover: does not replace failed %s model discovery with empty rows",
    async (baseUrl) => {
      const release = vi.fn(async () => undefined);
      const fetchGuard = vi
        .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
        .mockImplementation(async ({ url }) => ({
          response: new Response("unavailable", { status: 503 }),
          finalUrl: url,
          release,
        }));
      try {
        await expect(buildOllamaProvider(baseUrl, { apiKey: "test-key" })).rejects.toThrow();
        expect(fetchGuard).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
      } finally {
        fetchGuard.mockRestore();
      }
    },
  );
});
