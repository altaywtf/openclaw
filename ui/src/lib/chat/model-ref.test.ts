// @vitest-environment node
// Control UI tests cover chat model ref behavior.
import { describe, expect, it } from "vitest";
import {
  buildCatalogDisplayLookup,
  buildChatModelOptionFromLookup,
  buildQualifiedChatModelValue,
  formatCatalogChatModelDisplayFromLookup,
} from "./model-ref.ts";

describe("chat-model-ref helpers", () => {
  it("preserves provider-native nested ids and prefers aliases", () => {
    const nested = {
      id: "moonshotai/kimi-k2.5",
      alias: "Kimi K2.5 (NVIDIA)",
      name: "Kimi K2.5",
      provider: "nvidia",
    };
    const lookup = buildCatalogDisplayLookup([nested]);

    expect(buildChatModelOptionFromLookup(nested, lookup)).toEqual({
      value: "nvidia/moonshotai/kimi-k2.5",
      label: "Kimi K2.5 (NVIDIA)",
    });
    expect(formatCatalogChatModelDisplayFromLookup("nvidia/moonshotai/kimi-k2.5", lookup)).toBe(
      "Kimi K2.5 (NVIDIA)",
    );
  });

  it.each([
    {
      id: "claude-opus-4-8",
      name: "Opus 4.8",
      alias: "opus",
      expected: "Opus 4.8 · opus",
    },
    {
      id: "claude-sonnet-5",
      name: "Sonnet 5",
      alias: "sonnet",
      expected: "Sonnet 5 · sonnet",
    },
    {
      id: "claude-sonnet-5",
      name: "Sonnet 5",
      alias: "My preferred model",
      expected: "Sonnet 5 · My preferred model",
    },
  ])(
    "keeps the canonical model name visible beside the $alias selection alias",
    ({ id, name, alias, expected }) => {
      const entry = { id, name, alias, provider: "anthropic" };
      const lookup = buildCatalogDisplayLookup([entry]);

      expect(buildChatModelOptionFromLookup(entry, lookup)).toEqual({
        value: `anthropic/${id}`,
        label: expected,
      });
      expect(formatCatalogChatModelDisplayFromLookup(`anthropic/${id}`, lookup)).toBe(expected);
    },
  );

  it.each([
    { model: "gpt-5-mini", provider: undefined, expected: "gpt-5-mini" },
    { model: "deepseek-chat", provider: "zai", expected: "zai/deepseek-chat" },
    { model: "moonshotai/kimi-k2.5", provider: "nvidia", expected: "nvidia/moonshotai/kimi-k2.5" },
    { model: "openrouter/auto", provider: "openrouter", expected: "openrouter/auto" },
    { model: "openai/gpt-5-mini", provider: "openai", expected: "openai/gpt-5-mini" },
    { model: "openai/gpt-5-mini", provider: "zai", expected: "zai/openai/gpt-5-mini" },
    { model: "", provider: "openai", expected: "" },
  ])(
    "formats $provider / $model without selecting a different route",
    ({ model, provider, expected }) => {
      expect(buildQualifiedChatModelValue(model, provider)).toBe(expected);
    },
  );
});
