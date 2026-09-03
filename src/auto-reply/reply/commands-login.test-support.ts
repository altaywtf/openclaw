import { clearActiveProviderLoginFlowsForTest } from "./commands-login.js";

export const testing = {
  clearActiveFlows(): void {
    clearActiveProviderLoginFlowsForTest();
  },
};
