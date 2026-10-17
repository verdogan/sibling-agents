import path from "node:path";
import { defineTool, type HarnessExtension } from "../harness/index.js";
import { Type } from "typebox";
import {
  agentBrowserSessionName,
  assertAgentBrowserInstalled,
  closeAgentBrowserSession,
  runAgentBrowser,
} from "../agent-browser.js";
import { GuardViolation, resolveInsideWorkspaceReal } from "../guards.js";
import { egressRefusal, type EgressPolicy } from "../tools/http.js";
import { onShutdownOnce } from "./lifecycle.js";
import type { Feature, FeatureContext } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;

/**
 * Arguments that would take the run outside its own browser session or past
 * the checks below: attaching to the operator's Chrome; restoring a saved
 * session; starting the browser in another namespace or keeping it past the
 * service's idle timeout; loading a profile, saved state, an extension or an
 * init script, each from a path anywhere on the host; naming the program the
 * CLI starts as the browser, or handing the browser to another one; choosing
 * the configuration it reads; letting file:// pages read the host's files; or
 * passing Chromium switches, which can replace its resolver and its proxy and
 * name programs for it to start. The CLI takes none of these as --flag=value,
 * --restore= apart. The skill asks the model not to do these; refusing them
 * here means the guarantee does not depend on the model cooperating.
 *
 * The daemon the CLI starts, and its Chrome, are detached from the call and
 * run on the host, so what ends them is the service closing the session or
 * the idle timeout. In another namespace the CLI keeps a second daemon and
 * Chrome under the same session name, which closing this task's session does
 * not reach; --idle-timeout replaces the service's timeout, and 0 turns it
 * off. Either one leaves a Chrome running the page's scripts after the task
 * has ended and its processes have been killed.
 */
const refusedArguments: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /^--session(=|$)/, why: "the service assigns this task its own session" },
  {
    pattern: /^--namespace$/,
    why: "the service assigns this task its own session, and another namespace starts a browser the service cannot close",
  },
  { pattern: /^--idle-timeout$/, why: "the service decides how long an idle browser lives" },
  { pattern: /^--auto-connect$/, why: "attaching to an existing browser is not allowed" },
  { pattern: /^--restore(=|$)/, why: "restoring a previous session is not allowed" },
  {
    pattern: /^--session-name$/,
    why: "it restores the state saved under that name, and restoring a previous session is not allowed",
  },
  { pattern: /^--profile(=|$)/, why: "using a Chrome profile is not allowed" },
  { pattern: /^--user-data-dir(=|$)/, why: "using a Chrome profile is not allowed" },
  {
    pattern: /^--state$/,
    why: "it loads saved cookies and storage from a file anywhere on the host, and sends the browser to every origin the file names",
  },
  { pattern: /^--extension$/, why: "an extension is code from outside the pinned browser, read from anywhere on the host" },
  { pattern: /^--init-script$/, why: "it reads a file from anywhere on the host and runs it in every page" },
  { pattern: /^--cdp$/, why: "attaching to an existing browser is not allowed" },
  {
    pattern: /^--executable-path$/,
    why: "the service pins the browser, and this would start any program on the host",
  },
  {
    pattern: /^--engine$/,
    why: "the service pins the browser, and this starts another program, found on PATH or in the home directory",
  },
  {
    pattern: /^(-p|--provider)$/,
    why: "the service runs this task's browser itself, and a provider is a remote service or a plugin program",
  },
  { pattern: /^--config$/, why: "the service decides which configuration the CLI reads" },
  {
    pattern: /^--action-policy$/,
    why: "the service decides which configuration the CLI reads, and this reads a file from anywhere on the host",
  },
  { pattern: /^--allow-file-access$/, why: "it lets a file:// page read the host's files" },
  {
    pattern: /^--args$/,
    why: "Chromium switches can change its resolver, its proxy and the programs it starts, and none of these checks would see it",
  },
];

function rejectUnsafeArguments(args: readonly string[]): string | undefined {
  for (const arg of args) {
    for (const { pattern, why } of refusedArguments) {
      if (pattern.test(arg)) return `Refused: ${arg} is not allowed because ${why}.`;
    }
  }
  return undefined;
}

