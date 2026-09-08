import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { binaryAsset, ensureBundledBinary, type BinaryAsset } from "../src/binary.ts";

const fixture = Buffer.from("fixture bytes for a verified FFF download", "utf8");
const fixtureAsset: BinaryAsset = {
  filename: "fff-mcp-fixture",
  sha256: createHash("sha256").update(fixture).digest("hex"),
  size: fixture.byteLength,
};
const downloadBaseUrl = "https://github.com/dmtrKovalenko/fff/releases/download/v0.10.6/";

async function inTemporaryDirectory<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omp-fff-binary-test-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertNothingInstalled(cacheDirectory: string, asset = fixtureAsset): Promise<void> {
  assert.deepEqual(await readdir(cacheDirectory), []);
  await assert.rejects(readFile(path.join(cacheDirectory, asset.filename)));
}

function responseWithChunks(chunks: readonly Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
}

function mockFetch(context: TestContext, implementation: typeof fetch): void {
  context.mock.method(globalThis, "fetch", implementation);
}

test("maps supported platforms to the six pinned upstream binaries", () => {
  const expected = [
    [
      "darwin",
      "arm64",
      "fff-mcp-aarch64-apple-darwin",
      "02e0f57f5b88fa698494f310d8005a0c34d5bda5a1fcd069520b35f8e2319892",
      11507984,
    ],
    [
      "darwin",
      "x64",
      "fff-mcp-x86_64-apple-darwin",
      "12f374554f1930434cacee8221d9a76afd9e4dde0d9112c3bbc3ea59d5b56e83",
      14412272,
    ],
    [
      "linux",
      "arm64",
      "fff-mcp-aarch64-unknown-linux-musl",
      "028b9e388716a8c0c39de3f153dd8e14e5ee998ffa70d4951f1cd2a3fc42f6ce",
      10802000,
    ],
    [
      "linux",
      "x64",
      "fff-mcp-x86_64-unknown-linux-musl",
      "a44ef64015f1754aa63b690c24d9a748ed16298f05350da7b09554c4c98dfb0f",
      13929864,
    ],
    [
      "win32",
      "arm64",
      "fff-mcp-aarch64-pc-windows-msvc.exe",
      "9151f6efc9d5aa9e38aafb7fb2c664700fa950374717305ad41a09a54cfe873e",
      12215808,
    ],
    [
      "win32",
      "x64",
      "fff-mcp-x86_64-pc-windows-msvc.exe",
      "460e0614f4e8d6b6b618ec9b4bc5eeb58d70601d8b62c7947cc66435a182f946",
      15380480,
    ],
  ] as const;

  for (const [platform, arch, filename, sha256, size] of expected) {
    assert.deepEqual(binaryAsset(platform, arch), { filename, sha256, size });
  }
  assert.throws(() => binaryAsset("freebsd", "x64"), /not supported/i);
});

test("downloads, verifies, and publishes a POSIX-executable binary from the pinned URL", async (context) => {
  await inTemporaryDirectory(async (directory) => {
    const cacheDirectory = path.join(directory, "cache");
    let requestedUrl = "";
    mockFetch(context, async (input) => {
      requestedUrl = String(input);
      return responseWithChunks([fixture.subarray(0, 7), fixture.subarray(7)]);
    });

    const installed = await ensureBundledBinary(
      fixtureAsset,
      cacheDirectory,
      new AbortController().signal,
    );

    assert.equal(installed, path.join(cacheDirectory, fixtureAsset.filename));
    assert.equal(requestedUrl, `${downloadBaseUrl}${fixtureAsset.filename}`);
    assert.deepEqual(await readFile(installed), fixture);
    if (process.platform !== "win32") await access(installed, constants.X_OK);
  });
});

test("reuses a verified cached binary without a network request", async (context) => {
  await inTemporaryDirectory(async (directory) => {
    const cacheDirectory = path.join(directory, "cache");
    const cached = path.join(cacheDirectory, fixtureAsset.filename);
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(cached, fixture, { mode: 0o700 });
    if (process.platform !== "win32") await chmod(cached, 0o700);
    mockFetch(context, async () => {
      throw new Error("a valid cache must be offline-capable");
    });

    assert.equal(
      await ensureBundledBinary(fixtureAsset, cacheDirectory, new AbortController().signal),
      cached,
    );
  });
});

test("rejects a corrupt cache without fetching or overwriting it", async (context) => {
  await inTemporaryDirectory(async (directory) => {
    const cacheDirectory = path.join(directory, "cache");
    const cached = path.join(cacheDirectory, fixtureAsset.filename);
    const corrupt = Buffer.from("corrupt cached binary", "utf8");
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(cached, corrupt, { mode: 0o700 });
    if (process.platform !== "win32") await chmod(cached, 0o700);
    let fetches = 0;
    mockFetch(context, async () => {
      fetches += 1;
      return new Response(fixture);
    });

    await assert.rejects(
      ensureBundledBinary(fixtureAsset, cacheDirectory, new AbortController().signal),
      /cache verification failed.*remove/i,
    );
    assert.equal(fetches, 0);
    assert.deepEqual(await readFile(cached), corrupt);
    assert.deepEqual(await readdir(cacheDirectory), [fixtureAsset.filename]);
  });
});

