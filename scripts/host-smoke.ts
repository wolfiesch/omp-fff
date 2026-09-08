import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Context, ExtensionHost, SearchTool } from "../index.ts";
import { runSmoke } from "./smoke.ts";

type LoadedExtension = {
  tools: Map<string, { definition: SearchTool }>;
  commands: Map<string, Parameters<ExtensionHost["registerCommand"]>[1]>;
  handlers: Map<
    string,
    Array<
      (event: { type: "session_shutdown"; reason: "quit" }, ctx: Context) => Promise<void> | void
    >
  >;
};
interface Loader {
  loadExtensions(
    paths: string[],
    cwd: string,
  ): Promise<{ extensions: LoadedExtension[]; errors: unknown[] }>;
}

const loaderPath = process.argv[2];
if (!loaderPath)
  throw new Error("Usage: host-smoke.ts <host-extension-loader-file> [extension-entry]");
const entry = path.resolve(process.argv[3] ?? "index.ts");
// Explicit local host module: both tested loaders expose this structural contract.
const loader = (await import(pathToFileURL(path.resolve(loaderPath)).href)) as Loader;
assert.equal(typeof loader.loadExtensions, "function");
const cwd = await mkdtemp(path.join(os.tmpdir(), "omp-fff-host-"));
try {
  await runSmoke(async (host) => {
    const result = await loader.loadExtensions([entry], cwd);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    const extension = result.extensions[0];
    for (const { definition } of extension.tools.values()) host.registerTool(definition);
    for (const [name, command] of extension.commands) host.registerCommand(name, command);
    host.on("session_shutdown", async () => {
      for (const handler of extension.handlers.get("session_shutdown") ?? []) {
        await handler({ type: "session_shutdown", reason: "quit" }, { cwd, ui: { notify() {} } });
      }
    });
  });
} finally {
  await rm(cwd, { recursive: true, force: true });
}
