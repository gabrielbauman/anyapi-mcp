// Run the harness source in a sandboxed deno subprocess.
//
// Security boundary (the v1 secrets boundary):
//   --allow-net=<api hosts only>   model code can only reach the registered API
//   --allow-env=ANYAPI_MCP_TOKEN   model code can read only the token variable
//   (no --allow-read/--allow-write/--allow-run)
//   clearEnv + a minimal env       the child OS environment holds no other secrets
//
// The token is injected into the subprocess env only; the model never sees it,
// and the net allowlist means even hostile code can't ship it elsewhere.
//
// Type-checking stays on (`--check`) so the model sees type errors and can
// self-correct. The module cache is warmed in the parent first (full network),
// so the sandboxed run needs no registry access to load its imports.

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const TIMEOUT_MS = 30_000;
/** Env vars the child needs to function (find its module cache, temp dir). */
const PASSTHROUGH_ENV = ["HOME", "PATH", "DENO_DIR", "TMPDIR"];

/**
 * The deno binary to drive the sandbox. In dev this is the running deno; in a
 * `deno compile`d binary, Deno.execPath() is the anyapi-mcp binary, so fall back to
 * `deno` on PATH (which the compiled binary documents as a requirement).
 */
function denoExecutable(): string {
  const exe = Deno.execPath();
  return exe.endsWith("/deno") ? exe : "deno";
}

function minimalEnv(token: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = Deno.env.get(key);
    if (value !== undefined) env[key] = value;
  }
  if (token !== undefined) env.ANYAPI_MCP_TOKEN = token;
  return env;
}

export async function runSandboxed(
  source: string,
  hosts: string[],
  token: string | undefined,
): Promise<ExecuteResult> {
  const deno = denoExecutable();
  const dec = new TextDecoder();
  const tmp = await Deno.makeTempFile({
    prefix: "anyapi-mcp-exec-",
    suffix: ".ts",
  });

  try {
    await Deno.writeTextFile(tmp, source);

    // 1) Warm the module cache in the parent (full network) so the sandbox can
    //    load its imports offline. Caching does not execute model code.
    const warm = await new Deno.Command(deno, {
      args: ["cache", "--no-config", "--no-lock", tmp],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (warm.code !== 0) {
      return {
        stdout: "",
        stderr: dec.decode(warm.stderr) ||
          "Failed to resolve modules for execution.",
        exitCode: warm.code,
      };
    }

    // 2) Type-check + run, sandboxed.
    const args = ["run", "--check", "--no-config", "--no-lock"];
    if (hosts.length > 0) args.push(`--allow-net=${hosts.join(",")}`);
    args.push("--allow-env=ANYAPI_MCP_TOKEN", tmp);

    const child = new Deno.Command(deno, {
      args,
      clearEnv: true,
      env: minimalEnv(token),
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, TIMEOUT_MS);

    const { code, stdout, stderr } = await child.output();
    clearTimeout(timer);

    let err = dec.decode(stderr);
    if (timedOut) {
      err += `\nanyapi-mcp: execution timed out after ${
        TIMEOUT_MS / 1000
      }s and was killed.`;
    }
    return {
      stdout: dec.decode(stdout),
      stderr: err,
      exitCode: timedOut ? 124 : code,
    };
  } finally {
    try {
      await Deno.remove(tmp);
    } catch {
      // best effort
    }
  }
}
