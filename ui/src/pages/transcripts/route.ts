import { definePage } from "@openclaw/uirouter";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("transcripts"),
  loaderDeps: (_context, { search }) => search,
  loader: (_context, { deps }) => deps,
  component: () =>
    import("./transcripts-page.ts").then((module) => module.transcriptsPageComponent),
});
