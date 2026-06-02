// `anyapi-mcp install` - register this MCP server with local clients so you don't
// have to wire it up by hand. Targets Claude Code (via the `claude` CLI) and
// Claude Desktop (by editing its config file), pointing both at `<binary> serve`.
//
// It registers the path of the running binary, so run it from the installed
// `anyapi-mcp`, not via `deno task dev` (where the running executable is `deno`).

import { parseArgs } from "@std/cli/parse-args";
import { basename, dirname, join, resolve } from "@std/path";

const HELP = `anyapi-mcp install - register this MCP server with local clients

Usage:
  anyapi-mcp install [options]

Points Claude Code (via the \`claude\` CLI) and/or Claude Desktop (via its config
file) at this binary's \`serve\` command. Run it from the compiled binary so it
registers that binary's own path.

Options:
  --client <code|desktop|all>   Client(s) to set up (default: all available)
  --command <path>              Path to register (default: this binary)
  --scope <user|project|local>  Claude Code scope (default: user)
  --name <name>                 Server name to register as (default: anyapi-mcp)
  --dry-run                     Print what would change; write nothing
  -h, --help                    Show this help`;

interface Options {
  command: string;
  scope: string;
  name: string;
  dryRun: boolean;
}

/** Is the `claude` CLI on PATH? */
async function claudeAvailable(): Promise<boolean> {
  try {
    const { success } = await new Deno.Command("claude", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return success;
  } catch {
    return false;
  }
}

async function installCode(opts: Options): Promise<string> {
  const manual =
    `  By hand: claude mcp add -s ${opts.scope} ${opts.name} -- ${opts.command} serve`;
  if (!(await claudeAvailable())) {
    return `Claude Code: \`claude\` CLI not on PATH; skipped.\n${manual}`;
  }
  const cmdArgs = [
    "mcp",
    "add",
    "-s",
    opts.scope,
    opts.name,
    "--",
    opts.command,
    "serve",
  ];
  if (opts.dryRun) {
    return `Claude Code: would run \`claude ${cmdArgs.join(" ")}\``;
  }
  const { success, stderr } = await new Deno.Command("claude", {
    args: cmdArgs,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (success) {
    return `Claude Code: registered "${opts.name}" (${opts.scope} scope) -> ${opts.command} serve`;
  }
  const msg = new TextDecoder().decode(stderr).trim();
  return `Claude Code: \`claude mcp add\` failed${msg ? `: ${msg}` : ""}.\n` +
    `  It may already be registered (remove it with \`claude mcp remove ${opts.name}\` to redo).\n${manual}`;
}

/** Claude Desktop's config file, or null if this platform has no Claude Desktop. */
function desktopConfigPath(): string | null {
  // Claude Desktop ships on macOS (and Windows), not Linux; anyapi-mcp targets
  // macOS/Linux, so we handle the macOS location here.
  if (Deno.build.os !== "darwin") return null;
  const home = Deno.env.get("HOME");
  if (!home) return null;
  return join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json",
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function installDesktop(opts: Options): Promise<string> {
  const configPath = desktopConfigPath();
  if (!configPath) {
    return `Claude Desktop: not available on ${Deno.build.os}; skipped.`;
  }
  if (!(await pathExists(dirname(configPath)))) {
    return `Claude Desktop: not installed (no ${
      dirname(configPath)
    }); skipped.`;
  }

  // Read-modify-write so other servers and settings survive. Refuse to clobber a
  // config we can't parse.
  let config: Record<string, unknown> = {};
  if (await pathExists(configPath)) {
    const raw = await Deno.readTextFile(configPath);
    if (raw.trim() !== "") {
      try {
        config = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new Error(
          `Claude Desktop config at ${configPath} is not valid JSON; leaving it untouched.`,
        );
      }
    }
  }
  if (
    typeof config.mcpServers !== "object" || config.mcpServers === null ||
    Array.isArray(config.mcpServers)
  ) {
    config.mcpServers = {};
  }
  const servers = config.mcpServers as Record<string, unknown>;
  servers[opts.name] = { command: opts.command, args: ["serve"] };

  if (opts.dryRun) {
    return `Claude Desktop: would set mcpServers.${opts.name} in ${configPath}`;
  }
  await Deno.writeTextFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return `Claude Desktop: registered "${opts.name}" in ${configPath}\n` +
    `  Restart Claude Desktop to load it.`;
}

export async function runInstall(args: string[]): Promise<void> {
  const flags = parseArgs(args, {
    string: ["client", "command", "scope", "name"],
    boolean: ["help", "dry-run"],
    alias: { h: "help" },
  });
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const selfPath = Deno.execPath();
  if (!flags.command && basename(selfPath).replace(/\.exe$/, "") === "deno") {
    console.error(
      "anyapi-mcp install: run this from the compiled binary (e.g. `./anyapi-mcp install`) so it can " +
        "register its own path, or pass `--command <path-to-anyapi-mcp>`.",
    );
    Deno.exit(1);
  }
  const command = resolve(flags.command ?? selfPath);

  const client = (flags.client ?? "all").toLowerCase();
  if (!["code", "desktop", "all"].includes(client)) {
    console.error(
      `anyapi-mcp install: unknown --client "${flags.client}" (use code, desktop, or all).`,
    );
    Deno.exit(1);
  }
  const scope = flags.scope ?? "user";
  if (!["user", "project", "local"].includes(scope)) {
    console.error(
      `anyapi-mcp install: unknown --scope "${scope}" (use user, project, or local).`,
    );
    Deno.exit(1);
  }

  const opts: Options = {
    command,
    scope,
    name: flags.name ?? "anyapi-mcp",
    dryRun: Boolean(flags["dry-run"]),
  };

  const results: string[] = [];
  try {
    if (client === "code" || client === "all") {
      results.push(await installCode(opts));
    }
    if (client === "desktop" || client === "all") {
      results.push(await installDesktop(opts));
    }
  } catch (err) {
    console.error(
      `anyapi-mcp install: ${err instanceof Error ? err.message : String(err)}`,
    );
    Deno.exit(1);
  }

  if (opts.dryRun) console.log("(dry run; nothing written)\n");
  console.log(results.join("\n"));
}
