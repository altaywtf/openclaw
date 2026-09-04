import { render } from "lit";
import { describe, expect, it } from "vitest";
import {
  buildSessionObserverTogglePatch,
  buildSessionObserverUtilityModelPatch,
  renderSessionObserverSettings,
} from "./session-observer-settings.ts";

describe("session observer settings patches", () => {
  it("uses null to restore the default toggle and false to opt out", () => {
    expect(buildSessionObserverTogglePatch(true)).toEqual({
      gateway: { controlUi: { sessionObserver: null } },
    });
    expect(buildSessionObserverTogglePatch(false)).toEqual({
      gateway: { controlUi: { sessionObserver: false } },
    });
  });

  it("distinguishes automatic, disabled, and explicit utility models", () => {
    expect(buildSessionObserverUtilityModelPatch({ kind: "auto" })).toEqual({
      agents: { defaults: { utilityModel: null } },
    });
    expect(buildSessionObserverUtilityModelPatch({ kind: "disabled" })).toEqual({
      agents: { defaults: { utilityModel: "" } },
    });
    expect(
      buildSessionObserverUtilityModelPatch({ kind: "model", model: "openai/gpt-5-mini" }),
    ).toEqual({
      agents: { defaults: { utilityModel: "openai/gpt-5-mini" } },
    });
  });

  it.each([
    {
      modelsUnavailable: true,
      modelsRefreshError: null,
      message: "Explicit model catalog unavailable",
    },
    {
      modelsUnavailable: false,
      modelsRefreshError: "Could not refresh models; showing previous choices.",
      message: "showing previous choices",
    },
  ])(
    "keeps auto and disabled selectable when catalog warning is $message",
    ({ modelsUnavailable, modelsRefreshError, message }) => {
      const container = document.createElement("div");
      render(
        renderSessionObserverSettings({
          enabled: true,
          utilityModel: undefined,
          resolvedUtilityModel: { status: "unavailable" },
          models: [{ id: "gpt-mini", name: "GPT Mini", provider: "openai" }],
          modelsUnavailable,
          modelsRefreshError,
          disabled: false,
          onEnabledChange: () => undefined,
          onUtilityModelChange: () => undefined,
        }),
        container,
      );

      const select = container.querySelector("wa-select.model-picker__select");
      const options = [...(select?.querySelectorAll("wa-option") ?? [])];
      const option = (label: string) =>
        options.find((candidate) => candidate.textContent?.trim() === label);
      expect(select?.hasAttribute("disabled")).toBe(false);
      expect(option("Auto (provider default)")?.hasAttribute("disabled")).toBe(false);
      expect(option("Disabled")?.hasAttribute("disabled")).toBe(false);
      expect(option("GPT Mini")?.hasAttribute("disabled")).toBe(modelsUnavailable);
      expect(container.textContent).toContain(message);
    },
  );
});
