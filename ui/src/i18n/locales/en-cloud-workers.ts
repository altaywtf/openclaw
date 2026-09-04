import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Only the lazy Cloud Workers page uses this copy. Keep shared route labels eager.
const enCloudWorkers = {
  cloudWorkersPage: {
    intro: "Run agent sessions on ephemeral cloud machines instead of this gateway.",
    sectionTitle: "Profiles",
    sectionDescription: "Each profile defines how its provider provisions and retires a worker.",
    empty: "No cloud worker profiles are configured.",
    addProfile: "Add profile",
    editProfile: "Edit profile",
    editAction: "Edit",
    deleteTitle: "Delete cloud worker profile",
    deleteConfirm: "Delete profile {profile}? New cloud sessions cannot use it after restart.",
    advertised: "Advertised",
    restartRequired: "Restart required",
    adminRequired: "Administrator access is required to manage cloud worker profiles.",
    catalogFailed: "Could not load advertised profiles: {error}. Check the gateway and retry.",
    providerFact: "Provider: {provider}",
    backendFact: "Crabbox backend: {backend}",
    classFact: "Class: {value}",
    ttlFact: "Max lifetime: {value}",
    idleFact: "Idle stop: {value}",
    desktopFact: "Desktop: {value}",
    providerList: "View supported backends",
    fields: {
      profileId: "Profile ID",
      profileIdHelp: "Use letters, numbers, hyphens, or underscores.",
      backend: "Crabbox backend",
      backendHelp: "The backend passed to Crabbox, such as AWS or Hetzner.",
      backendPlaceholder: "hetzner",
      machineClass: "Machine class",
      machineClassHelp:
        "Enter a class accepted by the selected Crabbox backend and binary. The provider determines its effective sizing.",
      ttl: "Max lifetime",
      ttlHelp: "Use a positive Go duration such as 8h or 90m.",
      ttlPlaceholder: "8h",
      idleTimeout: "Idle stop",
      idleTimeoutHelp: "Stop an unused worker after this positive Go duration.",
      idleTimeoutPlaceholder: "45m",
      setup: "Setup command",
      setupHelp: "Optional idempotent shell command run before OpenClaw is installed.",
      setupPlaceholder: "command -v node || install-node",
      desktop: "Desktop",
      desktopHelp:
        "Warm a direct or coordinator-backed AWS worker, or a coordinator-backed Hetzner worker, with node-carried Browser and Terminal access. Existing workers must be reprovisioned after this changes.",
      binary: "Crabbox binary",
      binaryHelp: "Optional absolute path to the Crabbox executable on the gateway.",
      binaryPlaceholder: "/usr/local/bin/crabbox",
      actions: "Save profile",
      actionsHelp: "Saving updates the config; the gateway must restart before using it.",
    },
    errors: {
      title: "Profile needs attention",
      profileId:
        "Use a profile ID that starts with a letter or number and contains only letters, numbers, hyphens, or underscores.",
      profileExists: "Choose another profile ID; this one already exists.",
      profileMissing: "This profile changed or was removed. Reload the page and try again.",
      backend: "Enter a Crabbox backend, such as aws or hetzner.",
      machineClass: "Enter a machine class of 1 to 128 characters.",
      ttl: "Enter a positive Go duration for max lifetime, such as 8h or 90m.",
      idleTimeout: "Enter a positive Go duration for idle stop, such as 45m.",
      binary: "Enter an absolute Crabbox binary path or leave the field empty.",
      saveFailed: "The profile was not saved. Reload the config and try again.",
      deleteFailed: "The profile was not deleted. Reload the config and try again.",
    },
  },
} satisfies TranslationMap;

export const registerCloudWorkersEnglish = Object.assign(
  () => {
    en.cloudWorkersPage = enCloudWorkers.cloudWorkersPage;
  },
  { catalog: enCloudWorkers },
);
