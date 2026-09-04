import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { ModelChoiceSchema } from "./schema/agents-models-skills.js";

describe("model capabilities", () => {
  const validator = Compile(ModelChoiceSchema);
  it.each([true, false, undefined])("accepts fast-mode capability %s", (supportsFastMode) => {
    expect(
      validator.Check({
        id: "model",
        name: "Model",
        provider: "provider",
        supportsFastMode,
        thinkingLevels: [],
      }),
    ).toBe(true);
  });
  it.each(["true", null, { supported: true }])(
    "rejects invalid capability %j",
    (supportsFastMode) => {
      expect(
        validator.Check({ id: "model", name: "Model", provider: "provider", supportsFastMode }),
      ).toBe(false);
    },
  );
});
