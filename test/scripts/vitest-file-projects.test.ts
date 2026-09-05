import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import type {
  TestProjectConfiguration,
  UserProjectConfigFn,
  UserWorkspaceConfig,
} from "vitest/config";
import { createVitest } from "vitest/node";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("native standalone file projects", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  const fixture = () => {
    const root = fs.realpathSync(dirs.make("oc-file-projects-"));
    fs.symlinkSync(
      path.join(repoRoot, "node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    const write = (file: string, source: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), source);
    };
    fs.mkdirSync(path.join(root, "override"));
    write(
      "configs/arbitrary.mjs",
      "export default {test:{name:'leaf',pool:'threads',projects:['missing-child']}};",
    );
    write("legacy/vitest.config.mjs", "export default {test:{name:'directory',env:{LEAF:'yes'}}};");
    write(
      "vitest.container.config.mjs",
      "export default {test:{name:'container',projects:['./legacy/vitest.config.mjs']}};",
    );
    write(
      "vitest.a.config.mjs",
      "export default {test:{name:'a',projects:['./vitest.b.config.mjs']}};",
    );
    write(
      "vitest.b.config.mjs",
      "export default {test:{name:'b',projects:['./vitest.a.config.mjs']}};",
    );
    return {
      root,
      resolve: async (projects: string, project?: string[]) => {
        const config = path.join(root, "vitest.config.mjs");
        write(
          "vitest.config.mjs",
          `export default {test:{name:'parent',env:{PARENT:'yes'},projects:${projects}}};`,
        );
        const ctx = await createVitest({
          root,
          config,
          project,
          configLoader: "runner",
          watch: false,
          reporters: [],
        });
        try {
          return ctx.projects.map((entry) => ({
            name: entry.name,
            root: path.normalize(entry.config.root),
            config: entry.vite.config.configFile
              ? path.normalize(entry.vite.config.configFile)
              : undefined,
            pool: entry.config.pool,
            namePrefix: entry.namePrefix,
            projects: entry.config.projects,
            env: entry.config.env,
          }));
        } finally {
          // createVitest closes initialization failures; successful contexts belong here.
          await ctx.close();
        }
      },
    };
  };

  it.each([
    ["file", "configs/arbitrary.mjs", "leaf"],
    ["self", "vitest.config.mjs", "parent"],
  ] as const)("retains captured container context for a %s project", async (_, file, name) => {
    const { resolve } = fixture();
    const prefix = "outer (inner)";
    const projects = await resolve(
      JSON.stringify([{ configFile: file, root: ".", namePrefix: prefix }]),
    );
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ name: `${prefix} (${name})`, namePrefix: prefix });
  });

  it("records container context for projects injected after initial resolution", async () => {
    const { root } = fixture();
    const ctx = await createVitest(
      { root, config: false, watch: false, reporters: [] },
      {
        plugins: [
          {
            name: "fixture-inject",
            async configureVitest({ injectTestProjects }) {
              await injectTestProjects(["./vitest.container.config.mjs"]);
            },
          },
        ],
      },
    );
    try {
      const injected = ctx.projects.filter((project) => project.namePrefix === "container");
      expect(injected).toHaveLength(1);
      expect(injected[0]).toMatchObject({ name: "container (directory)", namePrefix: "container" });
    } finally {
      await ctx.close();
    }
  });

  it.each([
    ["explicit root", "[{configFile:'configs/arbitrary.mjs',root:'override'}]", "override"],
    ["directory default", "[{configFile:'configs/arbitrary.mjs'}]", "configs"],
    ["root token", "[{configFile:'<rootDir>/configs/arbitrary.mjs',root:'.'}]", ""],
  ] as const)("resolves one real file project with %s", async (_, input, relativeRoot) => {
    const { root, resolve } = fixture();
    const projects = await resolve(input);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      name: "leaf",
      root: path.join(root, relativeRoot),
      config: path.join(root, "configs/arbitrary.mjs"),
      pool: "threads",
      projects: ["missing-child"],
    });
  });

  it.each([
    ["same root", "[{configFile:'vitest.config.mjs',root:'.'}]", ""],
    ["different root", "[{configFile:'vitest.config.mjs',root:'override'}]", "override"],
    ["omitted root", "[{configFile:'vitest.config.mjs'}]", ""],
  ] as const)("keeps a self-running config with %s standalone", async (_, input, relativeRoot) => {
    const { root, resolve } = fixture();
    const projects = await resolve(input);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      name: "parent",
      root: path.join(root, relativeRoot),
      config: path.join(root, "vitest.config.mjs"),
    });
    expect(projects[0]!.projects).toHaveLength(1);
  });

  it.each([
    ["file", "['legacy/vitest.config.mjs']", "directory", "legacy", "legacy/vitest.config.mjs"],
    ["directory", "['legacy']", "directory", "legacy", "legacy/vitest.config.mjs"],
    ["glob", "['legacy/*.config.mjs']", "directory", "legacy", "legacy/vitest.config.mjs"],
    [
      "container",
      "['vitest.container.config.mjs']",
      "container (directory)",
      "legacy",
      "legacy/vitest.config.mjs",
    ],
    ["self", "['vitest.config.mjs']", "parent", "", "vitest.config.mjs"],
    ["inline default", "[{test:{name:'inline'}}]", "inline", "", "vitest.config.mjs"],
    ["inline true", "[{extends:true,test:{name:'inline'}}]", "inline", "", "vitest.config.mjs"],
    [
      "inline false",
      "[{extends:false,root:'override',test:{name:'inline'}}]",
      "inline",
      "override",
      undefined,
    ],
    [
      "inline file",
      "[{extends:'legacy/vitest.config.mjs',test:{name:'inline'}}]",
      "inline",
      "",
      "legacy/vitest.config.mjs",
    ],
  ] as const)(
    "preserves existing %s project resolution",
    async (kind, input, name, relativeRoot, config) => {
      const { root, resolve } = fixture();
      const projects = await resolve(input!);
      expect(projects).toHaveLength(1);
      expect(projects[0]).toMatchObject({
        name,
        root: path.join(root, relativeRoot!),
        config: config ? path.join(root, config) : undefined,
      });
      if (kind === "inline default" || kind === "inline true") {
        expect(projects[0]!.env.PARENT).toBe("yes");
      }
      if (kind === "inline file") {
        expect(projects[0]!.env.LEAF).toBe("yes");
      }
    },
  );

  it.each([
    ["missing file", "[{configFile:'missing.mjs'}]", /non-existing config file/],
    ["directory", "[{configFile:'legacy'}]", /non-existing config file/],
    ["non-string file", "[{configFile:false}]", /accepts only a string configFile/],
    [
      "non-string prefix",
      "[{configFile:'configs/arbitrary.mjs',namePrefix:1}]",
      /accepts only a string configFile/,
    ],
    [
      "non-string root",
      "[{configFile:'configs/arbitrary.mjs',root:1}]",
      /accepts only a string configFile/,
    ],
    [
      "mixed options",
      "[{configFile:'configs/arbitrary.mjs',test:{name:'injected'}}]",
      /Use extends for inline project options/,
    ],
    [
      "factory descriptor",
      "[()=>({configFile:'configs/arbitrary.mjs',root:'.'})]",
      /must be direct objects/,
    ],
    [
      "promised descriptor",
      "[Promise.resolve({configFile:'configs/arbitrary.mjs',root:'.'})]",
      /must be direct objects/,
    ],
    ["null", "[null]", /Cannot use 'in' operator/],
    ["string discovery filename", "['configs/arbitrary.mjs']", /must start with/],
    ["glob discovery filename", "['configs/*.mjs']", /projects glob matched a file/],
    ["container cycle", "['vitest.a.config.mjs']", /circular "projects" definition/],
  ] as const)("rejects %s visibly and closes native initialization", async (_, input, error) => {
    const { resolve } = fixture();
    await expect(resolve(input)).rejects.toThrow(error);
    // A fresh initialization in the same owner root must still close normally.
    expect(await resolve("[{configFile:'configs/arbitrary.mjs'}]")).toHaveLength(1);
  });

  it("keeps explicit descriptors in the no-project diagnostic", async () => {
    const { resolve } = fixture();
    await expect(resolve("[{configFile:'configs/arbitrary.mjs'}]", ["absent"])).rejects.toThrow(
      /No projects were found[\s\S]*"configFile": "configs\/arbitrary.mjs"/,
    );
  });

  it("types file descriptors as direct entries rather than inline exports", () => {
    expectTypeOf<{
      configFile: string;
      root: string;
      namePrefix: string;
    }>().toMatchTypeOf<TestProjectConfiguration>();
    expectTypeOf<
      () => { configFile: string; root: string }
    >().not.toMatchTypeOf<UserProjectConfigFn>();
    expectTypeOf<Promise<{ configFile: string; root: string }>>().not.toMatchTypeOf<
      Promise<UserWorkspaceConfig>
    >();
  });
});
