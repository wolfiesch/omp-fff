import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import extension, { type ExtensionHost, type SearchTool, type Context } from "../index.ts";

export async function runSmoke(
  load: (host: ExtensionHost) => void | Promise<void> = extension,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "omp-fff-smoke-"));
  const first = path.join(root, "repo 'quoted' $dollar;literal");
  const second = path.join(root, "second");
  const registered = new Map<string, SearchTool>();
  const commands = new Map<string, Parameters<ExtensionHost["registerCommand"]>[1]>();
  let shutdown: (() => Promise<void>) | undefined;
  const notices: string[] = [];
  const ctx: Context = { cwd: root, ui: { notify: (message) => notices.push(message) } };
  const invoke = (name: string, input: Record<string, unknown>, signal?: AbortSignal) =>
    registered.get(name)!.execute("smoke", input, signal, undefined, ctx);
  try {
    for (const directory of [first, second]) {
      await mkdir(path.join(directory, "src"), { recursive: true });
      execFileSync("git", ["-C", directory, "init", "--quiet"]);
    }
    await writeFile(
      path.join(first, "src/profile-controller.ts"),
      "export const FFF_FIRST_TOKEN = true;\n",
    );
    await writeFile(path.join(first, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(first, "ignored.txt"), "FFF_IGNORED_TOKEN\n");
    await writeFile(path.join(second, "src/other.ts"), "export const FFF_SECOND_TOKEN = true;\n");
    await load({
      registerTool: (tool) => {
        registered.set(tool.name, tool);
      },
      registerCommand: (name, command) => {
        commands.set(name, command);
      },
      on: (_event, handler) => {
        shutdown = handler;
      },
    });
    assert.deepEqual(
      [...registered.keys()].sort(),
      ["fff_find", "fff_grep", "fff_multi_grep"].sort(),
    );
    await commands.get("fff")!.handler("status", ctx);
    assert.match(notices.pop()!, /not connected/);
    await assert.rejects(invoke("fff_find", { query: "profile" }), /Git|worktree|repository/i);
    await assert.rejects(
      invoke("fff_find", { query: "profile", repo: first }, AbortSignal.abort()),
      /abort/i,
    );
    const found = await invoke("fff_find", { query: "profle", repo: first });
    assert.match(JSON.stringify(found.content), /profile-controller\.ts/);
    const content = await invoke("fff_grep", { query: "FFF_FIRST_TOKEN", repo: first });
    assert.match(JSON.stringify(content.content), /export const FFF_FIRST_TOKEN/);
    const ignored = await invoke("fff_multi_grep", {
      patterns: ["FFF_IGNORED_TOKEN"],
      repo: first,
    });
    assert.match(JSON.stringify(ignored.content), /0 matches/);
    const [a, b] = await Promise.all([
      invoke("fff_multi_grep", { patterns: ["FFF_FIRST_TOKEN"], repo: first }),
      invoke("fff_multi_grep", { patterns: ["FFF_SECOND_TOKEN"], repo: second }),
    ]);
    assert.match(JSON.stringify(a.content), /FFF_FIRST_TOKEN/);
    assert.doesNotMatch(JSON.stringify(a.content), /FFF_SECOND_TOKEN/);
    assert.match(JSON.stringify(b.content), /FFF_SECOND_TOKEN/);
    assert.doesNotMatch(JSON.stringify(b.content), /FFF_FIRST_TOKEN/);
    await writeFile(path.join(second, "src/other.ts"), "export const FFF_WATCHED_TOKEN = true;\n");
    let changed = false;
    const deadline = Date.now() + 10000;
    do {
      const result = await invoke("fff_multi_grep", {
        patterns: ["FFF_WATCHED_TOKEN"],
        repo: second,
      });
      if (JSON.stringify(result.content).includes("export const FFF_WATCHED_TOKEN")) {
        changed = true;
        break;
      }
      await delay(100);
    } while (Date.now() < deadline);
    assert(changed, "Watcher did not observe file edit within 10 seconds");
    await assert.rejects(invoke("fff_grep", { repo: second }));
    await commands.get("fff")!.handler("stop", ctx);
    await commands.get("fff")!.handler("status", ctx);
    assert.match(notices.pop()!, /not connected/);
    await invoke("fff_find", { query: "profile", repo: first });
    await shutdown!();
    await assert.rejects(
      invoke("fff_find", { query: "profile", repo: first }),
      /shut.?down|closed|disposed/i,
    );
    console.log(
      "PASS: lazy startup, scratch refusal, cancellation, fuzzy search, content search, ignores, cross-repository concurrency, watcher, errors, stop/reconnect, shutdown",
    );
  } finally {
    await shutdown?.();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runSmoke();
}