test("refuses bad hashes, wrong byte counts, and streaming overflows without publishing", async (context) => {
  await inTemporaryDirectory(async (directory) => {
    const cases: Array<{ name: string; asset: BinaryAsset; response: () => Response }> = [
      {
        name: "hash mismatch",
        asset: { ...fixtureAsset, sha256: "0".repeat(64) },
        response: () => new Response(fixture),
      },
      {
        name: "short response",
        asset: { ...fixtureAsset, size: fixture.byteLength + 1 },
        response: () => new Response(fixture),
      },
      {
        name: "streaming overflow",
        asset: fixtureAsset,
        response: () => responseWithChunks([fixture, Buffer.from("!", "utf8")]),
      },
    ];
    let call = 0;
    mockFetch(context, async () => cases[call++]!.response());

    for (const scenario of cases) {
      const cacheDirectory = path.join(directory, scenario.name);
      await mkdir(cacheDirectory, { recursive: true });
      await assert.rejects(
        ensureBundledBinary(scenario.asset, cacheDirectory, new AbortController().signal),
      );
      await assertNothingInstalled(cacheDirectory, scenario.asset);
    }
  });
});

test("cleans failed HTTP downloads and caller-aborted streams without publishing", async (context) => {
  await inTemporaryDirectory(async (directory) => {
    const httpCacheDirectory = path.join(directory, "http");
    const abortCacheDirectory = path.join(directory, "abort");
    await Promise.all([
      mkdir(httpCacheDirectory, { recursive: true }),
      mkdir(abortCacheDirectory, { recursive: true }),
    ]);
    let serveHttpFailure = true;
    let resolveStreamStarted!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      resolveStreamStarted = resolve;
    });
    mockFetch(context, async (_input, init) => {
      if (serveHttpFailure) return new Response("unavailable", { status: 503 });
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (signal) {
              signal.addEventListener("abort", () => controller.error(signal.reason), {
                once: true,
              });
            }
            resolveStreamStarted();
          },
        }),
      );
    });

    await assert.rejects(
      ensureBundledBinary(fixtureAsset, httpCacheDirectory, new AbortController().signal),
      /HTTP 503/i,
    );
    await assertNothingInstalled(httpCacheDirectory);

    serveHttpFailure = false;
    const abortController = new AbortController();
    const installing = ensureBundledBinary(
      fixtureAsset,
      abortCacheDirectory,
      abortController.signal,
    );
    await streamStarted;
    const cancellation = new Error("caller cancelled download");
    abortController.abort(cancellation);
    await assert.rejects(installing, (error: unknown) => error === cancellation);
    await assertNothingInstalled(abortCacheDirectory);
  });
});

test("concurrent installs converge on one verified binary", async (context) => {
  await inTemporaryDirectory(async (directory) => {
    const cacheDirectory = path.join(directory, "cache");
    let fetches = 0;
    mockFetch(context, async () => {
      fetches += 1;
      return responseWithChunks([fixture]);
    });

    const [first, second] = await Promise.all([
      ensureBundledBinary(fixtureAsset, cacheDirectory, new AbortController().signal),
      ensureBundledBinary(fixtureAsset, cacheDirectory, new AbortController().signal),
    ]);

    assert.equal(first, path.join(cacheDirectory, fixtureAsset.filename));
    assert.equal(second, first);
    assert.ok(fetches >= 1);
    assert.deepEqual(await readFile(first), fixture);
    assert.deepEqual(await readdir(cacheDirectory), [fixtureAsset.filename]);
  });
});

test("keeps a relative PATH executable bound to the host cwd when searching another root", async () => {
  await inTemporaryDirectory(async (directory) => {
    const otherRoot = path.join(directory, "other-repository");
    const filename = process.platform === "win32" ? "fff-mcp.exe" : "fff-mcp";
    const trusted = path.join(directory, "bin", filename);
    await mkdir(path.dirname(trusted), { recursive: true });
    await mkdir(path.join(otherRoot, "bin"), { recursive: true });
    await writeFile(trusted, "#!/bin/sh\nprintf trusted", { mode: 0o755 });
    await writeFile(path.join(otherRoot, "bin", filename), "#!/bin/sh\nprintf wrong", {
      mode: 0o755,
    });
    const program = `import { resolveFffBinary } from ${JSON.stringify(new URL("../src/binary.ts", import.meta.url).href)}; console.log(await resolveFffBinary(new AbortController().signal));`;
    const resolved = execFileSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", program],
      {
        cwd: directory,
        env: { ...process.env, PATH: "bin" },
        encoding: "utf8",
      },
    ).trim();
    assert(path.isAbsolute(resolved));
    assert.equal(await realpath(resolved), await realpath(trusted));
    if (process.platform !== "win32") {
      assert.equal(execFileSync(resolved, [], { cwd: otherRoot, encoding: "utf8" }), "trusted");
    }
  });
});
