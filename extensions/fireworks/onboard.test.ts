import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { applyFireworksConfig } from "./onboard.js";
import { FIREWORKS_DEFAULT_MODEL_REF, buildFireworksCatalogModels } from "./provider-catalog.js";

describe("Fireworks onboarding", () => {
  it.each(["merge", "replace"] as const)(
    "applies the connection, default, and alias: %s",
    (mode) => {
      const config = applyFireworksConfig({ models: { mode } });

      expect(config.models?.providers?.fireworks?.models).toEqual(
        mode === "replace" ? buildFireworksCatalogModels() : [],
      );
      expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
        FIREWORKS_DEFAULT_MODEL_REF,
      );
      expect(config.agents?.defaults?.models).toEqual({
        [FIREWORKS_DEFAULT_MODEL_REF]: { alias: "GLM 5.2 Fast" },
      });
    },
  );
});
