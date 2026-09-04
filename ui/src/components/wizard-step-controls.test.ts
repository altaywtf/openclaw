import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardStep } from "../api/types.ts";
import { i18n } from "../i18n/index.ts";
import { renderWizardStepControls } from "./wizard-step-controls.ts";

let container: HTMLDivElement;
const onAnswer = vi.fn();
const onCancel = vi.fn();

function showStep(step: WizardStep) {
  render(
    renderWizardStepControls({
      step,
      value: undefined,
      busy: false,
      inputId: "browser-sign-in",
      onValueChange: vi.fn(),
      onAnswer,
      leadingAction: html`<button type="button" @click=${onCancel}>Cancel</button>`,
    }),
    container,
  );
}

beforeEach(async () => {
  await i18n.setLocale("en");
  container = document.createElement("div");
  onAnswer.mockClear();
  onCancel.mockClear();
});

afterEach(() => {
  render(nothing, container);
});

describe("renderWizardStepControls", () => {
  it("shows the sign-in link through gateway progress without Continue and keeps Cancel", () => {
    const destination = "https://provider.example/oauth?state=state-1";
    for (const message of ["Waiting for sign-in", "Waiting for approval"]) {
      showStep({
        id: "browser-sign-in",
        type: "progress",
        executor: "gateway",
        externalUrl: destination,
        message,
      });

      const link = container.querySelector("a");
      expect(link?.getAttribute("href")).toBe(destination);
      expect(link?.getAttribute("target")).toBe("_blank");
      expect(link?.getAttribute("rel")).toBe("noreferrer");
      expect(link?.textContent?.trim()).toBe("Open sign-in page");
      expect(container.querySelector('[role="status"]')?.textContent).toContain(message);
      expect(
        [...container.querySelectorAll("button")].map((button) => button.textContent?.trim()),
      ).toEqual(["Cancel"]);
      expect(onAnswer).not.toHaveBeenCalled();
    }

    container.querySelector("button")?.click();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("preserves the sign-in link and Continue for a client note", () => {
    const destination = "https://provider.example/device";
    showStep({
      id: "device-sign-in",
      type: "note",
      executor: "client",
      externalUrl: destination,
      message: "Enter the code on the sign-in page.",
    });

    expect(container.querySelector("a")?.getAttribute("href")).toBe(destination);
    const continueButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Continue",
    );
    expect(continueButton).toBeDefined();
    continueButton?.click();
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("does not carry a sign-in link into progress without a browser destination", () => {
    showStep({
      id: "browser-sign-in",
      type: "progress",
      executor: "gateway",
      externalUrl: "https://provider.example/oauth?state=state-1",
    });
    showStep({
      id: "finishing",
      type: "progress",
      executor: "gateway",
      message: "Finishing setup",
    });

    expect(container.querySelector("a")).toBeNull();
    expect(
      [...container.querySelectorAll("button")].map((button) => button.textContent?.trim()),
    ).toEqual(["Cancel"]);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
