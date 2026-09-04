// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
});

it("loads cloud worker English with its page while preserving shared and localized copy", async () => {
  vi.resetModules();
  const { en } = await import("./en.ts");
  const { i18n, t } = await import("../lib/translate.ts");
  const shared = en.common;
  expect(en.cloudWorkersPage).toEqual({});

  const { registerCloudWorkersEnglish } = await import("./en-cloud-workers.ts");
  registerCloudWorkersEnglish();
  expect(en.common).toBe(shared);
  expect(t("cloudWorkersPage.addProfile")).toBe("Add profile");
  expect(t("cloudWorkersPage.deleteConfirm", { profile: "example" })).toBe(
    "Delete profile example? New cloud sessions cannot use it after restart.",
  );

  i18n.registerTranslation("de", { cloudWorkersPage: { addProfile: "Profil hinzufügen" } });
  await i18n.setLocale("de");
  registerCloudWorkersEnglish();
  expect(t("cloudWorkersPage.addProfile")).toBe("Profil hinzufügen");
  expect(t("cloudWorkersPage.errors.saveFailed")).toBe(
    "The profile was not saved. Reload the config and try again.",
  );
});
