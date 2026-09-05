import { afterEach, expect, it, vi } from "vitest";
import * as modelSelection from "../agents/model-selection-shared.js";
import { resolveCommandArgChoices, resolveCommandArgMenu } from "./commands-registry.js";
import type { ChatCommandDefinition, CommandArgDefinition } from "./commands-registry.types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it.each(["choices", "menu"] as const)(
  "does not reconstruct catalog %s from config when prepared command context has no catalog",
  (surface) => {
    vi.spyOn(modelSelection, "buildConfiguredModelCatalog").mockReturnValue([
      { provider: "alpha", id: "stale-configured", name: "Stale configured model" },
    ]);
    const arg: CommandArgDefinition = {
      name: "model",
      description: "Model",
      type: "string",
      choices: ({ catalog }) => (catalog ?? []).map((entry) => `${entry.provider}/${entry.id}`),
    };
    const command: ChatCommandDefinition = {
      key: "catalog-owner",
      description: "Catalog owner fixture",
      textAliases: ["/catalog-owner"],
      scope: "both",
      args: [arg],
      argsMenu: "auto",
    };
    const params = {
      command,
      cfg: { agents: { defaults: { model: "alpha/published" } } },
      provider: "alpha",
      model: "published",
    };

    if (surface === "choices") {
      expect(resolveCommandArgChoices({ ...params, arg })).toEqual([]);
    } else {
      expect(resolveCommandArgMenu(params)).toBeNull();
    }
  },
);
