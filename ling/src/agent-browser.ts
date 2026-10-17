import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Config } from "./config.js";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

/**
 * The configuration the CLI reads: nothing. Everything the service sets goes
 * through the environment below, and an operator's own settings through
 * AGENT_BROWSER_* variables, which the CLI ranks above any file.
 */
const SERVICE_CONFIG = "{}\n";

/**
 * Where the service writes the configuration files the CLI reads: its data
 * directory, which no sandbox mounts and the file tools cannot write.
 */
export function agentBrowserConfigDir(config: Config): string {
  return path.join(config.dataDir, "agent-browser");
}

/**
 * Writes the configuration file for one run of the CLI and returns its path.
 * Without one the pinned CLI (0.33.2, load_config in cli/src/flags.rs) reads
 * ~/.agent-browser/config.json and then ./agent-browser.json from its working
 * directory, the task's workspace, where the model can write, from inside the
 * sandbox too. That file can set executablePath, so the CLI starts any program
 * on the host as the service user, plugins, which are programs it runs, and
 * the args, proxy and allowFileAccess refused or checked on the command line.
 * When AGENT_BROWSER_CONFIG names a file the CLI reads that file instead and
 * neither of the others. --config, which would win over it, is refused.
 *
 * The CLI reads the file once, as it starts: load_config is reached only from
 * the parse_flags its main calls, and the daemon it starts and the steps of a
 * batch read no configuration. So each run gets a file of its own, under a
 * random name, written here and removed when the run ends. The data directory
 * alone would not keep a file out of the task's reach. The CLI's writes are
 * not confined (see agentBrowserRefusal): download and state save, run
 * through agent_browser, write wherever the service user can, and one file
 * shared by every run would be a fixed target that such a write, from this
 * task or another, could replace in between the service writing it and a run
 * alongside reading it. A name no one knows before the run leaves nothing to
 * aim at, and a file a crashed run leaves behind is never read again. With
 * SANDBOX_MODE=none the task's shell runs as the service user and can find
 * the file while the run lasts, but such a task can start programs as the
 * service user without the CLI's help.
 */
function writeRunConfig(config: Config): string {
  const dir = agentBrowserConfigDir(config);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `run-${randomBytes(16).toString("hex")}.json`);
  // wx: a file already there under that name is not one the service wrote.
  writeFileSync(file, SERVICE_CONFIG, { flag: "wx" });
  return file;
}

/** Best-effort: a file left behind is never read again. */
function removeRunConfig(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // On Windows a process that is still exiting may hold it open.
  }
}

export interface AgentBrowserRun {
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

export function agentBrowserSessionName(config: Config, id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
  return `${config.agentBrowserSessionPrefix}-${safe}`;
}

/**
 * What the CLI, its daemon and Chrome inherit from the service. The service's
 * environment holds bearer tokens and provider keys, and processes a web page
 * can steer have no use for them. They get what a browser needs to start --
 * home, temp, locale, display, the Windows system directories and where
 * Playwright's browsers are -- plus an operator's proxy and the operator's own
 * AGENT_BROWSER_* settings, apart from AGENT_BROWSER_CONFIG, which always
 * names `configFile`, the run's own file (writeRunConfig).
 */
const inheritedVariables = new Set([
  // POSIX
  ...["HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "TZ", "TMPDIR"],
  ...["XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"],
  ...["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"],
  ...["FONTCONFIG_PATH", "FONTCONFIG_FILE"],
  // The CLI looks for Chrome here as well. agent.service and the local
  // provisioner set it; a local child's fresh HOME has no browsers of its own.
  "PLAYWRIGHT_BROWSERS_PATH",
  // Windows
  ...["SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"],
  ...["USERPROFILE", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA"],
  ...["PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432"],
  ...["COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432"],
  ...["COMPUTERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"],
  // An operator's egress proxy and the CA it presents
  ...["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"],
]);

function inherited(name: string): boolean {
  // Windows names are case-insensitive, and proxy variables are often lower case.
  const upper = name.toUpperCase();
  return inheritedVariables.has(upper) || upper.startsWith("LC_") || upper.startsWith("AGENT_BROWSER_");
}

export function agentBrowserEnvironment(
  config: Config,
  session: string,
  configFile: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const binDir = path.join(config.rootDir, "node_modules", ".bin");
  const nodeDir = path.dirname(process.execPath);
  const browserBinary =
    process.platform === "win32" ? config.agentBrowserBinary.replaceAll("\\", "/") : config.agentBrowserBinary;
  const environment: NodeJS.ProcessEnv = {};
  let basePath = "";
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (name.toUpperCase() === "PATH") basePath = value;
    else if (inherited(name)) environment[name] = value;
  }
  return {
    ...environment,
    PATH: `${binDir}${path.delimiter}${nodeDir}${path.delimiter}${basePath}`,
    AGENT_BROWSER_BIN: browserBinary,
    AGENT_BROWSER_CONFIG: configFile,
    AGENT_BROWSER_SESSION: session,
    AGENT_BROWSER_CONTENT_BOUNDARIES: "true",
    AGENT_BROWSER_MAX_OUTPUT: String(config.agentBrowserMaxOutput),
    AGENT_BROWSER_IDLE_TIMEOUT_MS: String(config.agentBrowserIdleTimeoutMs),
  };
}

export function assertAgentBrowserInstalled(config: Config): void {
  if (!existsSync(config.agentBrowserBinary)) {
    throw new Error(
      `agent-browser is not installed at ${config.agentBrowserBinary}. Run \`npm ci\` and then \`npm run browser:doctor\`.`,
    );
  }
}

export function runAgentBrowser(
  config: Config,
  args: string[],
  options: {
    session: string;
    cwd?: string;
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<AgentBrowserRun> {
  assertAgentBrowserInstalled(config);
  // The CLI exits if the file AGENT_BROWSER_CONFIG names is missing.
  const configFile = writeRunConfig(config);
  const started = Date.now();

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(config.agentBrowserBinary, args, {
        cwd: options.cwd ?? config.rootDir,
        env: agentBrowserEnvironment(config, options.session, configFile),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      removeRunConfig(configFile);
      throw error;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      return next.length > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      removeRunConfig(configFile);
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr, elapsedMs: Date.now() - started });
      }
    };

    const abort = () => {
      child.kill();
      finish(new Error("agent-browser command was cancelled"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    const timeoutMs = options.timeoutMs ?? 120_000;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`agent-browser command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) {
        finish();
      } else {
        const detail = stderr.trim() || stdout.trim() || `exit code ${String(code)}`;
        finish(new Error(`agent-browser failed: ${detail}`));
      }
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

export async function closeAgentBrowserSession(config: Config, session: string): Promise<void> {
  try {
    await runAgentBrowser(config, ["--session", session, "close"], {
      session,
      timeoutMs: 15_000,
    });
  } catch {
    // A task can finish before Chrome launches, or Chrome may already have
    // exited. Cleanup should never turn successful work into a failed task.
  }
}