/**
 * Global flags of the pinned CLI that take a value, as its clean_args()
 * removes them before it reads the command (cli/src/flags.rs, 0.33.2). They go
 * anywhere on the line, and there is no --flag=value form apart from
 * --restore=, which is refused. The first word left is the command; an
 * unknown flag there is an unknown command. None of this applies inside a
 * batch step, which the CLI parses as it stands: a flag there is an argument
 * of the step's command.
 */
const globalValueFlags = new Set([
  "--profile",
  "--restore-save",
  "--restore-check-url",
  "--restore-check-text",
  "--restore-check-fn",
  "--session-name",
  "--state",
  "--headers",
  "--session",
  "--namespace",
  "--executable-path",
  "--extension",
  "--init-script",
  "--enable",
  "--args",
  "--user-agent",
  "--proxy",
  "--proxy-bypass",
  "-p",
  "--provider",
  "--device",
  "--screenshot-dir",
  "--screenshot-quality",
  "--screenshot-format",
  "--cdp",
  "--color-scheme",
  "--download-path",
  "--max-output",
  "--allowed-domains",
  "--action-policy",
  "--confirm-actions",
  "--engine",
  "--idle-timeout",
  "--model",
  "--config",
]);

/**
 * Global flags of the pinned CLI that take no value. Each may be followed by
 * true or false, as in --hide-scrollbars false, and the CLI takes that too.
 * --offline, --quick and --fix belong to doctor but come off every line. The
 * CLI leaves --help and --version in place, but either one anywhere makes it
 * print help or its version and do nothing else.
 */
const globalBooleanFlags = new Set([
  ...["--json", "--headed", "--webgpu", "--debug", "--ignore-https-errors", "--allow-file-access"],
  ...["--hide-scrollbars", "--auto-connect", "--annotate", "--content-boundaries", "--confirm-interactive"],
  ...["--no-auto-dialog", "-v", "--verbose", "-q", "--quiet", "--offline", "--quick", "--fix"],
  ...["--help", "-h", "--version", "-V"],
]);

/**
 * The commands agent_browser runs: those that drive this task's own browser
 * and the pages in it. Anything else is refused, so a command this list does
 * not know -- one a later CLI adds, or a word taken for the command because a
 * flag was misread -- fails closed rather than open.
 */
const allowedCommands = new Set([
  // Navigation. The destinations are checked; see navigationTargets().
  ...["open", "goto", "navigate", "read", "pushstate", "vitals", "a11y", "tab", "diff", "record"],
  ...["back", "forward", "reload", "window"],
  // Reading and driving the page
  ...["snapshot", "screenshot", "pdf", "eval", "get", "is", "find", "wait", "console", "errors", "highlight"],
  ...["click", "dblclick", "type", "fill", "press", "key", "keyboard", "keydown", "keyup", "hover", "focus"],
  ...["check", "uncheck", "select", "drag", "upload", "download", "scroll", "scrollintoview", "scrollinto"],
  ...["mouse", "tap", "swipe", "frame", "dialog", "clipboard", "addinitscript", "removeinitscript", "react"],
  // The session's state, recording and confirmation. state is narrowed below.
  ...["set", "cookies", "storage", "network", "state", "trace", "profiler", "confirm", "deny"],
  ...["session", "close", "quit", "exit"],
  // Several commands at once, and the CLI's own help
  ...["batch", "skills", "doctor"],
]);

/** Commands refused by name, with the reason the model is told. */
const refusedCommands: Readonly<Record<string, string>> = {
  connect: "it attaches to whatever browser listens on the port it is given",
  mcp: "its tools take any URL and any CLI flag, and none of them passes these checks",
  chat: "it hands the browser to another model, whose commands pass none of these checks",
  dashboard: "it opens a listener on the host",
  stream: "it opens a listener on the host",
  plugin: "a plugin is code from outside the pinned binary",
  install: "the browser is installed by the service",
  upgrade: "the binary is pinned by the service",
  auth: "the credentials it saves are shared by every session on the ling, and auth login types them into whatever page --url names",
};

/**
 * The state subcommands agent_browser runs: save, a write like the others
 * agentBrowserRefusal leaves unconfined, and show, which prints a file in the
 * workspace. state load puts a file's cookies and storage in the browser, and
 * to set an origin's storage it first sends the browser to that origin, as
 * the file names it (load_state in cli/src/native/state.rs, 0.33.2), where no
 * check here sees it: an origin of file:///<any host file># opens that file,
 * the / the CLI appends becoming a fragment, and http://169.254.169.254 is a
 * private address. The others work on the state saved under
 * ~/.agent-browser/sessions for every session on the ling; clear given a
 * name deletes all of it.
 */
