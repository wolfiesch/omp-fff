import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const execFileAsync = promisify(execFile);
const CONNECT_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 5_000;

export type SearchToolName = "find_files" | "grep" | "multi_grep";

type FffSession = {
  call(
    tool: SearchToolName,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
};

type FffControllerOptions = {
  sessionFactory?: (root: string, signal: AbortSignal) => Promise<FffSession>;
  resolveRoot?: (directory: string, signal: AbortSignal) => Promise<string>;
};

type ActiveSession = {
  root: string;
  session: FffSession;
};

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("FFF request aborted");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function timeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
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

function resolveFffBinary(): string {
  for (const candidate of [...pathCandidates(), ...installCandidates()]) {
    if (isExecutable(candidate)) return candidate;
  }
  throw new Error(
    "fff-mcp is not installed or is not on PATH. Install fff, then make the fff-mcp executable available on PATH.",
  );
}

function withoutGitOverrides(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
}

async function resolveGitWorktreeRoot(directory: string, signal: AbortSignal): Promise<string> {
  const explicitDirectory = path.resolve(directory);
  throwIfAborted(signal);
  try {
    const canonicalDirectory = await realpath(explicitDirectory);
    const { stdout } = await execFileAsync(
      "git",
      ["-C", canonicalDirectory, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        env: withoutGitOverrides(),
        signal,
        timeout: GIT_TIMEOUT_MS,
      },
    );
    throwIfAborted(signal);
    const root = path.resolve(stdout.replace(/[\r\n]+$/, ""));
    const [canonicalRoot, home] = await Promise.all([realpath(root), realpath(os.homedir())]);
    if (canonicalRoot === path.parse(canonicalRoot).root || canonicalRoot === home) {
      throw new Error(
        `FFF refuses to search ${canonicalRoot === home ? "the home directory" : "the filesystem root"}.`,
      );
    }
    return canonicalRoot;
  } catch (error) {
    if (signal.aborted) throw abortError(signal);
    if (error instanceof Error && error.message.startsWith("FFF refuses to search")) throw error;
    throw new Error(`FFF only searches Git worktrees; ${explicitDirectory} is not inside one.`);
  }
}

async function createSdkSession(root: string, signal: AbortSignal): Promise<FffSession> {
  throwIfAborted(signal);
  const transport = new StdioClientTransport({
    command: resolveFffBinary(),
    args: ["--no-update-check", "--enable-home-scan=false", "--enable-root-scan=false", root],
    cwd: root,
    stderr: "ignore",
  });
  const client = new Client({ name: "omp-fff", version: "0.1.0" });
  try {
    await client.connect(transport, {
      signal,
      timeout: CONNECT_TIMEOUT_MS,
      maxTotalTimeout: CONNECT_TIMEOUT_MS,
    });
    throwIfAborted(signal);
  } catch (error) {
    try {
      await client.close();
    } catch {
      // The failed initialization remains the observable error.
    }
    throw error;
  }
  return {
    call: async (tool, input, requestSignal) => {
      const result = await client.callTool({ name: tool, arguments: input }, CallToolResultSchema, {
        signal: requestSignal,
        timeout: SEARCH_TIMEOUT_MS,
        maxTotalTimeout: SEARCH_TIMEOUT_MS,
      });
      return result as CallToolResult;
    },
    close: () => client.close(),
  };
}

/** Owns at most one FFF process and serializes every root transition and request. */
export class FffController {
  readonly #sessionFactory: (root: string, signal: AbortSignal) => Promise<FffSession>;
  readonly #resolveRoot: (directory: string, signal: AbortSignal) => Promise<string>;
  #active: ActiveSession | undefined;
  #tail: Promise<void> = Promise.resolve();
  #shutDown = false;

  constructor(options: FffControllerOptions = {}) {
    this.#sessionFactory = options.sessionFactory ?? createSdkSession;
    this.#resolveRoot = options.resolveRoot ?? resolveGitWorktreeRoot;
  }

  search(
    tool: SearchToolName,
    input: Record<string, unknown>,
    directory: string,
    signal?: AbortSignal,
  ): Promise<{ root: string; result: CallToolResult }> {
    if (this.#shutDown) return Promise.reject(new Error("FFF controller has shut down."));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return this.#serialize(async () => {
      if (this.#shutDown) throw new Error("FFF controller has shut down.");
      if (signal?.aborted) throw abortError(signal);
      const requestSignal = timeoutSignal(signal, SEARCH_TIMEOUT_MS);
      throwIfAborted(requestSignal);
      const root = await this.#resolveRoot(directory, requestSignal);
      throwIfAborted(requestSignal);
      if (this.#shutDown) throw new Error("FFF controller has shut down.");
      const session = await this.#sessionFor(root, requestSignal);
      try {
        return { root, result: await session.call(tool, input, requestSignal) };
      } catch (error) {
        if (this.#active?.session === session) {
          try {
            await session.close();
            this.#active = undefined;
          } catch {
            // The failed request remains the observable error.
          }
        }
        throw error;
      }
    });
  }

  status(): string {
    return this.#active ? `FFF connected to ${this.#active.root}` : "FFF is not connected";
  }

  async stop(): Promise<boolean> {
    return this.#serialize(async () => {
      if (!this.#active) return false;
      const active = this.#active;
      await active.session.close();
      this.#active = undefined;
      return true;
    });
  }

  async shutdown(): Promise<void> {
    this.#shutDown = true;
    await this.#serialize(async () => {
      if (!this.#active) return;
      const active = this.#active;
      await active.session.close();
      this.#active = undefined;
    });
  }

  async #sessionFor(root: string, signal: AbortSignal): Promise<FffSession> {
    if (this.#active?.root === root) return this.#active.session;
    if (this.#active) {
      const active = this.#active;
      await active.session.close();
      this.#active = undefined;
    }
    throwIfAborted(signal);
    const session = await this.#sessionFactory(root, signal);
    if (this.#shutDown) {
      this.#active = { root, session };
      await session.close();
      this.#active = undefined;
      throw new Error("FFF controller has shut down.");
    }
    this.#active = { root, session };
    return session;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
