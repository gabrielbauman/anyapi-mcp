// anyapi-mcp entry point: parse argv and dispatch to a subcommand.
//
// stdout hygiene: the `serve` subcommand speaks the MCP JSON-RPC protocol over
// stdout, so it must never print anything else there. Top-level help/errors here
// only run for non-serve invocations, so using stdout for them is safe.

import { runAdd } from "./commands/add.ts";
import { runInstall } from "./commands/install.ts";
import { runList } from "./commands/list.ts";
import { runRemove } from "./commands/remove.ts";
import { runServe } from "./commands/serve.ts";

const USAGE = `anyapi-mcp - code-mode MCP server for any API

Usage:
  anyapi-mcp add <spec-url-or-path> [options]   Register an API from an OpenAPI spec
  anyapi-mcp list                               List registered APIs
  anyapi-mcp remove <id>                        Remove a registered API and its token
  anyapi-mcp serve                              Run the stdio MCP server
  anyapi-mcp install                            Add to Claude Code / Claude Desktop

Run "anyapi-mcp <command> --help" for command-specific options.`;

async function main(): Promise<void> {
  const [command, ...rest] = Deno.args;
  switch (command) {
    case "add":
      await runAdd(rest);
      break;
    case "list":
      await runList(rest);
      break;
    case "remove":
      await runRemove(rest);
      break;
    case "serve":
      await runServe(rest);
      break;
    case "install":
      await runInstall(rest);
      break;
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(USAGE);
      break;
    default:
      console.error(`anyapi-mcp: unknown command "${command}"`);
      console.error(USAGE);
      Deno.exit(1);
  }
}

await main();
