import { isBuiltin } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundlePlugin } from "@forebay/host";
import type { Provider } from "@forebay/host";
import type { Plugin } from "@weivel/typescript";
import { MANIFEST_DEFAULTS } from "./world.js";

const REPOSITORY = join(import.meta.dirname, "..");

let out: string;

beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "claude-code-provider-bundle-"));
});

afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

describe("the catalog item", () => {
  it("bundles into the entry its manifest names, importing nothing but Node's builtins", async () => {
    const bundled = await bundlePlugin(REPOSITORY, out);
    expect(bundled.id).toBe("claude-code-provider");
    expect(Object.keys(bundled.files).sort()).toEqual(["dist/plugin.js", "plugin.json"]);
    const manifest = JSON.parse(readFileSync(join(out, "plugin.json"), "utf8"));
    expect(manifest.capabilities).toEqual(["provider"]);
    const imports = [...readFileSync(join(out, "dist", "plugin.js"), "utf8").matchAll(/^import .* from "([^"]+)"/gm)].map((match) => match[1] as string);
    expect(imports.filter((specifier) => !isBuiltin(specifier))).toEqual([]);
  });

  it("runs from the bundle alone and offers no models before an account exists", async () => {
    await bundlePlugin(REPOSITORY, out);
    writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
    const loaded = (await import(pathToFileURL(join(out, "dist", "plugin.js")).href)) as { default: Plugin };
    let provider: Provider | undefined;
    await loaded.default.activate({
      capability: (id: string) => ({ id }),
      service: (id: string) => ({ id }),
      config: { get: (key: string) => MANIFEST_DEFAULTS[key], all: () => MANIFEST_DEFAULTS },
      paths: { plugin: out },
      host: { api: 1, app: "the-loader", surfaces: [] },
      manifest: JSON.parse(readFileSync(join(out, "plugin.json"), "utf8")),
      provide: (_type: unknown, implementation: Provider) => {
        provider = implementation;
      },
      services: { get: () => ({ list: () => ({ accounts: [] }) }), register: () => {} },
    } as never);
    expect(await provider?.models()).toEqual({ models: [] });
  });
});
