import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import {
  applyTokenHubConfig,
  applyTokenPlanConfig,
  TOKENHUB_DEFAULT_MODEL_REF,
  TOKENPLAN_DEFAULT_MODEL_REF,
} from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("Tencent onboarding", () => {
  it.each(["merge", "replace"] as const)("applies the TokenHub preset: %s", (mode) => {
    const config = applyTokenHubConfig({ models: { mode } });

    expect(config.models?.providers?.["tencent-tokenhub"]?.models.map((model) => model.id)).toEqual(
      mode === "replace"
        ? manifest.modelCatalog.providers["tencent-tokenhub"].models.map((model) => model.id)
        : [],
    );
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      TOKENHUB_DEFAULT_MODEL_REF,
    );
    expect(config.agents?.defaults?.models).toEqual({
      [TOKENHUB_DEFAULT_MODEL_REF]: { alias: "Hy3 (TokenHub)" },
      "tencent-tokenhub/hy3-preview": { alias: "Hy3 preview (TokenHub)" },
    });
  });

  it.each(["merge", "replace"] as const)("applies the TokenPlan preset: %s", (mode) => {
    const config = applyTokenPlanConfig({ models: { mode } });

    expect(
      config.models?.providers?.["tencent-tokenplan"]?.models.map((model) => model.id),
    ).toEqual(
      mode === "replace"
        ? manifest.modelCatalog.providers["tencent-tokenplan"].models.map((model) => model.id)
        : [],
    );
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      TOKENPLAN_DEFAULT_MODEL_REF,
    );
    expect(config.agents?.defaults?.models).toEqual({
      [TOKENPLAN_DEFAULT_MODEL_REF]: { alias: "Hy3 (TokenPlan)" },
    });
  });
});
