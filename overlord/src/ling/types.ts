export type LingTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type LingStopReason =
  | "finished"
  | "max_turns"
  | "max_cost"
  | "timeout"
  | "cancelled"
  | "interrupted"
  | "error";

export type LingThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface LingTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface LingTaskStats {
  turns: number;
  cost: number;
  tokens: LingTokens;
}

export interface LingInlineSkill {
  name: string;
  /** Complete contents of the task-private SKILL.md file. */
  content: string;
}

/**
 * One of the experiment's alternative worker prompts (pilot plan §2.4), by
 * the text it changes: `tools_unrecorded` the L0h opening, `salience_matched`
 * the L1s paragraph, `channel_unprompted` the channel paragraph without its
 * last sentence. Ling owns the texts, and refuses with a 400 a variant whose
 * tools do not fit it; a ling that predates the key refuses it too, so a task
 * that asks for a variant never runs on the standard prompt instead.
 */
export type LingWorkerVariant = "tools_unrecorded" | "salience_matched" | "channel_unprompted";

export interface LingTaskOptions {
  /** Provision/audit match only; Ling does not switch provider per task. */
  provider?: string;
  model?: string;
  thinking?: LingThinkingLevel;
  maxTurns?: number;
  maxWallClockMs?: number;
  maxCostUsd?: number;
  tools?: string[];
  skills?: string[];
  inlineSkills?: LingInlineSkill[];
  instructions?: string;
  /** Sent, and echoed by ling, only when set: unset is the standard worker prompt. */
  variant?: LingWorkerVariant;
}

export interface LingTask {
  id: string;
  requestKey?: string;
  createdBy?: string;
  /** Overlord routing metadata; not emitted by a single Ling worker. */
  workerId?: string;
  status: LingTaskStatus;
  prompt: string;
  options: LingTaskOptions;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  stoppedBy?: LingStopReason;
  result?: unknown;
  error?: string;
  stats?: LingTaskStats;
  artifacts?: string[];
  workspaceDir: string;
  seededFiles: string[];
}

/**
 * An event without its sequence number.
 *
 * Ling's log used to be `workspaces/<id>/events.jsonl`, written by the runner
 * as `{ at, type, data? }` with no `seq`, inside the workspace of the task it
 * described. That file is no longer read by anything here. This shape survives
 * for callers that only need the type and data, and for clients written against
 * the old contract; a log of these cannot be checked for gaps.
 */
export interface LingLogEvent {
  at: string;
  type: string;
  data?: unknown;
}

/**
 * An event as ling's TaskStore assigned it: a 1-based `seq` per task. The SSE
 * stream and `GET /tasks/:id/log` both carry this shape, from the same store
 * append, so the two agree event for event and either can be checked for a gap.
 */
export interface LingEvent extends LingLogEvent {
  seq: number;
}

export type LingPeerMessagePriority = "fyi" | "normal" | "urgent";

/** Authenticated overlord-to-running-task message; Ling deduplicates by id. */
export interface LingPeerMessage {
  id: string;
  thread: string;
  from: string;
  content: string;
  priority: LingPeerMessagePriority;
  sentAt: string;
}

export interface LingPeerMessageResponse {
  accepted: true;
  duplicate: boolean;
}

/**
 * An oversight message as `POST /tasks/:id/oversight` carries it. The kinds,
 * bodies and their bounds are the contract's (reports/oversight-wire.md §5);
 * `campaign/oversight.ts` builds them, and this layer only moves them.
 */
export interface LingOversightMessage {
  id: string;
  thread: string;
  from: "overlord" | "watcher";
  kind: "feed" | "advice" | "caution" | "hold" | "release";
  createdAt: string;
  body: object;
}

export interface LingOversightResponse {
  accepted: true;
  duplicate: boolean;
  kind: LingOversightMessage["kind"];
}

export interface SpawnInput extends LingTaskOptions {
  task: string;
  requestKey?: string;
  storageState?: string;
  files?: Record<string, string>;
}

export interface SpawnResponse {
  id: string;
  requestKey?: string;
  /** Added by the overlord's multi-worker router. */
  workerId?: string;
  status: LingTaskStatus;
  options: LingTaskOptions;
  seededFiles: string[];
}

/**
 * A model's prices, per million tokens, as Pi's registry gives them. A
 * negative price is the registry's mark for one that varies, as a router's
 * does (openrouter/auto's is -1000000), not a price.
 */
export interface LingModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Anything else Pi prices by, such as input-size tiers, passed through unread. */
  [key: string]: unknown;
}

/**
 * The model a ling is configured with, as it resolved it at startup: Pi's
 * registry entry with the ling's model routing applied, and the thinking level
 * the ling runs it at. Values are passed through as the registry has them, and
 * a field the entry does not carry is null. `compat` and `thinkingLevelMap`
 * are Pi's own objects and are passed through unread.
 */
