/**
 * Path resolution for the contamination rule (protocol §1.5 item 1, B16, F19)
 * and for every measure that says "paths resolve as in the contamination
 * rule": separators, drive-letter forms (`C:\…`, `/c/…`) and case are
 * normalised; `/tmp` resolves under the child's recorded `tmp` where the shell
 * mounts it on `TEMP` (Git Bash on Windows); an 8.3 component
 * (`ABCDEF~1`) never equals a long one, and `inWorkspaceLoosely` says when it
 * could (the first six letters agree, case-insensitively with spaces
 * dropped), which the bash reader reads as `short_name`; and a drive-relative path
 * (`C:..\x`) resolves as Windows resolves it. Nothing is flagged on sight: a
 * path is tested only after it is resolved.
 */
import type { ChildPaths } from "../records.js";

export interface ChildContext {
  /** `workspaceDir` and `workspaceDirReal`, normalised. */
  workspaces: string[];
  home: string;
  tmp: string;
  userProfile: string;
  /**
   * `home`, `tmp` and `userProfile` as the child's bash holds them in HOME,
   * TMP (TEMP, TMPDIR) and USERPROFILE, for an operator that reads a value's
   * text (`${HOME:0:1}`): on Windows Git Bash's `/c/…` form of the record,
   * which it makes of the first two and not of USERPROFILE; elsewhere the
   * record.
   */
  shell: { home: string; tmp: string; userProfile: string };
  /** Windows paths: drive letters, and `/tmp` mounted on `TEMP`. */
  windows: boolean;
}

const DRIVE = /^([A-Za-z]):(?:[\\/]|$)/;

