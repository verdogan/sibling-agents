import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { lstat, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { AnyToolDefinition } from "./tools/types.js";

/**
 * Shell patterns refused outright.
 *
 * This catches an agent misstep, not a determined attacker: anything holding a
 * shell can evade a denylist. The actual boundary is the VM, and later the
 * per-task container wired through the bash spawnHook.
 */
const refusedCommandPatterns: readonly RegExp[] = [
  /\brm\s+(?:-[a-zA-Z]+\s+)*\/\*?(?:\s|$)/,
  /\bmkfs(?:\.\w+)?\b/,
  /\bdd\b[^|;]*\bof=\/dev\//,
  /\b(?:shutdown|reboot|halt|poweroff|init\s+0)\b/,
  /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/,
  /\bchmod\s+(?:-[a-zA-Z]+\s+)*777\s+\/\*?(?:\s|$)/,
  /\b(?:curl|wget)\b[^|;]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/,
  /\bsudo\b/,
  /\b(?:useradd|userdel|usermod|passwd|visudo)\b/,
  /\/etc\/(?:passwd|shadow|sudoers)\b/,
  /\bcrontab\b/,
  /\bnpm\s+publish\b/,
  /\bgit\s+push\b[^|;]*--force\b/,
];

/**
 * Shells out to agent-browser instead of calling the agent_browser tool. The
 * tool is the only path that gets the pinned binary, the per-task session, and
 * the output limits, so this redirects rather than letting the command fail
 * obscurely. A missed match costs nothing: without the injected environment the
 * command cannot find the binary.
 */
const agentBrowserViaShell = /\bAGENT_BROWSER_BIN\b|\b(?:npx\s+)?agent-browser\b/;

export class GuardViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardViolation";
  }
}

/**
 * Resolve a caller-supplied path, refusing anything that leaves the given root.
 * `label` names the root in the refusal, since this guards the auth directory as
 * well as task workspaces and the message is read by both models and operators.
 *
 * Lexical only: it never touches the filesystem, so a symlink or junction inside
 * the root is judged by its name rather than by where it leads. That is right
 * for paths the service itself chose, and wrong for anything a task can shape.
 * Those go through `resolveInsideWorkspaceReal`.
 */
export function resolveInsideWorkspace(
  workspaceDir: string,
  candidate: string,
  label = "this task's workspace",
): string {
  const root = path.resolve(workspaceDir);
  const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new GuardViolation(`Refused: ${candidate} is outside ${label}. Work only inside ${root}.`);
  }
  return resolved;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Where a path really leads: the realpath of its deepest existing ancestor, with
 * the part that does not exist yet appended.
 *
 * The tail matters because the file tools create files. `write j/new.txt` names
 * nothing that exists, but if `j` is a junction it lands wherever `j` points, so
 * the ancestor has to be resolved even when the path itself cannot be.
 *
 * A component that realpath cannot resolve but lstat can see is a dangling link.
 * Writing through one creates its target, wherever that is, and nothing here can
 * say where it would be, so it is refused rather than treated as absent.
 */
function realLocation(target: string): string {
  const tail: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...tail);
    } catch (error) {
      if (!isMissing(error)) throw error;
      let entry: ReturnType<typeof lstatSync> | undefined;
      try {
        entry = lstatSync(current);
      } catch (lstatError) {
        if (!isMissing(lstatError)) throw lstatError;
      }
      if (entry?.isSymbolicLink()) {
        throw new GuardViolation(
          `Refused: ${current} is a symbolic link or junction whose target does not exist, so where it would lead cannot be checked.`,
        );
      }
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...tail);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * `resolveInsideWorkspace`, and then the same question asked of where the path
 * actually leads once every symlink and junction on the way is followed.
 *
 * The lexical check alone let a link made with `bash` carry the in-process file
 * tools anywhere: `ln -s ~ home` then `read home/.ssh/id_rsa` names a path inside
 * the workspace and opens one outside it. In docker mode that is the whole hole,
 * because the shell is confined to the container and the file tools are not —
 * they run in the service, on the host.
 *
 * It judges the path it is given. Guarding a tool means handing it the path the
 * tool will open, which for Pi's tools is not the text the model sent; see
 * `checkToolCall`.
 *
 * Returns the lexical path, since that is what the caller will hand to the tool.
 * The check is a check, not a capability: a shell running alongside can still
 * swap a link in between this call and the tool's own open, and in docker mode
 * that shell is the container, so the container does not close it. Closing it
 * needs every component opened without following links, which neither Node nor
 * Pi's tools offer. What this removes is the plain, unraced case.
 */
