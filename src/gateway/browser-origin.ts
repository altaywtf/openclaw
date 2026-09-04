import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type GatewayBrowserOrigin = Readonly<{
  origin: string;
  reachability: "tailnet" | "internet";
}>;

const state = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayBrowserOrigin"),
  (): { current?: GatewayBrowserOrigin } => ({}),
  (published) => {
    published.current = undefined;
  },
);

/** Install the process-lifecycle snapshot used by terminal channel replies. */
export function prepareGatewayBrowserOrigin(snapshot: GatewayBrowserOrigin): () => void {
  const url = new URL(snapshot.origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Gateway browser origin must be an absolute HTTPS origin");
  }
  const origin = Object.freeze({ origin: url.origin, reachability: snapshot.reachability });
  state.current = origin;
  return () => {
    if (state.current === origin) {
      state.current = undefined;
    }
  };
}

export function getGatewayBrowserOrigin(): GatewayBrowserOrigin | undefined {
  return state.current;
}