/** A Windows path as Git Bash spells it: `/` separators, and `C:` as `/c`. */
export function gitBashForm(value: string): string {
  return value.replace(/\\/g, "/").replace(/^([A-Za-z]):(?=\/|$)/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

export function childContext(child: ChildPaths): ChildContext {
  const windows = DRIVE.test(child.workspaceDir) || DRIVE.test(child.workspaceDirReal);
  const norm = (value: string) => normalizePath(value, windows);
  const shell = (value: string) => (windows ? gitBashForm(value) : value);
  return {
    workspaces: [...new Set([norm(child.workspaceDir), norm(child.workspaceDirReal)])],
    home: norm(child.home),
    tmp: norm(child.tmp),
    userProfile: norm(child.userProfile),
    shell: { home: shell(child.home), tmp: shell(child.tmp), userProfile: child.userProfile },
    windows,
  };
}

/** Whether a path, separators normalised, is absolute on the child's platform. */
export function isAbsolutePath(value: string, windows: boolean): boolean {
  const slashed = value.replace(/\\/g, "/");
  return slashed.startsWith("/") || (windows && DRIVE.test(slashed));
}

/**
 * A path in one form: `/` separators, a drive as `c:/`, Git Bash's `/c/` as
 * `c:/`, lower case, and `.` and `..` resolved. A relative path stays relative.
 */
export function normalizePath(value: string, windows: boolean): string {
  let rest = value.replace(/\\/g, "/");
  let root = "";
  if (windows) {
    const drive = /^([A-Za-z]):(\/|$)/.exec(rest) ?? /^\/([A-Za-z])(\/|$)/.exec(rest);
    if (drive !== null) {
      root = `${drive[1]!.toLowerCase()}:/`;
      rest = rest.slice(drive[0].length);
    }
  }
  if (root === "" && rest.startsWith("/")) {
    root = "/";
    rest = rest.slice(1);
  }
  const segments: string[] = [];
  for (const segment of rest.toLowerCase().split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") segments.pop();
      else if (root === "") segments.push("..");
    } else segments.push(segment);
  }
  if (root !== "") return `${root}${segments.join("/")}`;
  return segments.length === 0 ? "." : segments.join("/");
}

/** `C:rel` and bare `C:`: a drive, and a path relative to that drive's working directory. */
const DRIVE_RELATIVE = /^([A-Za-z]):(?![\\/])/;

/**
 * Resolve an expanded path against a working directory (both normalised). On
 * Windows a drive-relative path (`C:..\x`) resolves as Windows resolves it:
 * against the working directory when that is on the same drive; otherwise
 * against a directory of that drive this rule cannot know, read as its root,
 * which lies outside a workspace on another drive.
 */
export function resolveAgainst(value: string, cwd: string, child: ChildContext): string {
  let expanded = value;
  if (child.windows && (expanded === "/tmp" || expanded.startsWith("/tmp/"))) {
    expanded = `${child.tmp}${expanded.slice(4)}`;
  }
  const drive = child.windows ? DRIVE_RELATIVE.exec(expanded) : null;
  if (drive !== null) {
    const letter = drive[1]!.toLowerCase();
    const base = cwd.startsWith(`${letter}:/`) ? cwd : `${letter}:`;
    return normalizePath(`${base}/${expanded.slice(2)}`, true);
  }
  if (isAbsolutePath(expanded, child.windows)) return normalizePath(expanded, child.windows);
  return normalizePath(`${cwd}/${expanded}`, child.windows);
}

function components(normalized: string): string[] {
  const [first, ...rest] = normalized.split("/");
  return [first ?? "", ...rest.filter((segment) => segment !== "")];
}

/** An 8.3 short component matching a long one: its first (up to six) letters, spaces dropped. */
function shortFor(short: string, long: string): boolean {
  const match = /^([^~]{1,6})~\d+(\.[^.]*)?$/.exec(short);
  if (match === null) return false;
  return long.replace(/ /g, "").startsWith(match[1]!.replace(/ /g, ""));
}

/**
 * Components are equal only when they are the same text (design spec §2.3
 * rule 8): sibling run directories share their first six letters, so an 8.3
 * name (`RUNABC~2`) is never read as a long workspace component.
 */
export function componentsEqual(left: string, right: string): boolean {
  return left === right;
}

function looselyEqual(left: string, right: string): boolean {
  return left === right || shortFor(left, right) || shortFor(right, left);
}

/** Whether `inner` is `outer` or lies under it, component by component. */
export function isWithin(inner: string, outer: string, equal = componentsEqual): boolean {
  const a = components(inner);
  const b = components(outer);
  if (b.length > a.length) return false;
  return b.every((segment, index) => equal(a[index]!, segment));
}

export function inWorkspace(resolved: string, child: ChildContext): boolean {
  return child.workspaces.some((workspace) => isWithin(resolved, workspace));
}

/**
 * Whether a path would lie in a workspace if an 8.3 short component matched
 * a long one with the same first letters: such a path is not certainly
 * inside, and not certainly outside either (`short_name`).
 */
export function inWorkspaceLoosely(resolved: string, child: ChildContext): boolean {
  return child.workspaces.some((workspace) => isWithin(resolved, workspace, looselyEqual));
}

/** The workspace-relative form of a resolved path inside it, `/`-separated; else undefined. */
export function workspaceRelative(resolved: string, child: ChildContext): string | undefined {
  for (const workspace of child.workspaces) {
    if (!isWithin(resolved, workspace)) continue;
    const rest = components(resolved).slice(components(workspace).length);
    return rest.join("/");
  }
  return undefined;
}

const DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);
const PI_OUTPUT = /^pi-bash-[0-9a-f]{16}\.log$/;

/**
 * The fixed allowlist (§1.5 item 4): `/dev/null`, `/dev/stdout`, `/dev/stderr`,
 * and this run's own Pi output files, `<child tmp>/pi-bash-<16 hex>.log`,
 * which Pi tells A to read. Another run's output file is not on it.
 */
export function onAllowlist(resolved: string, child: ChildContext): boolean {
  if (DEVICES.has(resolved)) return true;
  const parts = components(resolved);
  const name = parts.at(-1) ?? "";
  if (!PI_OUTPUT.test(name)) return false;
  const directory = parts.slice(0, -1);
  const tmp = components(child.tmp);
  return (
    directory.length === tmp.length &&
    tmp.every((segment, index) => componentsEqual(directory[index]!, segment))
  );
}

export function isDevice(resolved: string): boolean {
  return DEVICES.has(resolved);
}