export function resolveInsideWorkspaceReal(
  workspaceDir: string,
  candidate: string,
  label = "this task's workspace",
): string {
  const lexical = resolveInsideWorkspace(workspaceDir, candidate, label);
  const root = realLocation(path.resolve(workspaceDir));
  const real = realLocation(lexical);
  const relative = path.relative(root, real);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new GuardViolation(
      `Refused: ${candidate} leads through a symbolic link or junction to somewhere outside ${label}. Work only inside ${path.resolve(workspaceDir)}.`,
    );
  }
  return lexical;
}

/** Why a path is refused under `root`, or undefined when it is confined there. */
function confinementRefusal(root: string, candidate: string, label?: string): string | undefined {
  try {
    resolveInsideWorkspaceReal(root, candidate, label);
    return undefined;
  } catch (error) {
    if (error instanceof GuardViolation) return error.message;
    // An unreadable ancestor or a link loop: where the path leads is unknown,
    // which is a refusal, not a pass.
    const message = error instanceof Error ? error.message : String(error);
    return `Refused: ${candidate} could not be resolved (${message}).`;
  }
}

/**
 * Pi's file tools do not open the path they are given. Each runs it through
 * Pi's `normalizePath` first, and confinement has to judge what comes out, not
 * what went in: a junction named `a b` is reached by `a\u00A0b`, a name that
 * exists nowhere and so would pass as a new file inside the workspace.
 *
 * In Pi's order: the Unicode spaces below become ASCII spaces, one leading `@`
 * is stripped, and on Windows a Git Bash, MSYS or WSL drive path (`/c/...`,
 * `/mnt/c/...`) becomes `C:\...`. `toolPathText` repeats those three. After
 * them, `~` would become the service user's home and a `file:` URL the path it
 * names; those two are refused rather than repeated (`toolExpandedPrefix`).
 *
 * This is a copy of Pi's code (1.0.3, `dist/utils/paths.js`), not a call into
 * it, because Pi does not export it. A copy falls behind silently, so check.ts
 * pins the source it was taken from: a Pi upgrade that changes how a tool
 * rewrites its path fails the offline check until this has been compared again.
 */
const toolUnicodeSpaces = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function windowsShellPath(candidate: string): string {
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) {
    return candidate;
  }
  const match = candidate.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return candidate;
  return `${match[1]!.toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

function toolPathText(candidate: string): string {
  let text = candidate.replace(toolUnicodeSpaces, " ");
  if (text.startsWith("@")) text = text.slice(1);
  if (process.platform === "win32") text = windowsShellPath(text);
  return text;
}

/**
 * The expansions refused rather than repeated, tested after `toolPathText`, so
 * `@~/x` is refused like `~/x`. Confinement used to judge `~/.ssh/id_rsa` as a
 * directory called `~` inside the workspace, which the tool then opened in the
 * home directory. Where either leads depends on the service's environment, not
 * the task's, and nothing a task needs is reached that way. A bare leading `~`
 * is refused even where Pi would leave it alone (`~x`), which costs nothing.
 */
const toolExpandedPrefix = /^(?:~|file:)/i;

/**
 * The other names `read` may open for one path. When the path it resolved does
 * not exist, Pi's read tool tries macOS spellings of it — a narrow no-break
 * space before AM/PM, NFD, a curly apostrophe, and NFD with a curly apostrophe
 * — and opens the first that does exist, so `x'y/secret.txt` reads through a
 * junction named `x’y`. The other tools resolve the one path only.
 *
 * Pi's order is kept: none of them is asked about while the path as resolved
 * exists, since Pi then opens it and nothing else. That matters on macOS, whose
 * file system ignores normalization in lookups, so the NFD spelling of every
 * existing path exists too; judged lexically against a workspace path such as
 * `/Users/José/...`, it would refuse every read there. Once the path does not
 * exist, every spelling that does is judged, whichever Pi would pick. One that
 * does not exist is never opened, and judging those too would refuse every read
 * in a workspace whose own path has an apostrophe or an accent. Same source,
 * same pin as `toolPathText` (`dist/core/tools/path-utils.js`).
 */