const allowedStateSubcommands = new Set(["save", "show"]);

const sharedState = "it works on the state saved for every session on the ling, not only this task's";
const refusedStateSubcommands: Readonly<Record<string, string>> = {
  load: "it sends the browser to every origin the file names, file:// and private addresses included, and none of them passes these checks",
  list: sharedState,
  clear: sharedState,
  clean: sharedState,
  rename: sharedState,
};

/**
 * Where agent-browser would go for a destination. The CLI keeps a URL that
 * names its scheme and puts https:// in front of anything else, such as
 * example.com or localhost:3000. What a URL parser drops is dropped first --
 * spaces and control characters at either end, tabs and newlines anywhere --
 * since Chrome drops them too and "fi\tle:///etc/passwd" is a file URL to it.
 * Text before a colon counts as a host rather than a scheme only when a port
 * follows and it holds a dot or is localhost, so file:0/../etc/passwd stays
 * the file URL Chrome would make of it.
 */
function navigationUrl(target: string): URL | undefined {
  const text = urlText(target);
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1];
  const hostAndPort =
    scheme !== undefined &&
    (scheme.includes(".") || scheme.toLowerCase() === "localhost") &&
    /^\d/.test(text.slice(scheme.length + 1));
  try {
    return new URL(scheme !== undefined && !hostAndPort ? text : `https://${text}`);
  } catch {
    return undefined;
  }
}

/** A URL as a URL parser reads it, without what it drops. */
function urlText(target: string): string {
  return target.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "").replace(/[\t\n\r]/g, "");
}

/**
 * A batch step given as one string, split the way the pinned CLI splits it
 * (shell_words_split in cli/src/commands.rs): at spaces outside quotes, with
 * the quotes removed, and a backslash outside single quotes standing for the
 * character after it. A tab or a newline does not split. So the step
 * open "file:///etc/passwd" is checked as the file URL the CLI opens.
 */
function cliWords(text: string): string[] {
  const words: string[] = [];
  const characters = [...text];
  let current = "";
  let inDouble = false;
  let inSingle = false;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === "\\" && !inSingle) {
      index += 1;
      current += characters[index] ?? "";
    } else if (character === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (character === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (character === " " && !inDouble && !inSingle) {
      if (current !== "") words.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current !== "") words.push(current);
  return words;
}

/** A batch step, given as a JSON array or as a command line. */
function batchStep(step: unknown): string[] {
  return Array.isArray(step) ? step.map(String) : cliWords(String(step));
}

/**
 * The steps on stdin. The CLI accepts only a JSON array of string arrays
 * there and runs nothing otherwise, but every form is read, so that nothing
 * it might run goes unchecked.
 */
function batchSteps(stdin: string): string[][] {
  try {
    const parsed: unknown = JSON.parse(stdin);
    if (Array.isArray(parsed)) return parsed.map(batchStep);
  } catch {
    // Not JSON. Read it as one command per line so that nothing goes unchecked.
  }
  return stdin
    .split(/\r?\n/)
    .map(batchStep)
    .filter((step) => step.length > 0);
}

/**
 * The arguments that are not flags or the values of `valueFlags`. A flag is
 * an argument that starts with `flagPrefix`.
 */
function operands(args: readonly string[], valueFlags: readonly string[], flagPrefix: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (valueFlags.includes(arg)) index += 1;
    else if (!arg.startsWith(flagPrefix)) found.push(arg);
  }
  return found;
}

/**
 * Where a command sends the browser: the arguments the pinned CLI's parser
 * takes as a URL (cli/src/commands.rs, 0.33.2), read as it reads them. Where
 * the CLI would reject the line instead, this may return more.
 */
