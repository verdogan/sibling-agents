import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import type { HarnessSpawnHook } from "./harness/index.js";

const run = promisify(execFile);

/**
 * Wraps shell execution in a per-task container.
 *
 * The workspace is bind-mounted at the same absolute path inside the container
 * so that paths the agent produces on the host stay valid when a command runs
 * inside it. That requires a Linux host; on Windows or macOS the host path is
 * not a legal container path, which is why this is off by default and enabled
 * on the VM.
 *
 * Scope: this sandboxes the bash tool only. The browser and http_request tools
 * run in the service process itself, so a task can still reach the network
 * through them regardless of the container's network settings.
 */
export interface Sandbox {
  readonly enabled: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly spawnHook: HarnessSpawnHook;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Environment names a task's shell never inherits: this service's bearer
 * tokens, and anything shaped like a credential. The suffixes take in every
 * key name pi-ai reads today (`*_API_KEY`, `*_AUTH_TOKEN`, `HF_TOKEN` and the
 * rest); the names spelled out are the credentials that end some other way,
 * Bedrock's bearer key among them. A key under a name of neither kind gets
 * through, so a new provider's names need checking against this. Pi reads its
 * keys from this process's own environment, which is untouched; only the copy
 * handed to the child loses them. Windows names are case-insensitive, hence
 * the flag.
 */
const credentialName = /^(?:AGENT_TOKENS_JSON|GOOGLE_APPLICATION_CREDENTIALS|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_BEARER_TOKEN_BEDROCK)$|(?:API_KEY|_TOKEN|_SECRET|_PASSWORD)$/i;

/**
 * The environment a task's shell runs with. Pi hands bash a copy of this
 * service's whole environment, `.env` included, so without this a stray `env`
 * would put the token that drives this API, or a neighbour ling's, and the
 * provider keys the task is spending into the command's output, and from there
 * into the event log and any watcher's feed.
 *
 * That accident is what this stops. It does not stop a task that sets out to
 * read them. With SANDBOX_MODE=none the shell runs on the host as the service
 * user, so it can still read the service's `.env` and, on Linux, the
 * environment this process started with in `/proc/$PPID/environ`; the guards
 * refuse neither. Only the container sandbox puts them out of reach; a
 * separate user per ling at least keeps a neighbour ling's out of reach.
 */
export function taskShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !credentialName.test(name)));
}

/**
 * Run container processes as the host's service user so bind-mounted files come
 * out owned by it. getuid exists only on POSIX; elsewhere the sandbox is off
 * anyway, so returning no arguments is the honest fallback.
 */
function identityArgs(workspaceDir: string): string[] {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return [];
  return ["--user", `${uid}:${gid}`, "--env", `HOME=${workspaceDir}`];
}

export function createSandbox(options: {
  config: Config;
  taskId: string;
  workspaceDir: string;
}): Sandbox {
  const { config, taskId, workspaceDir } = options;
  const enabled = config.sandboxMode === "docker";
  const containerName = `pi-task-${taskId}`;
  let started = false;

  return {
    enabled,

    async start(): Promise<void> {
      if (!enabled) return;
      try {
        await run(config.containerRuntime, [
          "run",
          "--detach",
          "--rm",
          "--name",
          containerName,
          ...(config.containerRuntime === "podman" ? ["--userns", "keep-id"] : []),
          // Without this the container runs as root and every file bash creates
          // in the bind-mounted workspace is root-owned on the host, which the
          // service user cannot then read, edit or clean up. HOME follows the
          // uid because an id with no passwd entry has no writable home, and
          // package managers run from bash need one.
          ...identityArgs(workspaceDir),
          "--network",
          config.sandboxNetwork,
          "--memory",
          config.sandboxMemory,
          "--cpus",
          config.sandboxCpus,
          "--pids-limit",
          String(config.sandboxPidsLimit),
          "--security-opt",
          "no-new-privileges",
          "--cap-drop",
          "ALL",
          "--volume",
          `${workspaceDir}:${workspaceDir}`,
          "--workdir",
          workspaceDir,
          config.sandboxImage,
          "sleep",
          "infinity",
        ]);
        started = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `SANDBOX_MODE=docker with ${config.containerRuntime} could not start the container: ${detail}\nCheck that the image is pullable and the rootless runtime works for this service user.`,
        );
      }
    },

    async stop(): Promise<void> {
      if (!enabled || !started) return;
      try {
        await run(config.containerRuntime, ["rm", "--force", containerName]);
      } catch {
        // The container is configured with --rm, so a failure here means it is
        // already gone. Never fail a finished task on cleanup.
      }
      started = false;
    },

    // In docker mode the command inside the container gets only the image's
    // environment and the run arguments above; the scrubbed copy is what the
    // host-side `exec` client inherits, which a process sharing the host user
    // could otherwise read.
    spawnHook: (context) => {
      const scrubbed = { ...context, env: taskShellEnv(context.env) };
      if (!enabled) return scrubbed;
      return {
        ...scrubbed,
        command: `${config.containerRuntime} exec --workdir ${shellQuote(context.cwd)} ${containerName} bash -lc ${shellQuote(context.command)}`,
      };
    },
  };
}
