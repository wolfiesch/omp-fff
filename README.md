# omp-fff

Lazy, repository-scoped [FFF](https://github.com/dmtrKovalenko/fff) search for **Oh My Pi and Pi**.

[![Version](https://img.shields.io/github/package-json/v/wolfiesch/omp-fff)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![MCP](https://img.shields.io/badge/transport-local%20MCP-informational)](https://modelcontextprotocol.io/)

Add fuzzy file discovery and content search without replacing your agent's native search tools. FFF starts on the first search, indexes one Git worktree, and stops when the session closes. Opening an agent in a scratch directory does not start an index.

```text
Agent calls fff_find({ query: "profle" })

FFF root: <repository>
→ Read src/profile-controller.ts
src/profile-controller.ts
```

## Install

Requires Git and an installed OMP or Pi host. Install the extension with one command:

**Oh My Pi:**

```sh
omp plugin install github:wolfiesch/omp-fff
```

**Pi:**

```sh
pi install git:github.com/wolfiesch/omp-fff
```

Start a new session inside a Git repository and ask:

> Use FFF to find the authentication files in this repository.

No `mcp.json` entry is needed. Avoid registering a second standalone FFF server unless you intentionally want another index.

### Automatic FFF installation

On the first FFF search, the extension uses an existing `fff-mcp` from `PATH` or standard user/Homebrew installation directories. If none is available, it downloads the official **FFF 0.10.6** executable for your platform and verifies its pinned SHA-256 checksum and byte count before execution.

- **Platforms:** macOS, Linux, and Windows on ARM64 or x64. Linux uses upstream's static musl binaries.
- **Cache:** `~/.cache/omp-fff/0.10.6/`, shared by your sessions. Cached downloads are verified before reuse and work offline.
- **No installation scripts:** works when npm or Bun blocks lifecycle scripts. No Homebrew, shell commands, administrator access, or global `PATH` changes are needed.
- **Network:** the first uncached search requires access to GitHub release downloads. Loading the extension, checking status, and searches outside Git repositories never download a binary.
- **Failures:** a failed or cancelled download leaves no executable in the cache. Checksum failures stop installation. A corrupt existing cache is left untouched; the error names the cached file to remove before retrying.

For offline setup or unsupported platforms, install `fff-mcp` yourself using the [FFF installation guide](https://github.com/dmtrKovalenko/fff#mcp-server). Existing system binaries are neither replaced nor managed by this extension.

## Tools

| Tool | Use |
| --- | --- |
| `fff_find` | Fuzzy filename and path discovery. Start with one or two terms. |
| `fff_grep` | Content search with FFF's query syntax and fuzzy suggestions. |
| `fff_multi_grep` | Search for any of several literal patterns, using OR matching. |

All tools accept optional `repo`, `maxResults`, and `cursor` arguments. Content searches also accept `context` and `output_mode`; `fff_multi_grep` accepts `constraints`.

The default repository is the Git worktree containing the session's working directory. From a scratch session, supply an explicit directory:

```json
{
  "query": "profile",
  "repo": "../my-project"
}
```

Relative paths resolve against the session directory. Absolute paths also work. Every result reports the actual indexed root.

FFF may broaden a zero-match content query into fuzzy suggestions. **Use native grep when an exact match, exhaustive audit, or proof of absence matters.** Native `grep`, `glob`, and other host tools remain untouched.

## Lifecycle and controls

- **No eager indexing:** loading the extension and checking status do not launch FFF.
- **One process per agent session:** searches reuse the current repository's connection. A repository change closes the old connection before opening the new one.
- **Serialized requests:** simultaneous searches cannot accidentally use another request's repository.
- **Live updates:** FFF's normal filesystem watcher stays enabled.
- **Scoped roots:** non-Git directories, the home directory, and the filesystem root are refused. Symlink following is not enabled.
- **Visible failures:** connection and search failures are reported as tool errors. The failed search is not silently retried.
- **Local lifecycle:** session shutdown closes the child process. There is no shared daemon, shell hook, or background service installation.

Use `/fff` or `/fff status` to inspect the connection. `/fff stop` closes it; the next search can reconnect.

Binary downloads have a 60-second deadline. MCP connection and search operations each have a 30-second deadline; downloading does not consume the search deadline. Cancellation propagates through installation and MCP requests. FFF's startup update check is disabled. Automatic binaries stay pinned until an extension update changes the pin; system binaries remain under your package manager's control.

Repository scoping is a search boundary, not an OS sandbox. FFF receives filesystem access under the same user account as the agent.

## OMP and Pi compatibility

A single entrypoint uses the shared extension API and the official MCP TypeScript SDK. It has no runtime dependency on OMP internals, Pi internals, or Bun globals. It preserves the same tool names and `/fff` command across hosts.

Pi marks thrown failures as tool errors, so the adapter throws when the MCP server reports a failure rather than returning a host-specific error flag.

The package runs on Node.js 22+ or OMP's Bun runtime. Your host may require a newer Node version.

The same live-search smoke passed through each host's actual extension loader on macOS ARM64 with FFF 0.10.6:

| Host | Version tested | Runtime |
| --- | --- | --- |
| Oh My Pi | 18.1.2 | Bun 1.3.14 |
| Pi (`@earendil-works/pi-coding-agent`) | 0.85.1 | Node 26.8.1 |
| Legacy Pi (`@mariozechner/pi-coding-agent`) | 0.73.1 | Node 22.18.0 |

The adapter also passed its direct smoke under Node 22.18.0. Automatic binary setup and offline cache reuse passed through OMP and Pi with system FFF binaries blocked by the macOS sandbox.[^platforms]

[Linux x64 CI](https://github.com/wolfiesch/omp-fff/actions/workflows/ci.yml) verifies automatic binary download and the direct adapter's real-search smoke under Node 22 and Bun 1.3.14.

[^platforms]: Other host/platform combinations, including Windows, have not been runtime-tested.

### How this differs from upstream pi-fff

FFF also maintains [`@ff-labs/pi-fff`](https://github.com/dmtrKovalenko/fff#pi-extension), which integrates its native library and editor autocomplete with Pi.

`omp-fff` is an independent adapter for users who want the standalone MCP process, lazy repository activation, and the same interface in OMP and Pi. It does not implement FFF's search engine or change editor autocomplete.

## Development and verification

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run smoke
```

The smoke command requires Git. It uses an existing `fff-mcp` or automatically downloads the pinned binary on first use. It creates temporary repositories, exercises real searches and lifecycle behavior, then removes only its own fixtures. The verified binary cache is retained. It makes no model requests.

Unit tests cover binary verification, offline cache reuse, failed/cancelled downloads, concurrent installation, connection ownership, and lifecycle transitions. The live smoke covers fuzzy discovery, content search, ignored files, repository switching, concurrent calls, watcher updates, cancellation, errors, stop/reconnect, and shutdown.

## License and attribution

MIT. See [LICENSE](LICENSE).

Search is provided by [FFF](https://github.com/dmtrKovalenko/fff), maintained by dmtrKovalenko and contributors. This repository contains the agent adapter and depends on the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
