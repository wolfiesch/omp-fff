import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FffController } from "../src/controller.ts";

const execFileAsync = promisify(execFile);
const successfulResult: CallToolResult = { content: [{ type: "text", text: "ok" }] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function inTemporaryDirectory<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omp-fff-test-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("is lazy until the first search", () => {
  let starts = 0;
  const controller = new FffController({
    sessionFactory: async () => {
      starts += 1;
      return {
        call: async () => successfulResult,
        close: async () => {},
      };
    },
    resolveRoot: async () => "/repo",
  });

  assert.equal(starts, 0);
  assert.equal(controller.status(), "FFF is not connected");
});

test("rejects a directory outside a Git worktree before starting FFF", async () => {
  await inTemporaryDirectory(async (directory) => {
    let starts = 0;
    const controller = new FffController({
      sessionFactory: async () => {
        starts += 1;
        return {
          call: async () => successfulResult,
          close: async () => {},
        };
      },
    });

    await assert.rejects(
      controller.search("find_files", { query: "needle" }, directory),
      /FFF only searches Git worktrees/,
    );
    assert.equal(starts, 0);
  });
});

test("reuses a root, closes before switching roots, and serializes queued calls", async () => {
  const events: string[] = [];
  const firstCallStarted = deferred<void>();
  const releaseFirstCall = deferred<void>();
  let factoryCount = 0;
  const controller = new FffController({
    resolveRoot: async (directory) => directory,
    sessionFactory: async (root) => {
      factoryCount += 1;
      events.push(`start:${root}`);
      return {
        call: async () => {
          events.push(`call:${root}`);
          if (root === "root-a" && events.filter((event) => event === "call:root-a").length === 1) {
            firstCallStarted.resolve();
            await releaseFirstCall.promise;
          }
          return successfulResult;
        },
        close: async () => {
          events.push(`close:${root}`);
        },
      };
    },
  });

  const first = controller.search("find_files", { query: "one" }, "root-a");
  await firstCallStarted.promise;
  const second = controller.search("grep", { query: "two" }, "root-b");
  releaseFirstCall.resolve();
  await Promise.all([first, second]);
  await controller.search("multi_grep", { queries: ["three"] }, "root-b");

  assert.equal(factoryCount, 2);
  assert.deepEqual(events, [
    "start:root-a",
    "call:root-a",
    "close:root-a",
    "start:root-b",
    "call:root-b",
    "call:root-b",
  ]);
});

test("closes a broken session and surfaces the request failure", async () => {
  let closes = 0;
  const controller = new FffController({
    resolveRoot: async () => "/repo",
    sessionFactory: async () => ({
      call: async () => {
        throw new Error("server connection lost");
      },
      close: async () => {
        closes += 1;
      },
    }),
  });

  await assert.rejects(
    controller.search("grep", { query: "needle" }, "/repo"),
    /server connection lost/,
  );
  assert.equal(closes, 1);
  assert.equal(controller.status(), "FFF is not connected");
});

test("retains ownership when closing a live session fails", async () => {
  let starts = 0;
  let calls = 0;
  const controller = new FffController({
    resolveRoot: async (directory) => directory,
    sessionFactory: async () => {
      starts += 1;
      return {
        call: async () => {
          calls += 1;
          if (calls === 1) throw new Error("request failed");
          return successfulResult;
        },
        close: async () => {
          throw new Error("close failed");
        },
      };
    },
  });

  await assert.rejects(controller.search("grep", { query: "first" }, "root-a"), /request failed/);
  assert.equal(controller.status(), "FFF connected to root-a");
  await controller.search("grep", { query: "second" }, "root-a");
  await assert.rejects(controller.search("grep", { query: "switch" }, "root-b"), /close failed/);
  await assert.rejects(controller.stop(), /close failed/);
  await assert.rejects(controller.shutdown(), /close failed/);
  assert.equal(starts, 1);
  assert.equal(controller.status(), "FFF connected to root-a");
});

test("an aborted caller cannot launch work before or while queued", async () => {
  const releaseFirstCall = deferred<void>();
  const firstCallStarted = deferred<void>();
  const roots: string[] = [];
  const controller = new FffController({
    resolveRoot: async (directory) => directory,
    sessionFactory: async (root) => {
      roots.push(root);
      return {
        call: async () => {
          if (root === "root-a") {
            firstCallStarted.resolve();
            await releaseFirstCall.promise;
          }
          return successfulResult;
        },
        close: async () => {},
      };
    },
  });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(new Error("cancelled before start"));

  await assert.rejects(
    controller.search("find_files", { query: "never" }, "root-never", alreadyAborted.signal),
    /cancelled before start/,
  );
  assert.deepEqual(roots, []);

  const first = controller.search("find_files", { query: "first" }, "root-a");
  await firstCallStarted.promise;
  const queuedAbort = new AbortController();
  const queued = controller.search("find_files", { query: "queued" }, "root-b", queuedAbort.signal);
  queuedAbort.abort(new Error("cancelled while queued"));
  releaseFirstCall.resolve();
  await first;
  await assert.rejects(queued, /cancelled while queued/);
  assert.deepEqual(roots, ["root-a"]);
});

test("shutdown fences queued requests while stop leaves the controller reusable", async () => {
  const firstCallStarted = deferred<void>();
  const releaseFirstCall = deferred<void>();
  let starts = 0;
  let closes = 0;
  const controller = new FffController({
    resolveRoot: async (directory) => directory,
    sessionFactory: async () => {
      starts += 1;
      return {
        call: async () => {
          if (starts === 1) {
            firstCallStarted.resolve();
            await releaseFirstCall.promise;
          }
          return successfulResult;
        },
        close: async () => {
          closes += 1;
        },
      };
    },
  });

  const first = controller.search("find_files", { query: "first" }, "root-a");
  await firstCallStarted.promise;
  const queued = controller.search("find_files", { query: "queued" }, "root-b");
  const shuttingDown = controller.shutdown();
  releaseFirstCall.resolve();
  await first;
  await assert.rejects(queued, /shut down/);
  await shuttingDown;
  assert.equal(starts, 1);
  assert.equal(closes, 1);
  await assert.rejects(controller.search("find_files", { query: "after" }, "root-c"), /shut down/);

  let reusableStarts = 0;
  const reusable = new FffController({
    resolveRoot: async () => "/repo",
    sessionFactory: async () => {
      reusableStarts += 1;
      return {
        call: async () => successfulResult,
        close: async () => {},
      };
    },
  });
  await reusable.search("find_files", { query: "before stop" }, "/repo");
  assert.equal(await reusable.stop(), true);
  await reusable.search("find_files", { query: "after stop" }, "/repo");
  assert.equal(reusableStarts, 2);
});

test("canonicalizes Git roots with hostile path characters and symlink aliases", async () => {
  await inTemporaryDirectory(async (directory) => {
    const repository = path.join(directory, "repo with 'quotes' and spaces");
    const symlinkedRepository = path.join(directory, "linked repository");
    await mkdir(repository);
    await execFileAsync("git", ["init", "--quiet", repository]);
    await symlink(repository, symlinkedRepository, "dir");
    const roots: string[] = [];
    const controller = new FffController({
      sessionFactory: async (root) => {
        roots.push(root);
        return {
          call: async () => successfulResult,
          close: async () => {},
        };
      },
    });

    const canonicalRoot = await realpath(repository);
    const search = await controller.search("find_files", { query: "needle" }, repository);
    const linkedSearch = await controller.search(
      "find_files",
      { query: "needle" },
      symlinkedRepository,
    );
    assert.equal(search.root, canonicalRoot);
    assert.equal(linkedSearch.root, canonicalRoot);
    assert.deepEqual(roots, [canonicalRoot]);
  });
});

test("ignores Git environment overrides that could target home or filesystem root", async () => {
  await inTemporaryDirectory(async (directory) => {
    const repository = path.join(directory, "repository");
    await mkdir(repository);
    await execFileAsync("git", ["init", "--quiet", repository]);
    const homeAlias = path.join(directory, "home alias");
    await symlink(os.homedir(), homeAlias, "dir");
    const originalGitDir = process.env.GIT_DIR;
    const originalGitWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = path.join(repository, ".git");
    process.env.GIT_WORK_TREE = os.homedir();
    try {
      let starts = 0;
      const controller = new FffController({
        sessionFactory: async () => {
          starts += 1;
          return {
            call: async () => successfulResult,
            close: async () => {},
          };
        },
      });
      await assert.rejects(
        controller.search("find_files", { query: "needle" }, os.homedir()),
        /FFF only searches Git worktrees|FFF refuses to search/,
      );
      await assert.rejects(
        controller.search("find_files", { query: "needle" }, path.parse(process.cwd()).root),
        /FFF only searches Git worktrees|FFF refuses to search/,
      );
      assert.equal(starts, 0);
      await assert.rejects(
        controller.search("find_files", { query: "needle" }, homeAlias),
        /FFF only searches Git worktrees|FFF refuses to search/,
      );
      assert.equal(starts, 0);
    } finally {
      if (originalGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = originalGitDir;
      if (originalGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = originalGitWorkTree;
    }
  });
});