export interface LingResolvedModel {
  provider: string;
  id: string;
  api: string;
  baseUrl: string | null;
  cost: LingModelCost | null;
  compat?: Record<string, unknown> | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  contextWindow: number | null;
  maxTokens: number | null;
  thinking: LingThinkingLevel;
}

export interface LingHealth {
  ok: true;
  workerId?: string;
  queued: number;
  running?: number;
  maxConcurrency?: number;
  /** Optional for compatibility with workers predating capability advertising. */
  provider?: string;
  models?: string[];
  skills?: string[];
  /**
   * The configured model as resolved. Absent on a ling that predates it, and
   * null on one whose configured model did not resolve.
   */
  model?: LingResolvedModel | null;
  capabilities?: {
    inlineSkills?: {
      enabled: boolean;
      maxSkillsPerTask: number;
      maxInlineSkillsPerTask: number;
      maxInlineSkillBytes: number;
      maxInlineSkillsTotalBytes: number;
    };
    /**
     * Present only on a ling that accepts the oversight tools and route. The
     * three durations are that ling's own, and a pair records them.
     */
    oversight?: {
      version: number;
      adviceWaitMs: number;
      watchIdleMs: number;
      maxHoldMs: number;
    };
  };
}

export interface LingTaskList {
  tasks: LingTask[];
}

export interface LingArtifactFile {
  path: string;
  size: number;
  sha256: string;
}

export interface LingArtifactList {
  files: LingArtifactFile[];
  totalBytes: number;
  nextCursor?: string;
}

/**
 * One of a task's seeded files as its workspace held it when the task ended.
 * `unchanged` and `changed` compare the bytes with what was seeded; a path
 * that is now a link or a directory, or has a link on the way to it, is
 * `not_regular`, and is never read. One that could not be examined or read is
 * `unreadable`: whether it changed is unknown.
 *
 * Every `path` in a record, a seed's or a file's, is relative to the workspace
 * and `/`-separated, with no empty, `.` or `..` segment, but for the files
 * entry `.`, the workspace itself. A name may still hold what another platform
 * reads as a separator, a backslash on POSIX say, so a caller that writes
 * entries out checks that each lands inside its own tree.
 */
export interface LingFinalStateSeed {
  path: string;
  seededSha256: string;
  state: "unchanged" | "changed" | "absent" | "not_regular" | "unreadable";
  /** Null unless the path is a regular file that was read. */
  sha256: string | null;
  /**
   * The bytes read, for a regular file. Otherwise what ling saw of the path,
   * if anything: null, or 0, for an absent one.
   */
  size: number | null;
  /** The file's text, when it is valid UTF-8 and fits; otherwise null, and `contentOmitted` says why. */
  content: string | null;
  contentOmitted: "none" | "too_large" | "binary" | "budget";
}

/**
 * Any other regular file or link in the workspace. A link's target is never
 * read. A file that could not be read is `unreadable`, and so is a directory,
 * which is listed only when it could not itself be listed, and what is below
 * it is then unknown. A workspace that is itself a link, or could not be
 * listed, is the one entry `.`.
 */
export interface LingFinalStateFile {
  path: string;
  type: "file" | "symlink" | "directory";
  /** Null for a link, and for whatever is `unreadable`. */
  sha256: string | null;
  size: number;
  content: string | null;
  contentOmitted: "none" | "too_large" | "binary" | "symlink" | "budget" | "unreadable";
}

/**
 * The workspace's result.json, as raw bytes rather than as the parse ling
 * keeps. Something at the path that is not a regular file, a link or a
 * directory, or that could not be read, is `present` with a null `sha256`.
 */
export interface LingFinalStateResult {
  present: boolean;
  sha256: string | null;
  /**
   * The bytes read, for a regular file. Otherwise what ling saw at the path,
   * if anything: null, or 0, when nothing is there.
   */
  size: number | null;
  /** The raw text, when it is valid UTF-8 of at most 256 KiB. */
  content: string | null;
}

/**
 * A terminal task's workspace as `GET /tasks/:id/final-state` records it: every
 * file, each with its hash, and the content of those small enough to fit the
 * record's budget. Every file is listed whatever the budget; past 20 000
 * entries the rest are only counted, in `filesOmitted`.
 */
export interface LingFinalState {
  version: 1;
  taskId: string;
  workspaceDir: string;
  /**
   * The same directory, with links and short names on the way to it resolved.
   * Its own name is not, so a workspace replaced by a link is that link's path.
   */
  workspaceDirReal: string;
  capturedAt: string;
  /**
   * The sha256 of the task's rendered system prompt, with its workspaceDir
   * string replaced by `<workspace>`, so that it does not depend on where the
   * task's workspace was. Null from a ling that does not compute it.
   */
  promptDigest: string | null;
  /** One entry per seeded path, campaign/ files included. */
  seeds: LingFinalStateSeed[];
  files: LingFinalStateFile[];
  filesOmitted: number;
  result: LingFinalStateResult;
}
