import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  CAMPAIGN_SEND_TOOL_NAME,
  MAX_CAMPAIGN_MESSAGE_IDS,
  type CampaignPeerMessage,
  type CampaignPeerMessageListener,
} from "./campaign.js";
import type { ThinkingLevel } from "./config.js";
import type { WorkerVariant } from "./features/oversight.js";
import {
  isOversightTool,
  type OversightMessage,
  type OversightMessageListener,
} from "./oversight.js";
import type { InlineSkill } from "./skills.js";

export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/**
 * Per-task overrides of the service defaults. Budgets here can only tighten
 * what the server was configured with, never loosen it, so a caller cannot
 * raise the ceiling the operator set.
 */
export interface TaskOptions {
  /** Must match this worker's configured provider; it never switches runtime providers. */
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  maxWallClockMs?: number;
  maxCostUsd?: number;
  tools?: string[];
  /** Image-provided skill ids, resolved by the worker rather than as paths. */
  skills?: string[];
  /** Policy-gated complete SKILL.md files. */
  inlineSkills?: InlineSkill[];
  instructions?: string;
  /**
   * A worker prompt variant for an experiment arm (`WORKER_VARIANTS`). Kept
   * only when the request set it, so a task without one echoes no such key
   * to an overlord that parses options strictly.
   */
  variant?: WorkerVariant;
}

export type StopReason =
  | "finished"
  | "max_turns"
  | "max_cost"
  | "timeout"
  | "cancelled"
  | "interrupted"
  | "error";

export interface TaskEvent {
  seq: number;
  at: string;
  type: string;
  data?: unknown;
}

export interface TaskStats {
  turns: number;
  cost: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface TaskOutcome {
  status: "completed" | "failed";
  result?: unknown;
  error?: string;
  stoppedBy: StopReason;
  stats?: TaskStats;
  artifacts?: string[];
  /** The digest of the system prompt the task's model was sent (`promptDigest` in runner.ts). */
  promptDigest?: string;
}

export interface TaskRecord {
  id: string;
  requestKey?: string;
  createdBy: string;
  prompt: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  workspaceDir: string;
  storageState?: string;
  seedFiles?: Record<string, string>;
  options: TaskOptions;
  result?: unknown;
  error?: string;
  stoppedBy?: StopReason;
  stats?: TaskStats;
  artifacts?: string[];
  /**
   * Set once the task has ended, if its model was ever sent a prompt. Served
   * only in its final-state record, never in the task's public form, which an
   * overlord parses strictly.
   */
  promptDigest?: string;
  events: TaskEvent[];
}

export interface CreateTaskInput {
  requestKey?: string;
  createdBy: string;
  prompt: string;
  storageState?: string;
  seedFiles?: Record<string, string>;
  options?: TaskOptions;
}

export type TaskEventListener = (event: TaskEvent) => void;

/**
 * Storage seam between the queue and its persistence. `SQLiteTaskStore` is the only
 * implementation; retention and the queue depend on this interface, not on SQLite.
 */
export interface TaskStore {
  create(input: CreateTaskInput, workspaceDir: string): TaskRecord;
  get(id: string): TaskRecord | undefined;
  getByRequestKey(createdBy: string, requestKey: string): TaskRecord | undefined;
  list(): TaskRecord[];
  counts(): { queued: number; running: number; total: number };
  update(id: string, patch: Partial<TaskRecord>): void;
  appendEvent(id: string, type: string, data?: unknown): TaskEvent | undefined;
  deleteTerminalBefore(cutoffIso: string): TaskRecord[];
  close(): void;
}

/**
 * Events kept per task in the `task_events` table; each append trims the older rows.
 * The full history lives in events.jsonl on disk.
 */
const MAX_RETAINED_EVENTS = 1000;

interface TaskRow {
  id: string;
  request_key: string | null;
  created_by: string;
  prompt: string;
  status: TaskStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  workspace_dir: string;
  storage_state: string | null;
  seed_files_json: string | null;
  options_json: string;
  result_json: string | null;
  error: string | null;
  stopped_by: StopReason | null;
  stats_json: string | null;
  artifacts_json: string | null;
  prompt_digest: string | null;
}

interface EventRow {
  seq: number;
  at: string;
  type: string;
  data_json: string | null;
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson<T>(value: string | null, fallback: T): T {
  return value === null ? fallback : (JSON.parse(value) as T);
}

/**
 * Durable task metadata and event tails. Workspace files remain on disk; this
 * store makes queue identity, request deduplication and restart state durable.
 */
export class SQLiteTaskStore implements TaskStore {
  private readonly db: Database.Database;