function readSpellings(resolved: string): string[] {
  if (existsSync(resolved)) return [];
  const nfd = resolved.normalize("NFD");
  const curly = (text: string) => text.replace(/'/g, "\u2019");
  return [resolved.replace(/ (AM|PM)\./gi, "\u202F$1."), nfd, curly(resolved), curly(nfd)].filter(
    (spelling, index, all) =>
      spelling !== resolved && all.indexOf(spelling) === index && existsSync(spelling),
  );
}

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

function sameRegularFile(before: BigIntStats | undefined, after: BigIntStats): boolean {
  return (
    after.isFile() &&
    (before === undefined || (before.ino === after.ino && before.dev === after.dev))
  );
}

function notRegular(filePath: string): GuardViolation {
  return new GuardViolation(
    `Refused: ${filePath} is a symbolic link, junction or other non-regular file; it is never followed.`,
  );
}

/**
 * Open a path that must be a regular file, without following a link in its last
 * component.
 *
 * POSIX has `O_NOFOLLOW` and it is used where present. Windows has no such flag,
 * and a plain open follows a junction or symlink, so identity is checked too:
 * lstat describes the entry itself, fstat the file actually opened, and the two
 * must be the same regular file. A link swapped in between the calls makes them
 * differ, so the race fails closed. A missing file is created exclusively, which
 * no planted link can satisfy.
 *
 * Never pass `O_TRUNC`: on Windows the truncation would land before the identity
 * check could refuse it. Replace files with `replaceWorkspaceFile` instead.
 */
export async function openRegularFile(
  filePath: string,
  flags: number,
  mode = 0o600,
): Promise<FileHandle> {
  let before: BigIntStats | undefined;
  try {
    before = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (!isMissing(error) || (flags & fsConstants.O_CREAT) === 0) throw error;
  }
  if (before !== undefined && !before.isFile()) throw notRegular(filePath);
  const handle = await open(
    filePath,
    flags | O_NOFOLLOW | (before === undefined ? fsConstants.O_EXCL : 0),
    mode,
  );
  try {
    if (!sameRegularFile(before, await handle.stat({ bigint: true }))) throw notRegular(filePath);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** `openRegularFile` for the synchronous event-log append. Same rules, same refusals. */
export function openRegularFileSync(filePath: string, flags: number, mode = 0o600): number {
  let before: BigIntStats | undefined;
  try {
    before = lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (!isMissing(error) || (flags & fsConstants.O_CREAT) === 0) throw error;
  }
  if (before !== undefined && !before.isFile()) throw notRegular(filePath);
  const fd = openSync(
    filePath,
    flags | O_NOFOLLOW | (before === undefined ? fsConstants.O_EXCL : 0),
    mode,
  );
  try {
    if (!sameRegularFile(before, fstatSync(fd, { bigint: true }))) throw notRegular(filePath);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * Replace one operational file in a workspace without ever writing through a link.
 *
 * The body goes to a temp file with a random name, created exclusively so nothing
 * planted at that name can be followed, synced, and then renamed over the target.
 * Rename replaces a link rather than writing through it, but on Windows it fails
 * outright against a junction, so a target that exists and is not a regular file
 * is refused up front on every platform: one behaviour, and a refusal the task
 * can read instead of a platform-specific error.
 *
 * The temp name ends in `.tmp` so a leftover from a crash is recognisable.
 */
export async function replaceWorkspaceFile(
  workspaceDir: string,
  fileName: string,
  body: string,
): Promise<void> {
  const directory = resolveInsideWorkspaceReal(workspaceDir, path.dirname(fileName));
  const target = path.join(directory, path.basename(fileName));
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(target);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (existing !== undefined && !existing.isFile()) {
    throw new GuardViolation(
      `Refused: ${fileName} is a symbolic link, junction or directory, not a regular file, so it was not replaced. Remove it and try again.`,
    );
  }
  const temp = path.join(directory, `${path.basename(fileName)}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(
    temp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function assertCommandAllowed(command: string): void {
  for (const pattern of refusedCommandPatterns) {
    if (pattern.test(command)) {
      throw new GuardViolation(
        `Refused: this command matches a blocked pattern (${pattern}). Find another way to accomplish the task.`,
      );
    }
  }
}

/**
 * Wrap a tool so the command denylist holds by construction.
 *
 * The `tool_call` handler is the wider layer: it sees every tool, including ones
 * a feature registers later. But it only runs once extensions are bound, so it
 * is enforced rather than structural. A wrapped tool cannot execute unwrapped,
 * which is the stronger property, so the denylist lives in both places and the
 * shell keeps its guarantee even if extension binding regresses. Path
 * confinement has no such second layer: Pi's tool factories resolve relative
 * paths against the workspace root but accept absolute and `~` paths as given,
 * so the `tool_call` handler is the only thing confining them.
 */
export function guardCommands(tool: AnyToolDefinition): AnyToolDefinition {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const args = params as Record<string, unknown>;
      if (typeof args.command === "string") {
        assertCommandAllowed(args.command);
      }
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

export interface ToolCallPolicy {
  workspaceDir: string;
  /** Directories the model may read from despite sitting outside the workspace. */
  trustedReadRoots: readonly string[];
  /** Whether the agent_browser tool is available to redirect shell attempts to. */
  agentBrowserToolAvailable: boolean;
}

export interface ToolCallDecision {
  block: true;
  reason: string;
}

/**
 * Decide whether a tool call may proceed.
 *
 * Every built-in tool names its path argument `path` and the bash tool names its
 * command `command`, so those two checks cover all of them. Tools that take
 * neither, such as http_request and the browser tools, carry their own
 * validation and pass through here untouched.
 *
 * A path is judged as the tool will open it — after Pi's rewriting, and for
 * `read` in each spelling it may fall back to — with links followed: the file
 * tools run in this process, outside any sandbox, so a link the shell made is
 * the shortest way out of the workspace. That holds only as far as the copy of
 * Pi's rewriting above is faithful (pinned in check.ts) and only in the unraced
 * case (see `resolveInsideWorkspaceReal`). Judging the final path inside the
 * tools, through the `operations` option Pi's file tools accept, would remove
 * the copy; the harness does not pass one yet.
 */
export function checkToolCall(
  toolName: string,
  input: Record<string, unknown>,
  policy: ToolCallPolicy,
): ToolCallDecision | undefined {
  if (typeof input.path === "string") {
    const candidate = toolPathText(input.path);
    if (toolExpandedPrefix.test(candidate)) {
      return {
        block: true,
        reason: `Refused: ${input.path} starts with ~ or file:, which the file tools expand to a place outside this task's control. Use a path relative to ${path.resolve(policy.workspaceDir)}.`,
      };
    }
    // The tools resolve a relative path against the workspace, so the trusted
    // roots, and read's other spellings, are asked about that same location.
    const absolute = path.resolve(policy.workspaceDir, candidate);
    const opened = toolName === "read" ? [candidate, ...readSpellings(absolute)] : [candidate];
    for (const target of opened) {
      const refusal = confinementRefusal(policy.workspaceDir, target);
      if (refusal === undefined) continue;
      const trustedRead =
        toolName === "read" &&
        policy.trustedReadRoots.some(
          (root) => confinementRefusal(root, path.resolve(policy.workspaceDir, target)) === undefined,
        );
      if (!trustedRead) return { block: true, reason: refusal };
    }
  }

  if (typeof input.command === "string") {
    const command = input.command;
    if (policy.agentBrowserToolAvailable && agentBrowserViaShell.test(command)) {
      return {
        block: true,
        reason:
          "Refused: do not launch agent-browser from the shell. Call the agent_browser tool instead; it holds the pinned binary and this task's browser session.",
      };
    }
    try {
      assertCommandAllowed(command);
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  return undefined;
}
