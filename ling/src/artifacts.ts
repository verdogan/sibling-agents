import { createHash } from "node:crypto";
import { constants as fsConstants, type Dirent, realpath as realpathCallback, type Stats } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { openRegularFile } from "./guards.js";
import type { TaskRecord } from "./queue.js";

export const MAX_TASK_ARTIFACT_FILES = 20;
export const MAX_TASK_ARTIFACT_BYTES = 256 * 1024;

export interface TaskArtifactFile {
  path: string;
  size: number;
  sha256: string;
}

export interface TaskArtifactListing {
  files: TaskArtifactFile[];
  totalBytes: number;
  nextCursor?: string;
}

export class TaskArtifactError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TaskArtifactError";
  }
}

function portableRelative(value: string): string {
  const normalized = path.posix.normalize(value);
  if (
    value.trim() === "" ||
    value.length > 240 ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== value
  ) {
    throw new TaskArtifactError(400, "Artifact path must be normalized, relative and POSIX.");
  }
  if (normalized === "result.json" || normalized === "events.jsonl") {
    throw new TaskArtifactError(404, "Operational files are not task artifacts.");
  }
  return normalized;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/**
 * Enumerate a bounded, immutable transfer view of a task workspace. Symlinks
 * and operational result/event files are never exposed.
 */
export async function listTaskArtifacts(
  task: TaskRecord,
  options: { cursor?: string; limit?: number } = {},
): Promise<TaskArtifactListing> {
  let workspaceReal: string;
  try {
    workspaceReal = await realpath(task.workspaceDir);
  } catch (error) {
    throw new TaskArtifactError(
      404,
      `Workspace for task ${task.id} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const files: TaskArtifactFile[] = [];
  let totalBytes = 0;
  let nextCursor: string | undefined;
  let stopped = false;
  const cursor =
    options.cursor === undefined || options.cursor === ""
      ? undefined
      : portableRelative(options.cursor);
  let pastCursor = cursor === undefined;
  const limit = Math.min(
    MAX_TASK_ARTIFACT_FILES,
    Math.max(1, Math.floor(options.limit ?? MAX_TASK_ARTIFACT_FILES)),
  );
  const seededPaths = new Set(Object.keys(task.seedFiles ?? {}).map((name) => name.replaceAll("\\", "/")));

  async function walk(directory: string, prefix: string): Promise<void> {
    if (stopped) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (stopped) return;
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (relative === "result.json" || relative === "events.jsonl") continue;
      if (seededPaths.has(relative)) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(candidate, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      const safePath = portableRelative(relative);
      if (!pastCursor) {
        if (safePath === cursor) pastCursor = true;
        continue;
      }
      const candidateReal = await realpath(candidate);
      if (!inside(workspaceReal, candidateReal)) continue;
      const stats = await lstat(candidateReal);
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      if (stats.size > MAX_TASK_ARTIFACT_BYTES) continue;
      if (
        files.length >= limit ||
        totalBytes + stats.size > MAX_TASK_ARTIFACT_BYTES
      ) {
        nextCursor = files.at(-1)?.path ?? cursor;
        stopped = true;
        return;
      }
      const bytes = await readFile(candidateReal);
      if (bytes.byteLength !== stats.size) {
        throw new TaskArtifactError(409, `Artifact ${safePath} changed while it was listed.`);
      }
      files.push({
        path: safePath,
        size: stats.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      totalBytes += stats.size;
    }
  }

  await walk(workspaceReal, "");
  return {
    files,
    totalBytes,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export async function readTaskArtifact(
  task: TaskRecord,
  requestedPath: string,
): Promise<{ file: TaskArtifactFile; bytes: Buffer }> {
  const safePath = portableRelative(requestedPath);
  const seededPaths = new Set(
    Object.keys(task.seedFiles ?? {}).map((name) => name.replaceAll("\\", "/")),
  );
  if (seededPaths.has(safePath)) {
    throw new TaskArtifactError(404, `No such task artifact: ${safePath}`);
  }
  const workspaceReal = await realpath(task.workspaceDir);
  const candidate = path.resolve(workspaceReal, ...safePath.split("/"));
  let candidateReal: string;
  try {
    candidateReal = await realpath(candidate);
  } catch {
    throw new TaskArtifactError(404, `No such task artifact: ${safePath}`);
  }
  if (!inside(workspaceReal, candidateReal)) {
    throw new TaskArtifactError(400, "Artifact resolves outside the task workspace.");
  }
  const stats = await lstat(candidateReal);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new TaskArtifactError(404, `No such task artifact: ${safePath}`);
  }
  if (stats.size > MAX_TASK_ARTIFACT_BYTES) {
    throw new TaskArtifactError(
      413,
      `Artifact ${safePath} exceeds ${MAX_TASK_ARTIFACT_BYTES} transferable bytes.`,
    );
  }
  const bytes = await readFile(candidateReal);
  if (bytes.byteLength !== stats.size) {
    throw new TaskArtifactError(409, "Artifact changed while it was being read.");
  }
  const file = {
    path: safePath,
    size: stats.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return { file, bytes };
}

// ------------------------------------------------------------ final state

export const FINAL_STATE_VERSION = 1;
/** A file's content is kept only at or below this size. */
export const FINAL_STATE_MAX_CONTENT_BYTES = 16 * 1024;
/** All kept content together, seeds and files, stays within this. */
export const FINAL_STATE_CONTENT_BUDGET_BYTES = 1024 * 1024;
/** Entries in `files`; past this, `filesOmitted` counts the rest. */
export const FINAL_STATE_MAX_FILES = 20_000;
/** result.json's raw content is kept up to the size write_result allows. */
export const FINAL_STATE_MAX_RESULT_BYTES = 256 * 1024;

type ContentOmitted = "none" | "too_large" | "binary" | "budget";

export interface FinalStateSeed {
  /** The seed's key, as a POSIX path relative to the workspace. */
  path: string;
  /** The sha256 of the content the task was seeded with. */
  seededSha256: string;
  /**
   * `not_regular`: the path, or a directory on the way to it, is a link, or
   * the path is something other than a regular file. No target is read.
   * `unreadable`: a regular file, or what is on the way to one, that could
   * not be examined or read, so whether the seed changed is unknown.
   */
  state: "unchanged" | "changed" | "absent" | "not_regular" | "unreadable";
  /** Null unless the state is `unchanged` or `changed`. */
  sha256: string | null;
  /** The bytes read; where none were, what lstat said, or 0 when nothing at the path was examined. */
  size: number;
  content: string | null;
  /** Why an `unchanged` or `changed` seed has no content. `none` for every other state. */
  contentOmitted: ContentOmitted;
}

export interface FinalStateFile {
  /** A POSIX path relative to the workspace; `.` is the workspace itself. */
  path: string;
  /**
   * `directory` only for one that could not be listed: it is `unreadable`,
   * and what is below it is unknown.
   */
  type: "file" | "symlink" | "directory";
  /** Null for a symlink, since links are never followed, and for anything unreadable. */
  sha256: string | null;
  /** The bytes read; where none were, what lstat said, or 0 when even that failed. */
  size: number;
  content: string | null;
  /** `unreadable`: a file that could not be read, or a directory that could not be listed. */
  contentOmitted: ContentOmitted | "symlink" | "unreadable";
}

export interface FinalStateResult {
  /**
   * False only when nothing is at result.json. One that is there but was not
   * read, because it is a link, not a regular file or could not be read, is
   * present with no hash and no content, as the runner refuses it.
   */
  present: boolean;
  sha256: string | null;
  /** The bytes read; where none were, what lstat said, or 0. */
  size: number;
  /** The raw bytes as text, when they are valid UTF-8 within the size write_result allows. */
  content: string | null;
}

/**
 * What a task left in its workspace, recorded after it ended: `GET
 * /tasks/:id/final-state`. A measurement reads this rather than what the task
 * claims, because the claims are the task's and the record is not.
 */
export interface TaskFinalState {
  version: typeof FINAL_STATE_VERSION;
  taskId: string;
  workspaceDir: string;
  /**
   * The workspace's real path, from the native resolver, so a short or linked
   * path to it reads as the long one. Its own name is never resolved: a
   * workspace replaced by a link is that link's path, not its target's.
   */
  workspaceDirReal: string;
  capturedAt: string;
  /**
   * The sha256 of the task's rendered system prompt with its workspace path
   * replaced by `<workspace>`. Null until the runner computes it.
   */
  promptDigest: string | null;
  seeds: FinalStateSeed[];
  files: FinalStateFile[];
  filesOmitted: number;
  result: FinalStateResult;
}

const nativeRealpath = promisify(realpathCallback.native);
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const READ_CHUNK_BYTES = 64 * 1024;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The text of `bytes` if they are valid UTF-8, a byte order mark kept; otherwise undefined. */
function utf8(bytes: Uint8Array): string | undefined {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Nothing is at the path: it, or a directory on the way to it, is gone. */
function isGone(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** What lstat says is at a path now, without following a link at its last component. */
type Found =
  | { kind: "gone" }
  | { kind: "unknown"; size: 0 }
  | { kind: "link" | "file" | "directory" | "other"; size: number };

async function examine(full: string): Promise<Found> {
  let stats: Stats;
  try {
    stats = await lstat(full);
  } catch (error) {
    return isGone(error) ? { kind: "gone" } : { kind: "unknown", size: 0 };
  }
  const kind = stats.isSymbolicLink() ? "link" : stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other";
  return { kind, size: stats.size };
}

/**
 * Hash a regular file without following a link at its last component, and
 * keep its bytes when they are at most `keepBytes`. The size is what was read,
 * so the hash and the size always describe the same bytes.
 */
async function readRegular(
  file: string,
  keepBytes: number,
): Promise<{ sha256: string; size: number; bytes: Buffer | undefined }> {
  const handle = await openRegularFile(file, fsConstants.O_RDONLY);
  try {
    const hash = createHash("sha256");
    const kept: Buffer[] = [];
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (size + bytesRead <= keepBytes) kept.push(Buffer.from(chunk));
      size += bytesRead;
    }
    return { sha256: hash.digest("hex"), size, bytes: size <= keepBytes ? Buffer.concat(kept) : undefined };
  } finally {
    await handle.close();
  }
}

/** The content budget, spent in the order it is asked: the seeds, then the files by depth and path. */
class ContentBudget {
  private remaining = FINAL_STATE_CONTENT_BUDGET_BYTES;

  keep(bytes: Buffer | undefined, size: number): { content: string | null; contentOmitted: ContentOmitted } {
    if (size > FINAL_STATE_MAX_CONTENT_BYTES || bytes === undefined) {
      return { content: null, contentOmitted: "too_large" };
    }
    const text = utf8(bytes);
    if (text === undefined) return { content: null, contentOmitted: "binary" };
    if (size > this.remaining) return { content: null, contentOmitted: "budget" };
    this.remaining -= size;
    return { content: text, contentOmitted: "none" };
  }
}

/**
 * What is at a seed's path now, read without following a link anywhere on
 * the way: each component is examined with lstat, so a directory replaced by
 * a link makes the seed `not_regular` rather than a door to the link's target.
 * Inside a workspace that is itself a link (`inLink`), every seed is.
 * Something that cannot be examined or read makes it `unreadable`, and the
 * rest of the record stands.
 */
async function seedState(
  root: string,
  name: string,
  content: string,
  budget: ContentBudget,
  inLink: boolean,
): Promise<FinalStateSeed> {
  const resolved = path.resolve(root, name);
  const relative = path.relative(root, resolved);
  const components = relative.split(path.sep);
  const base = { path: components.join("/"), seededSha256: sha256(Buffer.from(content, "utf8")) };
  const unread = (state: "absent" | "not_regular" | "unreadable", size = 0): FinalStateSeed => ({
    ...base,
    state,
    sha256: null,
    size,
    content: null,
    contentOmitted: "none",
  });
  if (relative === "" || path.isAbsolute(relative) || components[0] === "..") return unread("absent");
  if (inLink) return unread("not_regular");
  let current = root;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const found = await examine(current);
    if (found.kind === "gone") return unread("absent");
    if (found.kind === "unknown") return unread("unreadable");
    if (index < components.length - 1) {
      if (found.kind === "link") return unread("not_regular");
      if (found.kind !== "directory") return unread("absent");
    } else if (found.kind !== "file") {
      return unread("not_regular", found.size);
    }
  }
  let read;
  try {
    read = await readRegular(resolved, FINAL_STATE_MAX_CONTENT_BYTES);
  } catch {
    // Replaced between the lstat and the open, or a file that cannot be read.
    const found = await examine(resolved);
    if (found.kind === "gone") return unread("absent");
    if (found.kind === "file" || found.kind === "unknown") return unread("unreadable", found.size);
    return unread("not_regular", found.size);
  }
  return {
    ...base,
    state: read.sha256 === base.seededSha256 ? "unchanged" : "changed",
    sha256: read.sha256,
    size: read.size,
    ...budget.keep(read.bytes, read.size),
  };
}

/**
 * result.json's raw bytes, read as the runner reads the file: never through a
 * link. Only nothing at the path is `present: false`.
 */
async function resultState(root: string): Promise<FinalStateResult> {
  const file = path.join(root, "result.json");
  const missing: FinalStateResult = { present: false, sha256: null, size: 0, content: null };
  const unread = (size: number): FinalStateResult => ({ present: true, sha256: null, size, content: null });
  const found = await examine(file);
  if (found.kind === "gone") return missing;
  if (found.kind !== "file") return unread(found.size);
  let read;
  try {
    read = await readRegular(file, FINAL_STATE_MAX_RESULT_BYTES);
  } catch {
    const now = await examine(file);
    return now.kind === "gone" ? missing : unread(now.size);
  }
  return {
    present: true,
    sha256: read.sha256,
    size: read.size,
    content: read.bytes === undefined ? null : (utf8(read.bytes) ?? null),
  };
}

/** A `files` entry with no hash and no content. */
function unreadEntry(
  relative: string,
  type: FinalStateFile["type"],
  size: number,
  contentOmitted: "symlink" | "unreadable",
): FinalStateFile {
  return { path: relative, type, sha256: null, size, content: null, contentOmitted };
}

/**
 * The `files` entry for something listed as a file or a link, from what is
 * there when it is read. A file that cannot be read is `unreadable`. Nothing
 * is recorded for one that went away, or became neither a file nor a link,
 * since it was listed.
 */
async function fileEntry(
  full: string,
  relative: string,
  listedAsLink: boolean,
  budget: ContentBudget,
): Promise<FinalStateFile | undefined> {
  if (!listedAsLink) {
    try {
      const read = await readRegular(full, FINAL_STATE_MAX_CONTENT_BYTES);
      return { path: relative, type: "file", sha256: read.sha256, size: read.size, ...budget.keep(read.bytes, read.size) };
    } catch {
      // Gone, replaced or unreadable: what is there now says which.
    }
  }
  const found = await examine(full);
  if (found.kind === "gone") return undefined;
  if (found.kind === "link" || listedAsLink) return unreadEntry(relative, "symlink", found.size, "symlink");
  if (found.kind === "file" || found.kind === "unknown") return unreadEntry(relative, "file", found.size, "unreadable");
  return undefined;
}

/** A directory the walk did not list, and why: a link now at its name, not listable, or gone. */
type Unlisted = { entry: "link" | "unreadable" | "gone"; size: number };

/**
 * List a directory the walk reached, unless it is no longer the one its
 * parent listed. Its real path must still be its path in the workspace once
 * it has been listed, or the listing is dropped, so a directory replaced by a
 * link since its parent was read, or one with a link put on the way to it, is
 * not walked: a link at its own name is recorded as that link. One that
 * cannot be listed, or cannot be shown to be the workspace's own, is
 * `unreadable`. One that is no longer a directory is left out, as a file that
 * went away is.
 */
async function listDirectory(full: string): Promise<{ entries: Dirent[] } | Unlisted> {
  try {
    const entries = await readdir(full, { withFileTypes: true });
    if ((await nativeRealpath(full)) === full) return { entries };
  } catch {
    // What is there now says why.
  }
  const found = await examine(full);
  if (found.kind === "link") return { entry: "link", size: found.size };
  if (found.kind === "directory" || found.kind === "unknown") return { entry: "unreadable", size: found.size };
  return { entry: "gone", size: 0 };
}

/**
 * Record a task's workspace as the task left it (`TaskFinalState`). The
 * route serves it only for a task that has ended.
 *
 * - `seeds` has an entry for every key of the task's seed files, `campaign/`
 *   files included: the seeded hash beside what is there now.
 * - `files` lists every other regular file and symlink, result.json aside,
 *   each with its type, size and hash. Links are never followed and their
 *   targets never read, so a symlink has no hash and no content.
 * - Content is kept for a file of at most 16 KiB that is valid UTF-8, within
 *   1 MiB in all. The budget is spent on the seeds first, then on the files
 *   by depth, top level first, and by path within a depth. A file whose
 *   content no longer fits is `budget`, and a later, smaller one may still
 *   fit, so a tree the task builds deep in the workspace, such as
 *   `node_modules/`, costs the top-level files nothing.
 * - Past 20 000 entries the rest are only counted, in `filesOmitted`, the
 *   deepest first by the same order. That guards against a pathological
 *   tree; it is not a working limit.
 * - `result` carries result.json's raw bytes, which the task's parsed result
 *   does not: there, invalid JSON keeps only its first 4 000 characters.
 *
 * No one entry fails the record, because what a task did to its workspace
 * must not decide whether there is a record of what it did. A file that
 * cannot be read is listed with no hash, `unreadable`. A directory that cannot
 * be listed is a `directory` entry, `unreadable`, and what is below it is
 * unknown. A seed that cannot be read is `unreadable`, and a result.json that
 * is there but was not read is present with no hash. A reader takes each as
 * unknown. Only a workspace that is gone, or is neither a directory nor a
 * link, gives no record, and the route answers 404.
 *
 * Links are never followed where this can tell. The workspace's own name is
 * examined with lstat, so a workspace replaced by a link is recorded as that
 * link, `.`, with every seed `not_regular` and result.json present but unread,
 * and is not walked at its target. A directory's listing is kept only if its
 * real path is still its path in the workspace once it has been listed
 * (`listDirectory`), and a file is opened refusing a link at its last
 * component. What is left is a race: a process
 * the task left running that swaps a directory on the way to a file for a
 * link, after the directory was listed and before the file is opened, has
 * that open follow it.
 *
 * Nothing here is atomic. Such a process could also change a file while it is
 * read; its entry then describes the bytes that were read, hash and size
 * together.
 *
 * `maxFiles` lowers the entry limit, so a check can reach it without
 * writing 20 000 files; the route never passes it.
 */
export async function readTaskFinalState(
  task: TaskRecord,
  options: { maxFiles?: number } = {},
): Promise<TaskFinalState> {
  const capturedAt = new Date().toISOString();
  const maxFiles = Math.min(FINAL_STATE_MAX_FILES, options.maxFiles ?? FINAL_STATE_MAX_FILES);
  const unavailable = (why: string) =>
    new TaskArtifactError(404, `Workspace for task ${task.id} is unavailable: ${why}`);
  // The directory that holds the workspace is resolved, short names and all;
  // the workspace's own name is not, so a link there is seen as one.
  let root: string;
  try {
    root = path.join(await nativeRealpath(path.dirname(task.workspaceDir)), path.basename(task.workspaceDir));
  } catch (error) {
    throw unavailable(error instanceof Error ? error.message : String(error));
  }
  const found = await examine(root);
  if (found.kind !== "directory" && found.kind !== "link") {
    throw unavailable(found.kind === "gone" ? "it is gone" : "it is not a directory that can be examined");
  }
  const inLink = found.kind === "link";
  const budget = new ContentBudget();

  const seeds: FinalStateSeed[] = [];
  for (const [name, content] of Object.entries(task.seedFiles ?? {})) {
    seeds.push(await seedState(root, name, content, budget, inLink));
  }
  const seeded = new Set(seeds.map((seed) => seed.path));

  const files: FinalStateFile[] = [];
  let filesOmitted = 0;
  /** Record a directory that was not listed in its place in the order: its link, `unreadable`, or nothing. */
  const unlisted = (relative: string, why: Unlisted): void => {
    if (why.entry === "gone" || relative === "result.json" || seeded.has(relative)) return;
    if (files.length >= maxFiles) {
      filesOmitted += 1;
      return;
    }
    files.push(
      why.entry === "link"
        ? unreadEntry(relative, "symlink", why.size, "symlink")
        : unreadEntry(relative, "directory", why.size, "unreadable"),
    );
  };
  type Listed = { relative: string; entry: Dirent };
  const add = (to: Listed[], directory: string, entries: Dirent[]): void => {
    for (const entry of entries) to.push({ relative: directory === "" ? entry.name : `${directory}/${entry.name}`, entry });
  };

  // Breadth first, one depth at a time, each depth sorted by path: the order
  // the budget and the entry limit are spent in. A directory is listed when
  // its entry is reached in that order, so one that is not listed takes its
  // place there, and a link in a listing is recorded, never walked.
  let level: Listed[] = [];
  const top = inLink ? ({ entry: "link", size: found.size } as const) : await listDirectory(root);
  if ("entries" in top) add(level, "", top.entries);
  else unlisted(".", top.entry === "gone" ? { entry: "unreadable", size: 0 } : top);
  while (level.length > 0) {
    level.sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0));
    const next: Listed[] = [];
    for (const { relative, entry } of level) {
      const full = path.join(root, ...relative.split("/"));
      if (entry.isDirectory()) {
        const listing = await listDirectory(full);
        if ("entries" in listing) add(next, relative, listing.entries);
        else unlisted(relative, listing);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (relative === "result.json" || seeded.has(relative)) continue;
      if (files.length >= maxFiles) {
        filesOmitted += 1;
        continue;
      }
      const listed = await fileEntry(full, relative, entry.isSymbolicLink(), budget);
      if (listed !== undefined) files.push(listed);
    }
    level = next;
  }

  return {
    version: FINAL_STATE_VERSION,
    taskId: task.id,
    workspaceDir: task.workspaceDir,
    workspaceDirReal: root,
    capturedAt,
    promptDigest: null,
    seeds,
    files,
    filesOmitted,
    // Behind a workspace that is a link, result.json is not looked for.
    result: inLink ? { present: true, sha256: null, size: 0, content: null } : await resultState(root),
  };
}
