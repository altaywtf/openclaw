import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createPreparedModelCatalogProviderNormalizer } from "../../agents/model-catalog-provider-normalizer.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import { createModelCatalogProviderAliasCanonicalizer } from "./provider-aliases.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const PLUGIN_ID = "catalog-alias-owner";
const PROVIDER_ID = "independent-provider";

describe("model catalog provider alias ownership", () => {
  it("uses the prepared catalog's first-owner policy for colliding aliases", () => {
    const root = tempDirs.make("openclaw-catalog-alias-collision-");
    const plugins = ["first-target", "second-target"].map(
      (providerId, index): PluginManifestRecord => {
        const pluginId = `alias-owner-${index}`;
        const rootDir = path.join(root, pluginId);
        return {
          id: pluginId,
          providers: [providerId],
          channels: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "bundled",
          rootDir,
          source: path.join(rootDir, "index.js"),
          manifestPath: path.join(rootDir, "openclaw.plugin.json"),
          modelCatalog: { aliases: { [PROVIDER_ID]: { provider: providerId } } },
        };
      },
    );
    const metadataSnapshot = { manifestRegistry: { plugins, diagnostics: [] } };
    const preparedProvider = createPreparedModelCatalogProviderNormalizer(metadataSnapshot);
    const canonicalizer = createModelCatalogProviderAliasCanonicalizer({
      cfg: {},
      metadataSnapshot,
    });

    expect(preparedProvider(PROVIDER_ID)).toBe("first-target");
    expect.soft(canonicalizer.provider(PROVIDER_ID)).toBe("first-target");
    expect(canonicalizer.ref({ provider: PROVIDER_ID, model: "shared-model" })).toEqual({
      provider: "first-target",
      model: "shared-model",
    });
  });

  it.each(["dist", "dist-runtime"])(
    "does not import a peer alias absent from the supplied %s snapshot",
    (buildDirectory) => {
      const root = tempDirs.make("openclaw-catalog-alias-owner-");
      const publishedRoot = path.join(root, buildDirectory, "extensions", PLUGIN_ID);
      const peerRoot = path.join(root, "extensions", PLUGIN_ID);
      const configSchema = { type: "object", additionalProperties: false, properties: {} };
      fs.mkdirSync(publishedRoot, { recursive: true });
      fs.mkdirSync(peerRoot, { recursive: true });
      fs.writeFileSync(
        path.join(publishedRoot, "openclaw.plugin.json"),
        JSON.stringify({
          id: PLUGIN_ID,
          providers: [PROVIDER_ID],
          configSchema,
          modelCatalog: {
            providers: { [PROVIDER_ID]: { models: [{ id: "published-model" }] } },
          },
        }),
      );
      fs.writeFileSync(
        path.join(peerRoot, "openclaw.plugin.json"),
        JSON.stringify({
          id: PLUGIN_ID,
          providers: ["peer-target"],
          configSchema,
          modelCatalog: {
            aliases: { [PROVIDER_ID]: { provider: "peer-target" } },
          },
        }),
      );
      const published = loadPluginManifest(publishedRoot);
      const peer = loadPluginManifest(peerRoot);
      if (!published.ok || !peer.ok) {
        throw new Error("alias fixture manifests must both pass the production parser");
      }
      expect(published.manifest.modelCatalog?.aliases).toBeUndefined();
      expect(peer.manifest.modelCatalog?.aliases).toEqual({
        [PROVIDER_ID]: { provider: "peer-target" },
      });
      const plugin: PluginManifestRecord = {
        id: PLUGIN_ID,
        providers: [PROVIDER_ID],
        channels: [],
        cliBackends: [],
        skills: [],
        hooks: [],
        origin: "bundled",
        rootDir: publishedRoot,
        source: path.join(publishedRoot, "index.js"),
        manifestPath: published.manifestPath,
        modelCatalog: published.manifest.modelCatalog,
      };
      const canonicalizer = createModelCatalogProviderAliasCanonicalizer({
        cfg: {},
        metadataSnapshot: { manifestRegistry: { plugins: [plugin], diagnostics: [] } },
      });
      const ref = { provider: PROVIDER_ID, model: "published-model" };

      expect.soft(canonicalizer.provider(PROVIDER_ID)).toBe(PROVIDER_ID);
      expect(canonicalizer.ref(ref)).toBe(ref);
    },
  );
});
