import { createHash } from "node:crypto";
import { accessSync, constants, createReadStream, existsSync, statSync } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const FFF_VERSION = "0.10.6";
const DOWNLOAD_TIMEOUT_MS = 60_000;

export type BinaryAsset = { filename: string; sha256: string; size: number };

// Raw executables and digests from the upstream v0.10.6 release. Linux follows
// upstream's installer: static musl builds work without probing the host libc.
const assets: Record<string, BinaryAsset> = {
  "darwin-arm64": {
    filename: "fff-mcp-aarch64-apple-darwin",
    sha256: "02e0f57f5b88fa698494f310d8005a0c34d5bda5a1fcd069520b35f8e2319892",
    size: 11507984,
  },
  "darwin-x64": {
    filename: "fff-mcp-x86_64-apple-darwin",
    sha256: "12f374554f1930434cacee8221d9a76afd9e4dde0d9112c3bbc3ea59d5b56e83",
    size: 14412272,
  },
  "linux-arm64": {
    filename: "fff-mcp-aarch64-unknown-linux-musl",
    sha256: "028b9e388716a8c0c39de3f153dd8e14e5ee998ffa70d4951f1cd2a3fc42f6ce",
    size: 10802000,
  },
  "linux-x64": {
    filename: "fff-mcp-x86_64-unknown-linux-musl",
    sha256: "a44ef64015f1754aa63b690c24d9a748ed16298f05350da7b09554c4c98dfb0f",
    size: 13929864,
  },
  "win32-arm64": {
    filename: "fff-mcp-aarch64-pc-windows-msvc.exe",
    sha256: "9151f6efc9d5aa9e38aafb7fb2c664700fa950374717305ad41a09a54cfe873e",
    size: 12215808,
  },
  "win32-x64": {
    filename: "fff-mcp-x86_64-pc-windows-msvc.exe",
    sha256: "460e0614f4e8d6b6b618ec9b4bc5eeb58d70601d8b62c7947cc66435a182f946",
    size: 15380480,
  },
};

export function binaryAsset(platform: NodeJS.Platform, arch: string): BinaryAsset {
  const asset = assets[`${platform}-${arch}`];
  if (asset) return asset;
  throw new Error(
    `Automatic FFF installation is not supported on ${platform}/${arch}. Install fff-mcp on PATH for this platform.`,
  );
}

async function verifyCachedBinary(
  file: string,
  asset: BinaryAsset,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  const failure = `FFF cache verification failed at ${file}. Remove this cached file and retry the search.`;
  if (!stat.isFile() || stat.size !== asset.size) throw new Error(failure);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  signal.throwIfAborted();
  if (hash.digest("hex") !== asset.sha256) throw new Error(failure);
  try {
    await access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch (error) {
    throw new Error(failure, { cause: error });
  }
  return true;
}

export async function ensureBundledBinary(
  asset: BinaryAsset,
  cacheDirectory: string,
  signal: AbortSignal,
): Promise<string> {
  const destination = path.join(cacheDirectory, asset.filename);
  if (await verifyCachedBinary(destination, asset, signal)) return destination;
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  signal.throwIfAborted();
  const temporaryDirectory = await mkdtemp(path.join(cacheDirectory, ".install-"));
  const temporaryFile = path.join(temporaryDirectory, asset.filename);
  const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
  let response: Response | undefined;
  try {
    const url = `https://github.com/dmtrKovalenko/fff/releases/download/v${FFF_VERSION}/${asset.filename}`;
    response = await fetch(url, { signal: downloadSignal });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} downloading ${url}`);
    }
    const declaredSize = response.headers.get("content-length");
    if (declaredSize !== null && Number(declaredSize) > asset.size) {
      throw new Error(`Download exceeds the pinned ${asset.size}-byte limit for ${asset.filename}`);
    }
    const file = await open(temporaryFile, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of response.body) {
        downloadSignal.throwIfAborted();
        size += chunk.byteLength;
        if (size > asset.size) {
          throw new Error(
            `Download exceeds the pinned ${asset.size}-byte limit for ${asset.filename}`,
          );
        }
        hash.update(chunk);
        await file.writeFile(chunk);
      }
    } finally {
      await file.close();
    }
    downloadSignal.throwIfAborted();
    if (size !== asset.size || hash.digest("hex") !== asset.sha256) {
      throw new Error(`SHA-256 or byte count mismatch for ${asset.filename}; refusing to install`);
    }
    await chmod(temporaryFile, 0o755);
    downloadSignal.throwIfAborted();
    try {
      await rename(temporaryFile, destination);
    } catch (error) {
      // Windows may refuse replacement when another session has already installed
      // or started this executable. Accept only a fully verified winner.
      if (!(await verifyCachedBinary(destination, asset, signal))) throw error;
    }
    return destination;
  } catch (error) {
    signal.throwIfAborted();
    if (downloadSignal.aborted) {
      throw new Error(
        `FFF v${FFF_VERSION} download exceeded the 60-second limit. Retry the search or install fff-mcp on PATH.`,
        { cause: error },
      );
    }
    throw new Error(
      `Could not install FFF v${FFF_VERSION}: ${error instanceof Error ? error.message : String(error)}. Retry the search or install fff-mcp on PATH.`,
      { cause: error },
    );
  } finally {
    await response?.body?.cancel().catch(() => {});
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function executableNames(): string[] {
  return process.platform === "win32" ? ["fff-mcp.exe"] : ["fff-mcp"];
}

function pathCandidates(): string[] {
  const entries = process.env.PATH?.split(path.delimiter).filter(Boolean) ?? [];
  return entries.flatMap((entry) => executableNames().map((name) => path.join(entry, name)));
}

function installCandidates(): string[] {
  const home = os.homedir();
  const local = path.join(home, ".local", "bin", "fff-mcp");
  if (process.platform === "darwin") {
    return [
      local,
      path.join(home, ".cargo", "bin", "fff-mcp"),
      "/opt/homebrew/bin/fff-mcp",
      "/usr/local/bin/fff-mcp",
    ];
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    return [
      ...(localAppData ? [path.join(localAppData, "fff", "fff-mcp.exe")] : []),
      "C:\\Program Files\\fff\\fff-mcp.exe",
    ];
  }
  return [local, path.join(home, ".cargo", "bin", "fff-mcp"), "/usr/local/bin/fff-mcp"];
}

function isExecutable(candidate: string): boolean {
  if (!existsSync(candidate)) return false;
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveFffBinary(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  for (const candidate of [...pathCandidates(), ...installCandidates()]) {
    if (isExecutable(candidate)) return path.resolve(candidate);
  }
  return ensureBundledBinary(
    binaryAsset(process.platform, process.arch),
    path.join(os.homedir(), ".cache", "omp-fff", FFF_VERSION),
    signal,
  );
}
