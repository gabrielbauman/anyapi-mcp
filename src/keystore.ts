// OS keystore access, dispatched on Deno.build.os. Secrets are keyed by an
// account string (e.g. "anyapi-mcp:github") and never touch the registry file.
//
//   macOS:  security add-generic-password / find-generic-password / delete-generic-password
//   Linux:  secret-tool store / lookup / clear
//
// All entries share a fixed service name; the caller-supplied account string
// distinguishes them.

const SERVICE = "anyapi-mcp";

function unsupported(): never {
  throw new Error(
    `anyapi-mcp keystore: unsupported OS "${Deno.build.os}" (macOS and Linux only).`,
  );
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<RunResult> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(cmd, {
      args,
      stdin: stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      const hint = cmd === "secret-tool"
        ? "Install it (e.g. `apt-get install libsecret-tools`)."
        : "It ships with macOS; check your PATH.";
      throw new Error(`anyapi-mcp keystore: "${cmd}" not found. ${hint}`);
    }
    throw err;
  }

  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }

  const { code, stdout, stderr } = await child.output();
  const dec = new TextDecoder();
  return { code, stdout: dec.decode(stdout), stderr: dec.decode(stderr) };
}

function stripTrailingNewline(s: string): string {
  return s.replace(/\r?\n$/, "");
}

/** Store (or update) the secret for `account`. */
export async function setSecret(
  account: string,
  secret: string,
): Promise<void> {
  const os = Deno.build.os;
  if (os === "darwin") {
    const { code, stderr } = await run("security", [
      "add-generic-password",
      "-U", // update if it already exists
      "-s",
      SERVICE,
      "-a",
      account,
      "-w",
      secret,
    ]);
    if (code !== 0) throw new Error(`Failed to store secret: ${stderr.trim()}`);
    return;
  }
  if (os === "linux") {
    const { code, stderr } = await run(
      "secret-tool",
      [
        "store",
        "--label",
        `${SERVICE}: ${account}`,
        "service",
        SERVICE,
        "account",
        account,
      ],
      secret,
    );
    if (code !== 0) throw new Error(`Failed to store secret: ${stderr.trim()}`);
    return;
  }
  unsupported();
}

/** Retrieve the secret for `account`, or undefined if none is stored. */
export async function getSecret(account: string): Promise<string | undefined> {
  const os = Deno.build.os;
  if (os === "darwin") {
    const { code, stdout } = await run("security", [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      account,
      "-w", // print only the password
    ]);
    return code === 0 ? stripTrailingNewline(stdout) : undefined;
  }
  if (os === "linux") {
    const { code, stdout } = await run("secret-tool", [
      "lookup",
      "service",
      SERVICE,
      "account",
      account,
    ]);
    return code === 0 ? stripTrailingNewline(stdout) : undefined;
  }
  unsupported();
}

/** Delete the secret for `account`. Returns true if one was removed. */
export async function deleteSecret(account: string): Promise<boolean> {
  const os = Deno.build.os;
  if (os === "darwin") {
    const { code } = await run("security", [
      "delete-generic-password",
      "-s",
      SERVICE,
      "-a",
      account,
    ]);
    return code === 0;
  }
  if (os === "linux") {
    const { code } = await run("secret-tool", [
      "clear",
      "service",
      SERVICE,
      "account",
      account,
    ]);
    return code === 0;
  }
  unsupported();
}
