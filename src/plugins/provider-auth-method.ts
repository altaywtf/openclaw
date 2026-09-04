import { getGatewayBrowserOrigin } from "../gateway/browser-origin.js";
import { createProviderBrowserAuthSession } from "../gateway/provider-browser-auth.js";
import { openUrl } from "../infra/browser-open.js";
import { isRemoteEnvironment } from "../infra/remote-env.js";
import type {
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthResult,
} from "./provider-authentication.types.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";

export async function runProviderPluginAuthMethodUnpersisted(
  params: Omit<ProviderAuthContext, "oauth" | "openUrl" | "isRemote"> & {
    method: ProviderAuthMethod;
    isRemote?: boolean;
    openUrl?: (url: string) => Promise<void>;
    browserAuthorization?: ProviderAuthContext["oauth"]["authorize"];
  },
): Promise<ProviderAuthResult> {
  const openBrowser =
    params.openUrl ??
    (async (url: string) => {
      if (params.isRemote === true) {
        await params.prompter.openUrl?.(url);
        return;
      }
      await openUrl(url);
    });
  const browserSession =
    !params.browserAuthorization && params.isRemote === true && getGatewayBrowserOrigin()
      ? createProviderBrowserAuthSession({ signal: params.signal, openUrl: openBrowser })
      : undefined;
  const authorize = params.browserAuthorization ?? browserSession?.authorize;
  try {
    params.signal?.throwIfAborted();
    const result = await params.method.run({
      config: params.config,
      env: params.env,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      prompter: params.prompter,
      runtime: params.runtime,
      signal: browserSession?.signal ?? params.signal,
      opts: params.opts,
      secretInputMode: params.secretInputMode,
      allowSecretRefPrompt: params.allowSecretRefPrompt,
      isRemote: params.isRemote ?? isRemoteEnvironment(),
      openUrl: openBrowser,
      oauth: {
        createVpsAwareHandlers: (options) => createVpsAwareOAuthHandlers(options),
        ...(authorize ? { authorize } : {}),
      },
    });
    params.signal?.throwIfAborted();
    browserSession?.assertCurrent();
    return result;
  } finally {
    browserSession?.close();
  }
}
