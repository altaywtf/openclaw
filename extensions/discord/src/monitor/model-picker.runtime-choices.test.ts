import { expect, it } from "vitest";
import { getDiscordModelPickerRuntimeChoices } from "./model-picker.state.js";
import { createModelsProviderData } from "./model-picker.test-utils.js";

it("keeps model-specific runtime choices instead of borrowing another model's alternatives", () => {
  const data = createModelsProviderData({ alpha: ["public", "custom"] });
  const builtin = { id: "openclaw", label: "OpenClaw", description: "Built-in runtime" };
  const native = { id: "fixture-native", label: "Native", description: "Native runtime" };
  data.runtimeChoicesByProvider = new Map([["alpha", [native, builtin]]]);
  data.runtimeChoicesByModel = new Map([
    ["alpha/public", [native, builtin]],
    ["alpha/custom", [builtin]],
  ]);

  expect(
    getDiscordModelPickerRuntimeChoices({ data, provider: "alpha", modelRef: "alpha/public" }),
  ).toEqual([native, builtin]);
  expect(
    getDiscordModelPickerRuntimeChoices({ data, provider: "alpha", modelRef: "alpha/custom" }),
  ).toEqual([builtin]);
});

it("distinguishes an authoritative empty choice set from legacy missing choice data", () => {
  const data = createModelsProviderData({ alpha: ["blocked"] });
  expect(
    getDiscordModelPickerRuntimeChoices({ data, provider: "alpha", modelRef: "alpha/blocked" }),
  ).toBeUndefined();
  data.runtimeChoicesByProvider = new Map([
    ["alpha", [{ id: "openclaw", label: "OpenClaw", description: "Built-in runtime" }]],
  ]);
  data.runtimeChoicesByModel = new Map([["alpha/blocked", []]]);

  expect(
    getDiscordModelPickerRuntimeChoices({ data, provider: "alpha", modelRef: "alpha/blocked" }),
  ).toEqual([]);
});
