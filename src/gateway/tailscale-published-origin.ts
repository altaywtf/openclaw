type TailscalePublishedOrigin = {
  origin: string;
  mode: "serve" | "funnel";
};

let publishedOrigin: (TailscalePublishedOrigin & { owner: symbol }) | undefined;

/** Publish only a live managed route; its owner withdraws the origin on exit or shutdown. */
export function prepareTailscalePublishedOrigin(snapshot: TailscalePublishedOrigin): () => void {
  const url = new URL(snapshot.origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Tailscale published origin must be an absolute HTTPS origin");
  }
  const owner = Symbol("tailscale-published-origin");
  publishedOrigin = { origin: url.origin, mode: snapshot.mode, owner };
  return () => {
    if (publishedOrigin?.owner === owner) {
      publishedOrigin = undefined;
    }
  };
}

export function getTailscalePublishedOrigin(): TailscalePublishedOrigin | undefined {
  return publishedOrigin
    ? { origin: publishedOrigin.origin, mode: publishedOrigin.mode }
    : undefined;
}