  /**
   * `recover` is opt-out for one reason: recovery mutates execution state, marking every
   * running row `interrupted`, and that is only correct when this process is the one
   * taking ownership of the queue. A maintenance command that merely opens the database
   * — `prune-workspaces` did exactly this — would otherwise reach in and interrupt the
   * live tasks of a running worker, whose runners carry on regardless. The API then
   * refuses to cancel them as already terminal, and the overlord starts replacements.
   */
  constructor(
    readonly dbPath: string,
    options: { recover?: boolean } = {},
  ) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrateGlobalRequestKeys();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        request_key TEXT,
        created_by TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        workspace_dir TEXT NOT NULL,
        storage_state TEXT,
        seed_files_json TEXT,
        options_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        stopped_by TEXT,
        stats_json TEXT,
        artifacts_json TEXT,
        prompt_digest TEXT
      );
      CREATE INDEX IF NOT EXISTS tasks_created_at ON tasks(created_at);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_caller_request_key
        ON tasks(created_by, request_key)
        WHERE request_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS task_events (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        data_json TEXT,
        PRIMARY KEY(task_id, seq)
      );
    `);
    this.addPromptDigestColumn();
    if (options.recover !== false) this.recoverInterrupted();
  }

  create(input: CreateTaskInput, workspaceDir: string): TaskRecord {
    if (input.requestKey !== undefined) {
      const existing = this.getByRequestKey(input.createdBy, input.requestKey);
      if (existing !== undefined) return existing;
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    try {
      this.db
        .prepare(`
          INSERT INTO tasks (
            id, request_key, created_by, prompt, status, created_at,
            workspace_dir, storage_state, seed_files_json, options_json
          ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          input.requestKey ?? null,
          input.createdBy,
          input.prompt,
          createdAt,
          workspaceDir,
          input.storageState ?? null,
          json(input.seedFiles),
          JSON.stringify(input.options ?? {}),
        );
    } catch (error) {
      if (input.requestKey !== undefined) {
        const existing = this.getByRequestKey(input.createdBy, input.requestKey);
        if (existing !== undefined) return existing;
      }
      throw error;
    }
    const created = this.get(id);
    if (created === undefined) throw new Error(`Unable to reload newly-created task ${id}.`);
    return created;
  }

  get(id: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | TaskRow
      | undefined;
    return row === undefined ? undefined : this.mapTask(row);
  }

  getByRequestKey(createdBy: string, requestKey: string): TaskRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE created_by = ? AND request_key = ?")
      .get(createdBy, requestKey) as TaskRow | undefined;
    return row === undefined ? undefined : this.mapTask(row);
  }

  list(): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks ORDER BY created_at, id")
      .all() as unknown as TaskRow[];
    return rows.map((row) => this.mapTask(row));
  }

  counts(): { queued: number; running: number; total: number } {
    const row = this.db
      .prepare(`
        SELECT
          SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
          COUNT(*) AS total
        FROM tasks
      `)
      .get() as { queued: number | null; running: number | null; total: number };
    return {
      queued: Number(row.queued ?? 0),
      running: Number(row.running ?? 0),
      total: Number(row.total),
    };
  }

  update(id: string, patch: Partial<TaskRecord>): void {
    const existing = this.get(id);
    if (existing === undefined) return;
    const task = { ...existing, ...patch };
    this.db
      .prepare(`
        UPDATE tasks SET
          request_key = ?, created_by = ?, prompt = ?, status = ?,
          created_at = ?, started_at = ?, finished_at = ?,
          workspace_dir = ?, storage_state = ?, seed_files_json = ?,
          options_json = ?, result_json = ?, error = ?, stopped_by = ?,
          stats_json = ?, artifacts_json = ?, prompt_digest = ?
        WHERE id = ?
      `)
      .run(
        task.requestKey ?? null,
        task.createdBy,
        task.prompt,
        task.status,
        task.createdAt,
        task.startedAt ?? null,
        task.finishedAt ?? null,
        task.workspaceDir,
        task.storageState ?? null,
        json(task.seedFiles),
        JSON.stringify(task.options),
        json(task.result),
        task.error ?? null,
        task.stoppedBy ?? null,
        json(task.stats),
        json(task.artifacts),
        task.promptDigest ?? null,
        id,
      );
  }

  appendEvent(id: string, type: string, data?: unknown): TaskEvent | undefined {
    if (this.get(id) === undefined) return undefined;
    const at = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM task_events WHERE task_id = ?")
        .get(id) as { seq: number };
      const seq = Number(row.seq) + 1;
      this.db
        .prepare(
          "INSERT INTO task_events (task_id, seq, at, type, data_json) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, seq, at, type, json(data));
      this.db
        .prepare("DELETE FROM task_events WHERE task_id = ? AND seq <= ?")
        .run(id, Math.max(0, seq - MAX_RETAINED_EVENTS));
      this.db.exec("COMMIT");
      return { seq, at, type, ...(data === undefined ? {} : { data }) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteTerminalBefore(cutoffIso: string): TaskRecord[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM tasks
        WHERE finished_at IS NOT NULL AND finished_at < ?
          AND status NOT IN ('queued', 'running')
        ORDER BY finished_at
      `)
      .all(cutoffIso) as unknown as TaskRow[];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          DELETE FROM tasks
          WHERE finished_at IS NOT NULL AND finished_at < ?
            AND status NOT IN ('queued', 'running')
        `)
        .run(cutoffIso);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return rows.map((row) => this.mapTask(row));
  }

  close(): void {
    this.db.close();
  }

  private migrateGlobalRequestKeys(): void {
    const table = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
      .get() as { sql: string } | undefined;
    if (table === undefined || !/\brequest_key\s+TEXT\s+UNIQUE\b/i.test(table.sql)) {
      return;
    }
    const hasEvents =
      this.db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'task_events'",
        )
        .get() !== undefined;
    this.db.pragma("foreign_keys = OFF");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (hasEvents) this.db.exec("ALTER TABLE task_events RENAME TO task_events_global_key");
      this.db.exec(`
        ALTER TABLE tasks RENAME TO tasks_global_key;
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          request_key TEXT,
          created_by TEXT NOT NULL,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          workspace_dir TEXT NOT NULL,
          storage_state TEXT,
          seed_files_json TEXT,
          options_json TEXT NOT NULL,
          result_json TEXT,
          error TEXT,
          stopped_by TEXT,
          stats_json TEXT,
          artifacts_json TEXT
        );
        INSERT INTO tasks SELECT * FROM tasks_global_key;
        CREATE TABLE task_events (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          at TEXT NOT NULL,
          type TEXT NOT NULL,
          data_json TEXT,
          PRIMARY KEY(task_id, seq)
        );
      `);
      if (hasEvents) {
        this.db.exec(`
          INSERT INTO task_events SELECT * FROM task_events_global_key;
          DROP TABLE task_events_global_key;
        `);
      }
      this.db.exec("DROP TABLE tasks_global_key; COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }

  /** A database from before the prompt digest gains its column, empty for every task it holds. */
  private addPromptDigestColumn(): void {
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('tasks')").all() as { name: string }[];
    if (columns.some((column) => column.name === "prompt_digest")) return;
    this.db.exec("ALTER TABLE tasks ADD COLUMN prompt_digest TEXT");
  }

  private recoverInterrupted(): void {
    const rows = this.db
      .prepare("SELECT id FROM tasks WHERE status = 'running'")
      .all() as unknown as Array<{ id: string }>;
    if (rows.length === 0) return;
    const finishedAt = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE tasks
        SET status = 'interrupted', stopped_by = 'interrupted',
            finished_at = ?, error = 'Ling stopped while this task was running.'
        WHERE status = 'running'
      `)
      .run(finishedAt);
    for (const row of rows) {
      this.appendEvent(row.id, "task_interrupted", {
        error: "Ling stopped while this task was running.",
      });
    }
  }

  private mapTask(row: TaskRow): TaskRecord {
    const eventRows = this.db
      .prepare(
        "SELECT seq, at, type, data_json FROM task_events WHERE task_id = ? ORDER BY seq",
      )
      .all(row.id) as unknown as EventRow[];
    return {
      id: row.id,
      ...(row.request_key === null ? {} : { requestKey: row.request_key }),
      createdBy: row.created_by,
      prompt: row.prompt,
      status: row.status,
      createdAt: row.created_at,
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      workspaceDir: row.workspace_dir,
      ...(row.storage_state === null ? {} : { storageState: row.storage_state }),
      ...(row.seed_files_json === null
        ? {}
        : { seedFiles: parseJson<Record<string, string>>(row.seed_files_json, {}) }),
      options: parseJson<TaskOptions>(row.options_json, {}),
      ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as unknown }),
      ...(row.error === null ? {} : { error: row.error }),
      ...(row.stopped_by === null ? {} : { stoppedBy: row.stopped_by }),
      ...(row.stats_json === null
        ? {}
        : { stats: parseJson<TaskStats | undefined>(row.stats_json, undefined) }),
      ...(row.artifacts_json === null
        ? {}
        : { artifacts: parseJson<string[]>(row.artifacts_json, []) }),
      ...(row.prompt_digest === null ? {} : { promptDigest: row.prompt_digest }),
      events: eventRows.map((event) => ({
        seq: Number(event.seq),
        at: event.at,
        type: event.type,
        ...(event.data_json === null
          ? {}
          : { data: JSON.parse(event.data_json) as unknown }),
      })),
    };
  }
}

export type TaskEmitter = (type: string, data?: unknown) => void;

/**
 * A running task's one inbox. A task subscribes for campaign messages or for
 * oversight messages, never both: `POST /tasks` refuses a tool set that would
 * want both, and the inbox takes one subscriber.
 */
export interface TaskMessageChannel {
  subscribe(listener: CampaignPeerMessageListener): () => void;
  subscribeOversight(listener: OversightMessageListener): () => void;
  /** Atomically refuse new injections and discard anything not yet handed to Pi. */
  close(): void;
}

export type TaskRunner = (
  task: TaskRecord,
  signal: AbortSignal,
  emit: TaskEmitter,
  messages: TaskMessageChannel,
) => Promise<TaskOutcome>;

export type TaskMessageInjectionResult =
  | { status: "accepted" }
  | { status: "duplicate" }
  | { status: "not_found" }
  | { status: "not_running"; taskStatus: TaskStatus }
  | { status: "feature_not_enabled" }
  | { status: "subscriber_unavailable" }
  | { status: "id_conflict" }
  | { status: "inbox_full"; limit: number };

export interface TaskQueueOptions {
  store: TaskStore;
  concurrency: number;
  runner: TaskRunner;
  workspaceDirFor: (taskId: string) => string;
  restoreMaxTasks?: number;
  restoreMaxAgeMs?: number;
}

export class TaskQueueShuttingDownError extends Error {
  constructor() {
    super("Task queue is shutting down.");
    this.name = "TaskQueueShuttingDownError";
  }
}

type InboxEntry =
  | { channel: "campaign"; message: CampaignPeerMessage }
  | { channel: "oversight"; message: OversightMessage };

interface TaskMessageInbox {
  /** Each accepted id's payload, so a retry is told apart from a conflict. */
  payloads: Map<string, string>;
  pending: InboxEntry[];
  phase: "awaiting_subscriber" | "subscribed" | "closed";
  listener?: (entry: InboxEntry) => void;
}

/** Whether a task opens an inbox at start: campaign tasks and oversight tasks do. */
function hasInbox(task: TaskRecord): boolean {
  const tools = task.options.tools ?? [];
  return tools.includes(CAMPAIGN_SEND_TOOL_NAME) || tools.some(isOversightTool);
}

export class TaskQueue {
  private readonly pending: string[] = [];
  private readonly running = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<TaskEventListener>>();
  private readonly messageInboxes = new Map<string, TaskMessageInbox>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly abandoned = new Set<string>();
  private accepting = true;

  constructor(private readonly options: TaskQueueOptions) {
    const cutoff =
      Date.now() - Math.max(60_000, options.restoreMaxAgeMs ?? 24 * 60 * 60 * 1000);
    const cap = Math.max(0, Math.floor(options.restoreMaxTasks ?? 100));
    const queued = options.store.list().filter((task) => task.status === "queued");
    const restored = queued.filter((task) => Date.parse(task.createdAt) >= cutoff).slice(0, cap);
    const restoredIds = new Set(restored.map((task) => task.id));
    for (const task of queued) {
      if (restoredIds.has(task.id)) continue;
      options.store.update(task.id, {
        status: "interrupted",
        stoppedBy: "interrupted",
        finishedAt: new Date().toISOString(),
        error: "Queued task exceeded startup restore age or count limits.",
      });
      options.store.appendEvent(task.id, "task_restore_refused");
    }
    this.pending.push(...restored.map((task) => task.id));
    queueMicrotask(() => this.pump());
  }

  enqueue(input: CreateTaskInput): TaskRecord {
    if (!this.accepting) throw new TaskQueueShuttingDownError();
    if (input.requestKey !== undefined) {
      const existing = this.options.store.getByRequestKey(
        input.createdBy,
        input.requestKey,
      );
      if (existing !== undefined) return existing;
    }
    const created = this.options.store.create(input, "");
    if (created.status !== "queued" || this.pending.includes(created.id)) return created;
    const workspaceDir = this.options.workspaceDirFor(created.id);
    this.options.store.update(created.id, { workspaceDir });
    this.pending.push(created.id);
    this.emit(created.id, "task_queued", { prompt: input.prompt });
    queueMicrotask(() => this.pump());
    return this.options.store.get(created.id) ?? created;
  }

  get(id: string): TaskRecord | undefined {
    return this.options.store.get(id);
  }

  list(): TaskRecord[] {
    return this.options.store.list();
  }

  counts(): { queued: number; running: number; total: number } {
    return this.options.store.counts();
  }

  activeTaskIds(): string[] {
    return this.list()
      .filter((task) => task.status === "queued" || task.status === "running")
      .map((task) => task.id);
  }

  cancelAll(): void {
    for (const id of this.activeTaskIds()) this.cancel(id);
  }

  /** Stop accepting work and wait for every queued/running task to settle. */
  async drain(): Promise<void> {
    this.accepting = false;
    for (const id of [...this.pending]) this.cancel(id);
    if (this.pending.length === 0 && this.running.size === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  interruptRemaining(message: string): void {
    this.accepting = false;
    const finishedAt = new Date().toISOString();
    for (const id of [...this.pending, ...this.running.keys()]) {
      this.abandoned.add(id);
      this.closeMessages(id);
      this.running.get(id)?.abort();
      this.options.store.update(id, {
        status: "interrupted",
        stoppedBy: "interrupted",
        finishedAt,
        error: message,
      });
      this.emit(id, "task_interrupted", { error: message });
    }
    this.pending.splice(0);
    this.running.clear();
    this.messageInboxes.clear();
    this.resolveIdle();
  }

  /** Returns false when the task does not exist or already reached a terminal state. */
  cancel(id: string): boolean {
    const task = this.options.store.get(id);
    if (!task) return false;

    if (task.status === "queued") {
      const index = this.pending.indexOf(id);
      if (index >= 0) this.pending.splice(index, 1);
      this.options.store.update(id, {
        status: "cancelled",
        stoppedBy: "cancelled",
        finishedAt: new Date().toISOString(),
      });
      this.emit(id, "task_cancelled", { whileQueued: true });
      this.resolveIdle();
      return true;
    }

    if (task.status === "running") {
      this.closeMessages(id);
      this.running.get(id)?.abort();
      this.emit(id, "task_cancel_requested");
      return true;
    }

    return false;
  }

  subscribe(id: string, listener: TaskEventListener): () => void {
    const set = this.listeners.get(id) ?? new Set<TaskEventListener>();
    set.add(listener);
    this.listeners.set(id, set);
    return () => {
      const current = this.listeners.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(id);
    };
  }

  /**
   * Inject one authenticated peer message into a running campaign-enabled task.
   *
   * Messages arriving during runner/Pi setup wait in memory until the campaign
   * extension subscribes. IDs remain remembered for the whole run so retries
   * are idempotent even after delivery.
   */
  injectCampaignMessage(
    id: string,
    message: CampaignPeerMessage,
  ): TaskMessageInjectionResult {
    const task = this.options.store.get(id);
    if (!task) return { status: "not_found" };
    if (!task.options.tools?.includes(CAMPAIGN_SEND_TOOL_NAME)) {
      return { status: "feature_not_enabled" };
    }
    return this.injectMessage(task, { channel: "campaign", message });
  }

  /**
   * Inject one parsed oversight message into a running task with an oversight
   * tool. It shares the task's inbox, its 64-id lifetime cap and its id and
   * payload idempotency with campaign messages. The message is the parser's
   * canonical copy, so a retry with its keys in another order is a duplicate,
   * not a conflict.
   */
  injectOversightMessage(id: string, message: OversightMessage): TaskMessageInjectionResult {
    const task = this.options.store.get(id);
    if (!task) return { status: "not_found" };
    if (!(task.options.tools ?? []).some(isOversightTool)) return { status: "feature_not_enabled" };
    return this.injectMessage(task, { channel: "oversight", message });
  }

  private injectMessage(task: TaskRecord, entry: InboxEntry): TaskMessageInjectionResult {
    if (task.status !== "running") {
      return { status: "not_running", taskStatus: task.status };
    }

    const inbox = this.messageInboxes.get(task.id);
    if (!inbox) {
      return { status: "subscriber_unavailable" };
    }
    if (inbox.phase === "closed") {
      return { status: "subscriber_unavailable" };
    }
    const payload = JSON.stringify(entry.message);
    const existing = inbox.payloads.get(entry.message.id);
    if (existing !== undefined) {
      if (existing !== payload) return { status: "id_conflict" };
      this.flushMessageInbox(inbox);
      return { status: "duplicate" };
    }
    if (inbox.payloads.size >= MAX_CAMPAIGN_MESSAGE_IDS) {
      return { status: "inbox_full", limit: MAX_CAMPAIGN_MESSAGE_IDS };
    }

    inbox.payloads.set(entry.message.id, payload);
    inbox.pending.push(entry);
    this.flushMessageInbox(inbox);
    return { status: "accepted" };
  }

  private emit(id: string, type: string, data?: unknown): void {
    const event = this.options.store.appendEvent(id, type, data);
    if (!event) return;
    for (const listener of this.listeners.get(id) ?? []) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not interrupt task execution.
      }
    }
  }

  private subscribeMessages(id: string, listener: (entry: InboxEntry) => void): () => void {
    const inbox = this.messageInboxes.get(id);
    if (!inbox) {
      throw new Error(`Message inbox for task ${id} is unavailable.`);
    }
    if (inbox.phase === "subscribed") {
      throw new Error(`Message inbox for task ${id} already has a subscriber.`);
    }
    if (inbox.phase === "closed") {
      throw new Error(`Message inbox for task ${id} is closed.`);
    }

    inbox.listener = listener;
    inbox.phase = "subscribed";
    this.flushMessageInbox(inbox);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.messageInboxes.get(id);
      if (current !== inbox || current.listener !== listener) return;
      current.listener = undefined;
      current.phase = "closed";
      current.pending.splice(0);
    };
  }

  private closeMessages(id: string): void {
    const inbox = this.messageInboxes.get(id);
    if (inbox === undefined || inbox.phase === "closed") return;
    inbox.listener = undefined;
    inbox.phase = "closed";
    inbox.pending.splice(0);
  }

  private flushMessageInbox(inbox: TaskMessageInbox): void {
    while (
      inbox.phase === "subscribed" &&
      inbox.listener !== undefined &&
      inbox.pending.length > 0
    ) {
      const message = inbox.pending[0];
      if (message === undefined) return;
      try {
        inbox.listener(message);
        inbox.pending.shift();
      } catch {
        // Keep the message buffered. A later injection can retry delivery
        // without letting extension code fail the authenticated HTTP request.
        return;
      }
    }
  }

  private pump(): void {
    if (!this.accepting) return;
    while (this.running.size < this.options.concurrency && this.pending.length > 0) {
      const id = this.pending.shift();
      if (id === undefined) break;
      void this.start(id);
    }
  }

  private async start(id: string): Promise<void> {
    const task = this.options.store.get(id);
    if (!task || task.status !== "queued") {
      this.resolveIdle();
      return;
    }

    const controller = new AbortController();
    this.running.set(id, controller);
    if (hasInbox(task)) {
      this.messageInboxes.set(id, {
        payloads: new Map<string, string>(),
        pending: [],
        phase: "awaiting_subscriber",
      });
    }
    this.options.store.update(id, { status: "running", startedAt: new Date().toISOString() });
    this.emit(id, "task_started");

    try {
      const current = this.options.store.get(id);
      if (!current) return;
      const outcome = await this.options.runner(
        current,
        controller.signal,
        (type, data) => this.emit(id, type, data),
        {
          // Only one channel can be in an inbox (POST /tasks refuses
          // campaign_send beside oversight tools), so neither filter drops a
          // message in practice; each keeps a subscriber from ever seeing the
          // other kind.
          subscribe: (listener) =>
            this.subscribeMessages(id, (entry) => {
              if (entry.channel === "campaign") listener(entry.message);
            }),
          subscribeOversight: (listener) =>
            this.subscribeMessages(id, (entry) => {
              if (entry.channel === "oversight") listener(entry.message);
            }),
          close: () => this.closeMessages(id),
        },
      );
      if (this.abandoned.has(id)) return;
      const cancelled = outcome.stoppedBy === "cancelled";
      this.options.store.update(id, {
        status: cancelled ? "cancelled" : outcome.status,
        finishedAt: new Date().toISOString(),
        result: outcome.result,
        error: outcome.error,
        stoppedBy: outcome.stoppedBy,
        stats: outcome.stats,
        artifacts: outcome.artifacts,
        promptDigest: outcome.promptDigest,
      });
      this.emit(id, "task_finished", {
        status: cancelled ? "cancelled" : outcome.status,
        stoppedBy: outcome.stoppedBy,
      });
    } catch (error) {
      if (this.abandoned.has(id)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.options.store.update(id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: message,
        stoppedBy: "error",
      });
      this.emit(id, "task_failed", { error: message });
    } finally {
      this.running.delete(id);
      this.messageInboxes.delete(id);
      this.abandoned.delete(id);
      this.resolveIdle();
      queueMicrotask(() => this.pump());
    }
  }

  private resolveIdle(): void {
    if (this.pending.length > 0 || this.running.size > 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
