import path from "node:path";
import { Type, type TSchema } from "@sinclair/typebox";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FffController, type SearchToolName } from "./src/controller.ts";

export interface Context {
  cwd: string;
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

export interface ToolResult {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  details: { root: string };
}

export interface SearchTool {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  approval: "read";
  execute(
    id: string,
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: Context,
  ): Promise<ToolResult>;
}

/** Shared structural API: no runtime imports from either host are needed. */
export interface ExtensionHost {
  registerTool(tool: SearchTool): void;
  registerCommand(
    name: string,
    command: { description: string; handler(args: string, ctx: Context): Promise<void> },
  ): void;
  on(event: "session_shutdown", handler: () => Promise<void>): void;
}

const repo = Type.Optional(
  Type.String({
    description:
      "Git worktree directory, absolute or relative to the session cwd. Defaults to the session cwd; supply this when working from a scratch directory.",
  }),
);
const maxResults = Type.Optional(
  Type.Number({ description: "Maximum results requested from FFF (default: 20)." }),
);
const cursor = Type.Optional(
  Type.String({
    description: "Cursor from the previous result for the same repository and query.",
  }),
);
const outputMode = Type.Optional(
  Type.String({ description: "FFF output mode (default: content)." }),
);
const context = Type.Optional(
  Type.Number({ description: "Context lines before and after each match." }),
);

const tools: Array<{
  name: string;
  label: string;
  upstream: SearchToolName;
  description: string;
  parameters: TSchema;
}> = [
  {
    name: "fff_find",
    label: "FFF Find",
    upstream: "find_files",
    description:
      "Explore filenames and paths in a Git worktree with FFF fuzzy search. Keep queries short. Use native glob for exact path enumeration and native grep for exact content verification. Results identify the indexed repository root.",
    parameters: Type.Object({
      query: Type.String({
        description: "Short fuzzy filename query, with optional path/glob constraints.",
      }),
      repo,
      maxResults,
      cursor,
    }),
  },
  {
    name: "fff_grep",
    label: "FFF Grep",
    upstream: "grep",
    description:
      "Explore file contents in a Git worktree with FFF. Zero exact matches may broaden into fuzzy suggestions; use native grep to prove exact presence or absence. Prefer identifiers and constrain paths in the query. Results identify the indexed repository root.",
    parameters: Type.Object({
      query: Type.String({
        description: "Identifier or search pattern with optional inline path constraints.",
      }),
      repo,
      maxResults,
      cursor,
      output_mode: outputMode,
      context,
    }),
  },
  {
    name: "fff_multi_grep",
    label: "FFF Multi Grep",
    upstream: "multi_grep",
    description:
      "Search a Git worktree for any of several literal patterns (OR, not AND). Useful for identifier variants. Results identify the indexed repository root; native search tools remain available for their exact-search contracts.",
    parameters: Type.Object({
      patterns: Type.Array(Type.String(), { description: "Literal patterns with OR matching." }),
      constraints: Type.Optional(
        Type.String({ description: "FFF path filters, e.g. *.{ts,tsx} !test/." }),
      ),
      repo,
      maxResults,
      cursor,
      output_mode: outputMode,
      context,
    }),
  },
];

function formatResult(root: string, result: CallToolResult): ToolResult {
  const content: ToolResult["content"] = [{ type: "text", text: `FFF root: ${root}` }];
  for (const block of result.content) {
    if (block.type === "text" || block.type === "image") content.push(block);
    else if (block.type === "resource" && "text" in block.resource)
      content.push({ type: "text", text: block.resource.text });
    else if (block.type === "resource_link")
      content.push({ type: "text", text: `${block.name}: ${block.uri}` });
    else throw new Error(`FFF returned unsupported content type: ${block.type}`);
  }
  // Pi marks thrown tool failures as errors; a returned isError flag is insufficient.
  if (result.isError)
    throw new Error(
      content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    );
  return { content, details: { root } };
}

export default function fffExtension(host: ExtensionHost): void {
  const controller = new FffController();
  for (const tool of tools) {
    host.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      approval: "read",
      async execute(_id, input, signal, _onUpdate, ctx) {
        const { repo: requestedRepo, ...args } = input;
        if (requestedRepo !== undefined && typeof requestedRepo !== "string")
          throw new Error("FFF repo must be a directory path.");
        const directory = requestedRepo ? path.resolve(ctx.cwd, requestedRepo) : ctx.cwd;
        const response = await controller.search(tool.upstream, args, directory, signal);
        return formatResult(response.root, response.result);
      },
    });
  }
  host.registerCommand("fff", {
    description: "Show or stop the lazy FFF connection: /fff [status|stop]",
    async handler(args, ctx) {
      const action = args.trim() || "status";
      if (action === "stop") {
        try {
          ctx.ui.notify((await controller.stop()) ? "FFF stopped" : "FFF is not connected", "info");
        } catch (error) {
          ctx.ui.notify(
            `FFF failed to stop: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      } else
        ctx.ui.notify(
          action === "status" ? controller.status() : "Usage: /fff [status|stop]",
          "info",
        );
    },
  });
  host.on("session_shutdown", () => controller.shutdown());
}