function navigationTargets(command: string, args: readonly string[]): string[] {
  switch (command) {
    // The first argument that does not start with --, whatever precedes it.
    case "open":
    case "goto":
    case "navigate":
    case "vitals":
      return args.filter((arg) => !arg.startsWith("--")).slice(0, 1);
    case "pushstate":
      // The page resolves this against its own address, so a path stays on
      // the origin the page can send requests to anyway. A Next.js page goes
      // wherever an absolute URL points, so one that names a scheme or a host
      // is checked.
      return args.slice(0, 1).filter((target) => /^([a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(urlText(target)));
    case "read":
      return operands(args, ["--llms", "--filter", "--timeout"], "--");
    case "a11y":
      return operands(args, ["--tags", "--selector", "-s"], "-");
    case "tab":
      // tab new [--label <name>] [url]
      return args[0] === "new" ? operands(args.slice(1), ["--label"], "--") : [];
    case "diff":
      // diff url <url1> <url2>, by position
      return args[0] === "url" ? args.slice(1, 3) : [];
    case "record":
      // record start <path> [url], and restart the same
      return args[0] === "start" || args[0] === "restart" ? args.slice(2, 3) : [];
    default:
      return [];
  }
}

/**
 * The arguments the pinned CLI reads as files on the host (cli/src/commands.rs
 * and cli/src/native/, 0.33.2): the files upload hands the page, the saved
 * state state show prints, the cookie file of cookies set --curl, and the
 * baseline diff snapshot and diff screenshot compare with. Where the CLI
 * would reject the line instead, this may return more.
 */
function hostFileReads(command: string, args: readonly string[]): string[] {
  switch (command) {
    case "upload":
      // upload <selector> <files...>: everything after the selector
      return args.slice(1);
    case "state":
      // state show <path>, which reads only <path>. state load is refused.
      return args[0] === "show" ? args.slice(1, 2) : [];
    case "cookies":
      // cookies set ... --curl <file>. The CLI reads the first; all are checked.
      return args[0] === "set" ? args.filter((_, index) => args[index - 1] === "--curl") : [];
    case "diff":
      // diff snapshot|screenshot --baseline <file>, or -b. A snapshot
      // baseline that names no file is read as snapshot text; one that names
      // a file is read from it, so every one is checked as a path.
      return args[0] === "snapshot" || args[0] === "screenshot"
        ? args.filter((_, index) => args[index - 1] === "--baseline" || args[index - 1] === "-b")
        : [];
    default:
      return [];
  }
}

/**
 * Whether a file the CLI reads is in the workspace, where it really leads
 * included: a link the task made with bash is followed, as in the file tools'
 * guard. agent_browser runs the CLI in the workspace, and the daemon the CLI
 * starts and that daemon's Chrome keep its working directory, so a relative
 * path means the same file to each of them and here.
 * Like that guard, this is a check and not a capability: a shell running
 * alongside can swap a link in between this check and the read.
 */
function hostFileRefusal(command: string, file: string, workspaceDir: string): string | undefined {
  try {
    resolveInsideWorkspaceReal(workspaceDir, file);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An unreadable ancestor or a link loop: where the path leads is unknown,
    // which is a refusal, not a pass.
    const reason = error instanceof GuardViolation ? message : `Refused: ${file} could not be resolved (${message}).`;
    return `${reason} ${command} reads the file on the host, outside any sandbox, so agent_browser gives it only files in the workspace.`;
  }
}

async function targetRefusal(target: string, policy: EgressPolicy): Promise<string | undefined> {
  const url = navigationUrl(target);
  if (url === undefined) {
    return `Refused: ${target} is not a URL, and agent_browser opens only http:// and https:// URLs.`;
  }
  return await egressRefusal(url, policy);
}

/** A proxy may speak socks5 as well as http; only where it is matters here. */
async function proxyRefusal(value: string, policy: EgressPolicy): Promise<string | undefined> {
  if (!policy.blockPrivateNetwork) return undefined;
  const url = navigationUrl(value);
  if (url === undefined || url.host === "") return `Refused: ${value} is not a proxy URL.`;
  return await egressRefusal(new URL(`http://${url.host}/`), policy);
}

const doctorFixRefusal =
  "Refused: doctor --fix is not allowed because it reinstalls the browser and purges state the service manages.";

/**
 * Decides whether an agent_browser call may run for the task whose workspace
 * is `workspaceDir`. Only the commands in allowedCommands run; connect, mcp,
 * chat, dashboard, stream, plugin, install, upgrade and auth are refused by
 * name, and so are close --all, which closes other tasks' sessions, every
 * state subcommand but save and show, and doctor --fix, which reinstalls the
 * browser. The flags in refusedArguments are refused wherever they appear.
 * The egress policy of http_request and browser_open applies to every URL a
 * call names as a destination: what open, read, tab new, diff url, record
 * start and the other navigating commands go to, the same inside each step
 * of a batch, and a --proxy. A file the CLI reads on the host -- what upload
 * hands the page, state show, cookies set --curl, a diff baseline -- has to
 * be in the workspace. The line and its batch steps are read the way the
 * pinned CLI reads them, quotes in a string step included, so that the URL
 * and the file checked are the ones the CLI uses. The CLI's configuration is
 * a file the service writes for each run (runAgentBrowser), so an
 * agent-browser.json the task writes into its workspace is never read.
 *
 * This checks what the model asks for and no more. agent-browser drives its
 * own Chrome with no hook for redirects, links the page follows or navigation
 * done by eval, so none of those is checked; on a worker VM the firewall is
 * what stops them. A command that sends the browser where a file says, as
 * state load does with the origins in it, would be just as unchecked, which
 * is why state load is refused. Nor does it confine where the CLI writes:
 * screenshot, pdf, download, state save, har, trace, profiler, record and
 * diff screenshot --output write anywhere the service user can, as do
 * --download-path and --screenshot-dir, and download writes what the page
 * sends. That is a write on the host, outside the sandbox, and the file it
 * replaces can be one the service user later runs.
 */
export async function agentBrowserRefusal(
  args: readonly string[],
  stdin: string | undefined,
  policy: EgressPolicy,
  workspaceDir: string,
): Promise<string | undefined> {
  const unsafe = rejectUnsafeArguments(args);
  if (unsafe !== undefined) return unsafe;

  // Global flags go anywhere on the line. Without them, what is left is the
  // command followed by its own arguments.
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (globalValueFlags.has(arg)) {
      index += 1;
      const value = args[index];
      if (arg === "--proxy" && value !== undefined) {
        const refusal = await proxyRefusal(value, policy);
        if (refusal !== undefined) return refusal;
      }
    } else if (globalBooleanFlags.has(arg)) {
      if (args[index + 1] === "true" || args[index + 1] === "false") index += 1;
    } else {
      rest.push(arg);
    }
  }

  const [name, ...commandArgs] = rest;
  // With no command the CLI prints its help and does nothing else.
  if (name === undefined) return undefined;
  if (name.startsWith("-")) {
    return `Refused: ${name} is not a global option of agent-browser, so the CLI would read it as the command.`;
  }
  // doctor looks for --fix anywhere on the line, as a flag's value too.
  if (name === "doctor" && args.includes("--fix")) return doctorFixRefusal;
  return await commandRefusal(name, commandArgs, stdin, policy, workspaceDir);
}

/**
 * Decides one command given its own arguments: the line's once its global
 * flags are removed, or a batch step's, which the CLI takes as it stands.
 */
async function commandRefusal(
  name: string,
  commandArgs: readonly string[],
  stdin: string | undefined,
  policy: EgressPolicy,
  workspaceDir: string,
): Promise<string | undefined> {
  const refusedWhy = refusedCommands[name];
  if (refusedWhy !== undefined) return `Refused: ${name} is not allowed because ${refusedWhy}.`;
  if (!allowedCommands.has(name)) {
    return `Refused: agent_browser runs the commands that drive this task's own browser, and ${name} is not one of them.`;
  }
  if ((name === "close" || name === "quit" || name === "exit") && commandArgs.includes("--all")) {
    return `Refused: ${name} --all is not allowed because it closes other tasks' browser sessions too.`;
  }
  // The CLI takes the word after state as its subcommand, a flag included.
  const stateSubcommand = name === "state" ? commandArgs[0] : undefined;
  if (stateSubcommand !== undefined && !allowedStateSubcommands.has(stateSubcommand)) {
    const why = Object.hasOwn(refusedStateSubcommands, stateSubcommand)
      ? refusedStateSubcommands[stateSubcommand]
      : "agent_browser runs only state save and state show";
    return `Refused: state ${stateSubcommand} is not allowed because ${why}.`;
  }
  if (name === "doctor" && commandArgs.includes("--fix")) return doctorFixRefusal;

  if (name === "batch") {
    // Every argument after batch but --bail is a step. The CLI reads stdin
    // only when there is none; both are checked.
    const steps = commandArgs.filter((arg) => arg !== "--bail").map(batchStep);
    if (stdin !== undefined) steps.push(...batchSteps(stdin));
    for (const step of steps) {
      const [stepName, ...stepArgs] = step;
      if (stepName === undefined) continue;
      const unsafe = rejectUnsafeArguments(step);
      if (unsafe !== undefined) return unsafe;
      if (stepName.startsWith("-")) {
        return `Refused: a batch step cannot start with ${stepName}. The CLI reads a step's first word as its command; global options go before batch.`;
      }
      const refusal = await commandRefusal(stepName, stepArgs, undefined, policy, workspaceDir);
      if (refusal !== undefined) return refusal;
    }
    return undefined;
  }

  for (const file of hostFileReads(name, commandArgs)) {
    const refusal = hostFileRefusal(name, file, workspaceDir);
    if (refusal !== undefined) return refusal;
  }
  for (const target of navigationTargets(name, commandArgs)) {
    const refusal = await targetRefusal(target, policy);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

export const agentBrowserFeature: Feature = {
  name: "agent-browser",

  toolNames: ["agent_browser"],

  skillPaths: (ctx) => [
    path.join(ctx.config.agentDir, "skills", "agent-browser"),
    path.join(ctx.config.agentDir, "skills", "browsing-rules"),
  ],

  promptSections: () => [
    `## Browser research

Call the agent_browser tool to drive a real Chrome browser. Pass the CLI
arguments as an array, for example ["read", "https://example.com", "--json"].
The tool supplies the binary, this task's isolated session, and the output
limits, so never invoke agent-browser through bash. Read the agent-browser and
browsing-rules skills before your first call.`,
  ],

  extension: (ctx: FeatureContext): HarnessExtension => {
    const sessionName = agentBrowserSessionName(ctx.config, ctx.taskId);

    return {
      name: "agent-browser",
      factory: (pi) => {
        pi.registerTool(
          defineTool({
            name: "agent_browser",
            label: "Agent Browser",
            description:
              "Run an agent-browser command in a real Chrome browser and return its output. Use this for pages that need JavaScript rendering, or when an HTTP request is blocked or returns an incomplete page. Prefer one `batch` call over several single commands.",
            promptSnippet: "agent_browser: drive a real Chrome browser via the agent-browser CLI",
            parameters: Type.Object({
              args: Type.Array(Type.String(), {
                description:
                  'agent-browser arguments, one per element, for example ["snapshot", "-i", "-c", "--json"].',
              }),
              stdin: Type.Optional(
                Type.String({
                  description: "Text piped to the command's stdin. Used for the batch command's JSON array.",
                }),
              ),
              timeout_ms: Type.Optional(
                Type.Number({ description: `Timeout in milliseconds, default ${DEFAULT_TIMEOUT_MS}` }),
              ),
            }),
            execute: async (_toolCallId, params, signal) => {
              if (params.args.length === 0) {
                throw new Error("Refused: args must name an agent-browser command.");
              }
              const refusal = await agentBrowserRefusal(
                params.args,
                params.stdin,
                { blockPrivateNetwork: ctx.config.blockPrivateNetwork },
                ctx.workspaceDir,
              );
              if (refusal !== undefined) throw new Error(refusal);

              assertAgentBrowserInstalled(ctx.config);

              const timeoutMs = Math.min(
                Math.max(params.timeout_ms ?? DEFAULT_TIMEOUT_MS, 1_000),
                MAX_TIMEOUT_MS,
              );
              const run = await runAgentBrowser(ctx.config, [...params.args], {
                session: sessionName,
                cwd: ctx.workspaceDir,
                timeoutMs,
                ...(params.stdin !== undefined ? { input: params.stdin } : {}),
                ...(signal !== undefined ? { signal } : {}),
              });

              const stderr = run.stderr.trim();
              const text = run.stdout.trim() === "" && stderr === "" ? "(no output)" : run.stdout;
              return {
                content: [
                  { type: "text" as const, text: stderr === "" ? text : `${text}\n\n[stderr]\n${stderr}` },
                ],
                details: { args: params.args, elapsedMs: run.elapsedMs },
              };
            },
          }),
        );

        // Cleanup is unconditional and best-effort: closing a session that never
        // opened is a no-op, which is cheaper than tracking whether Chrome
        // actually started.
        onShutdownOnce(pi, async () => {
          await closeAgentBrowserSession(ctx.config, sessionName);
        });
      },
    };
  },
};
