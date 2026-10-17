import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { LingTask } from "./ling/types.js";
import type { SpawnPolicy } from "./policy.js";

/**
 * Where the fleet ledger lives, resolved the same way by every process that opens it.
 *
 * Exported rather than repeated in each entrypoint because a supervisor that reads a
 * different default from the overlord's would find an empty ledger, cancel nothing,
 * and report success — the worst available failure for a kill path.
 */
export function fleetLedgerPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(
    env["FLEET_LEDGER_PATH"]?.trim() ||
      path.join(os.homedir(), ".ling-overlord", "fleet-ledger.db"),
  );
}

export interface FleetLedgerLimits
  extends Pick<SpawnPolicy, "maxTasksPerRun" | "maxConcurrentTasks" | "maxTotalCostUsd"> {
  /** Optional cumulative token ceiling, enforced before the next task starts. */
  maxTotalTokens?: number;
}

export type SpawnBlockReason =
  | "invalid_estimate"
  | "task_cap"
  | "concurrency"
  | "budget"
  | "tokens"
  | FleetRateBlockReason;

/**
 * What a rolling window counts. Kept separate from the depleting ceilings above,
 * because the two do different jobs and confusing them is how a pace control gets
 * mistaken for a stop condition: `maxTotalCostUsd` depletes and ends an objective,
 * while these refill and only decide how fast it may move.
 */
export type FleetWindowKind = "task" | "spend" | "decision";

export interface FleetRateLimits {
  /** Width of the rolling window. Anything older than this stops counting. */
  windowMs: number;
  maxTasks?: number;
  maxSpendUsd?: number;
  maxDecisions?: number;
}

export type FleetRateBlockReason = "rate_tasks" | "rate_spend" | "rate_decisions";

/** What a caller is about to do, weighed against what the window already holds. */
export interface FleetRateRequest {
  tasks?: number;
  spendUsd?: number;
  decisions?: number;
}

export interface FleetLedgerStoreOptions {
  retentionMs?: number;
  inFlightStaleMs?: number;
  /**
   * The widest rate window this store must be able to answer for. Retention and rate
   * windows are different things, and this is where they meet: pruning window events
   * on the retention schedule alone would silently empty a window an operator had set
   * wider than retention, and a rate limit that counts nothing permits everything.
   */
  rateWindowMs?: number;
}

export class FleetLedger {
  private readonly tasks = new Map<string, LingTask>();

  constructor(private readonly limits: FleetLedgerLimits) {
    if (!Number.isFinite(limits.maxTotalCostUsd) || limits.maxTotalCostUsd <= 0) {
      throw new RangeError("maxTotalCostUsd must be a positive finite number.");
    }
    if (!Number.isInteger(limits.maxTasksPerRun) || limits.maxTasksPerRun <= 0) {
      throw new RangeError("maxTasksPerRun must be a positive integer.");
    }
    if (!Number.isInteger(limits.maxConcurrentTasks) || limits.maxConcurrentTasks <= 0) {
      throw new RangeError("maxConcurrentTasks must be a positive integer.");
    }
    if (
      limits.maxTotalTokens !== undefined &&
      (!Number.isSafeInteger(limits.maxTotalTokens) || limits.maxTotalTokens <= 0)
    ) {
      throw new RangeError("maxTotalTokens must be a positive safe integer when set.");
    }
  }

  spentUsd(): number {
    let total = 0;
    for (const task of this.tasks.values()) {
      const cost = task.stats?.cost ?? 0;
      if (Number.isFinite(cost) && cost > 0) total += cost;
    }
    return total;
  }

  remainingUsd(): number {
    return Math.max(0, this.limits.maxTotalCostUsd - this.spentUsd());
  }

  spentTokens(): number {
    let total = 0;
    for (const task of this.tasks.values()) {
      const tokens = task.stats?.tokens.total ?? 0;
      if (Number.isSafeInteger(tokens) && tokens > 0) total += tokens;
    }
    return total;
  }

  remainingTokens(): number | undefined {
    return this.limits.maxTotalTokens === undefined
      ? undefined
      : Math.max(0, this.limits.maxTotalTokens - this.spentTokens());
  }

  inFlight(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "queued" || task.status === "running") count += 1;
    }
    return count;
  }

  taskCount(): number {
    return this.tasks.size;
  }

  has(id: string): boolean {
    return this.tasks.has(id);
  }

  spawnBlockReason(estimateUsd: number): SpawnBlockReason | undefined {
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0) return "invalid_estimate";
    if (this.tasks.size >= this.limits.maxTasksPerRun) return "task_cap";
    if (this.inFlight() >= this.limits.maxConcurrentTasks) return "concurrency";
    if (
      this.limits.maxTotalTokens !== undefined &&
      this.spentTokens() >= this.limits.maxTotalTokens
    ) {
      return "tokens";
    }
    if (this.spentUsd() + estimateUsd > this.limits.maxTotalCostUsd) return "budget";
    return undefined;
  }

  canSpawn(estimateUsd: number): boolean {
    return this.spawnBlockReason(estimateUsd) === undefined;
  }

  record(task: LingTask): void {
    const existing = this.tasks.get(task.id);
    const existingCost = existing?.stats?.cost ?? 0;
    const incomingCost = task.stats?.cost ?? 0;
    const existingTokens = existing?.stats?.tokens.total ?? 0;
    const incomingTokens = task.stats?.tokens.total ?? 0;
    const statsSource = incomingTokens >= existingTokens ? task.stats : existing?.stats;
    if (statsSource !== undefined) {
      this.tasks.set(task.id, {
        ...task,
        stats: {
          ...statsSource,
          cost: Math.max(existingCost, incomingCost),
          tokens: {
            ...statsSource.tokens,
            total: Math.max(existingTokens, incomingTokens),
          },
        },
      });
    } else {
      this.tasks.set(task.id, task);
    }
  }
}

interface AggregateRow {
  total: number;
}

/**
 * Fleet-wide reservations and actual spend. BEGIN IMMEDIATE makes the
 * check-and-reserve decision atomic across separate campaign processes.
 */
export class FleetLedgerStore {
  private readonly db: Database.Database;
  private readonly retentionMs: number;
  private readonly inFlightStaleMs: number;
  private readonly windowRetentionMs: number;

  constructor(
    readonly dbPath: string,
    options: FleetLedgerStoreOptions = {},
  ) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.retentionMs = Math.max(
      60_000,
      options.retentionMs ?? 30 * 24 * 60 * 60 * 1000,
    );
    this.inFlightStaleMs = Math.max(
      60_000,
      options.inFlightStaleMs ?? 2 * 60 * 60 * 1000,
    );
    // A day by default, and never shorter than task retention: whichever window is
    // wider is the one that must survive a prune.
    this.windowRetentionMs = Math.max(
      this.retentionMs,
      Math.max(60_000, options.rateWindowMs ?? 24 * 60 * 60 * 1000),
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_tasks (
        id TEXT PRIMARY KEY,
        request_key TEXT UNIQUE,
        campaign_id TEXT NOT NULL,
        worker_id TEXT,
        status TEXT NOT NULL,
        cost_usd REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fleet_tasks_status ON fleet_tasks(status);
      CREATE TABLE IF NOT EXISTS spawn_reservations (
        request_key TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        estimate_usd REAL NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fleet_window_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        amount REAL NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fleet_window_events_kind_at
        ON fleet_window_events(kind, at);
    `);
  }

  reserveSpawn(
    requestKey: string,
    campaignId: string,
    estimateUsd: number,
    limits: Pick<FleetLedgerLimits, "maxConcurrentTasks" | "maxTotalCostUsd">,
    ttlMs: number,
    rate?: FleetRateLimits,
  ): SpawnBlockReason | undefined {
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0) return "invalid_estimate";
    const now = new Date();
    this.prune(now.getTime());
    const expiresAt = new Date(now.getTime() + Math.max(60_000, ttlMs)).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM spawn_reservations WHERE expires_at <= ?")
        .run(now.toISOString());
      const task = this.db
        .prepare("SELECT id FROM fleet_tasks WHERE request_key = ?")
        .get(requestKey);
      const reservation = this.db
        .prepare("SELECT request_key FROM spawn_reservations WHERE request_key = ?")
        .get(requestKey);
      if (task !== undefined || reservation !== undefined) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const active = this.db
        .prepare(`
          SELECT (
            SELECT COUNT(*) FROM fleet_tasks WHERE status IN ('queued', 'running')
          ) + (
            SELECT COUNT(*) FROM spawn_reservations
          ) AS total
        `)
        .get() as unknown as AggregateRow;
      if (Number(active.total) >= limits.maxConcurrentTasks) {
        this.db.exec("COMMIT");
        return "concurrency";
      }
      const spend = this.db
        .prepare(`
          SELECT (
            SELECT COALESCE(SUM(cost_usd), 0) FROM fleet_tasks
          ) + (
            SELECT COALESCE(SUM(estimate_usd), 0) FROM spawn_reservations
          ) AS total
        `)
        .get() as unknown as AggregateRow;
      if (Number(spend.total) + estimateUsd > limits.maxTotalCostUsd) {
        this.db.exec("COMMIT");
        return "budget";
      }
      // Checked inside the same transaction as the ceilings above, so two overlords
      // cannot both read a window with one slot left and both take it.
      if (rate !== undefined) {
        const rateReason = this.rateBlockReasonWithin(
          rate,
          { tasks: 1, spendUsd: estimateUsd },
          now.getTime(),
        );
        if (rateReason !== undefined) {
          this.db.exec("COMMIT");
          return rateReason;
        }
      }
      this.db
        .prepare(`
          INSERT INTO spawn_reservations (
            request_key, campaign_id, estimate_usd, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?)
        `)
        .run(requestKey, campaignId, estimateUsd, now.toISOString(), expiresAt);
      this.db.exec("COMMIT");
      return undefined;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  releaseReservation(requestKey: string): void {
    this.db
      .prepare("DELETE FROM spawn_reservations WHERE request_key = ?")
      .run(requestKey);
  }

  record(
    task: LingTask,
    campaignId: string,
    workerId?: string,
    requestKey: string | undefined = task.requestKey,
  ): void {
    const cost =
      task.stats?.cost !== undefined && Number.isFinite(task.stats.cost) && task.stats.cost > 0
        ? task.stats.cost
        : 0;
    this.prune();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let priorCost = 0;
      if (requestKey !== undefined) {
        const duplicate = this.db
          .prepare("SELECT id, cost_usd FROM fleet_tasks WHERE request_key = ?")
          .get(requestKey) as { id: string; cost_usd: number } | undefined;
        if (duplicate !== undefined && duplicate.id !== task.id) {
          priorCost = Number(duplicate.cost_usd);
          this.db.prepare("DELETE FROM fleet_tasks WHERE id = ?").run(duplicate.id);
        }
      }
      // The window counts work, not requests. A task is counted once, when its row
      // first appears — `record` is called again on every status change, and a
      // reservation can expire without ever becoming a task, so counting at either of
      // those points would make the rate reflect bookkeeping rather than activity.
      // Spend is counted as the increase over what was already attributed to this
      // task, since `record` re-states a running total.
      const existing = this.db
        .prepare("SELECT cost_usd FROM fleet_tasks WHERE id = ?")
        .get(task.id) as { cost_usd: number } | undefined;
      const attributed = Math.max(cost, priorCost);
      const spendDelta = attributed - Math.max(Number(existing?.cost_usd ?? 0), priorCost);
      if (existing === undefined) {
        this.appendWindowEvent("task", campaignId, 1, new Date());
      }
      if (spendDelta > 0) {
        this.appendWindowEvent("spend", campaignId, spendDelta, new Date());
      }
      this.db
        .prepare(`
          INSERT INTO fleet_tasks (
            id, request_key, campaign_id, worker_id, status, cost_usd, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            request_key = COALESCE(excluded.request_key, fleet_tasks.request_key),
            campaign_id = excluded.campaign_id,
            worker_id = COALESCE(excluded.worker_id, fleet_tasks.worker_id),
            status = excluded.status,
            cost_usd = MAX(fleet_tasks.cost_usd, excluded.cost_usd),
            updated_at = excluded.updated_at
        `)
        .run(
          task.id,
          requestKey ?? null,
          campaignId,
          workerId ?? task.workerId ?? null,
          task.status,
          Math.max(cost, priorCost),
          new Date().toISOString(),
        );
      if (requestKey !== undefined) {
        this.db
          .prepare("DELETE FROM spawn_reservations WHERE request_key = ?")
          .run(requestKey);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  spentUsd(): number {
    this.prune();
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM fleet_tasks")
      .get() as unknown as AggregateRow;
    return Number(row.total);
  }

  /**
   * Record one model decision against the rolling window.
   *
   * Decisions are metered separately from tasks because they are the cheap thing that
   * can run away: a loop that cannot afford another worker can still ask a model what
   * to do next, indefinitely, for a fraction of a cent each time.
   */
  recordDecision(campaignId: string, now: Date = new Date()): void {
    this.appendWindowEvent("decision", campaignId, 1, now);
  }

  /** What the window currently holds for one kind. */
  windowTotal(kind: FleetWindowKind, windowMs: number, now = Date.now()): number {
    const since = new Date(now - Math.max(0, windowMs)).toISOString();
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM fleet_window_events WHERE kind = ? AND at > ?",
      )
      .get(kind, since) as unknown as AggregateRow;
    return Number(row.total);
  }

  /**
   * Whether doing `request` now would exceed a rolling limit, and which one.
   *
   * Every limit is optional, and an unset one is unlimited rather than zero: a caller
   * that meters spend per hour and does not care about decision count should not have
   * to state a decision ceiling to get one.
   */
  rateBlockReason(
    limits: FleetRateLimits,
    request: FleetRateRequest = {},
    now = Date.now(),
  ): FleetRateBlockReason | undefined {
    return this.rateBlockReasonWithin(limits, request, now);
  }

  /** In-flight tasks, for a supervisor that has to cancel them from outside. */
  inFlightTasks(campaignId?: string): {
    id: string;
    campaignId: string;
    workerId: string | undefined;
    status: string;
    updatedAt: string;
  }[] {
    const rows =
      campaignId === undefined
        ? this.db
            .prepare(
              `SELECT id, campaign_id, worker_id, status, updated_at FROM fleet_tasks
                WHERE status IN ('queued', 'running') ORDER BY updated_at ASC`,
            )
            .all()
        : this.db
            .prepare(
              `SELECT id, campaign_id, worker_id, status, updated_at FROM fleet_tasks
                WHERE status IN ('queued', 'running') AND campaign_id = ?
                ORDER BY updated_at ASC`,
            )
            .all(campaignId);
    return (
      rows as {
        id: string;
        campaign_id: string;
        worker_id: string | null;
        status: string;
        updated_at: string;
      }[]
    ).map((row) => ({
      id: row.id,
      campaignId: row.campaign_id,
      workerId: row.worker_id ?? undefined,
      status: row.status,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Set a task's status without touching its cost.
   *
   * For a supervisor cancelling work whose overlord is gone: it knows the task
   * stopped, and it deliberately knows nothing about what the task spent, so a full
   * `record` would have to invent a figure and would lower the total by doing so.
   * Returns false when the row has already reached a terminal status, so a reaper can
   * tell what it actually stopped from what had already finished.
   */
  markTaskStatus(id: string, status: string, now: Date = new Date()): boolean {
    const changes = this.db
      .prepare(
        `UPDATE fleet_tasks SET status = ?, updated_at = ?
          WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(status, now.toISOString(), id).changes;
    return changes > 0;
  }

  inFlight(): number {
    this.prune();
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS total FROM fleet_tasks WHERE status IN ('queued', 'running')",
      )
      .get() as unknown as AggregateRow;
    return Number(row.total);
  }

  close(): void {
    this.db.close();
  }

  /**
   * The transaction-free core of `rateBlockReason`, so `reserveSpawn` can consult it
   * from inside its own transaction rather than opening a second one.
   */
  private rateBlockReasonWithin(
    limits: FleetRateLimits,
    request: FleetRateRequest,
    now: number,
  ): FleetRateBlockReason | undefined {
    const windowMs = Math.max(0, limits.windowMs);
    // Outstanding reservations count as work already promised. Without this the window
    // does not bind at all: a task event is only written when the task's row first
    // appears, so any number of reservations taken before that all see the same empty
    // window and are all admitted. With a limit of one and concurrency of eight, eight
    // tasks would start. A reservation that expires without becoming a task stops
    // counting, and one that becomes a task has its row deleted as the task is
    // recorded, so neither is counted twice.
    const promised = this.liveReservations();
    if (
      limits.maxTasks !== undefined &&
      this.windowTotal("task", windowMs, now) + promised.count + (request.tasks ?? 0) >
        limits.maxTasks
    ) {
      return "rate_tasks";
    }
    if (
      limits.maxSpendUsd !== undefined &&
      this.windowTotal("spend", windowMs, now) + promised.estimateUsd + (request.spendUsd ?? 0) >
        limits.maxSpendUsd
    ) {
      return "rate_spend";
    }
    if (
      limits.maxDecisions !== undefined &&
      this.windowTotal("decision", windowMs, now) + (request.decisions ?? 0) >
        limits.maxDecisions
    ) {
      return "rate_decisions";
    }
    return undefined;
  }

  /**
   * Reservations currently outstanding: work promised but not yet recorded.
   *
   * Counted regardless of age, unlike window events. A reservation is not history, it
   * is an imminent task, and its own TTL is what bounds how long it can weigh on a
   * window.
   */
  private liveReservations(): { count: number; estimateUsd: number } {
    const row = this.db
      .prepare<[], { count: number; estimate: number }>(
        "SELECT COUNT(*) AS count, COALESCE(SUM(estimate_usd), 0) AS estimate FROM spawn_reservations",
      )
      .get()!;
    return { count: Number(row.count), estimateUsd: Number(row.estimate) };
  }

  /**
   * Admit one model decision, or say why not — as a single atomic act.
   *
   * Checking and recording separately is a race with a limit of one: two decisions in
   * flight both read an empty window and both proceed, which is precisely the failure a
   * limit on decisions exists to prevent. Parallel slices make that ordinary rather
   * than exotic.
   */
  tryRecordDecision(
    limits: FleetRateLimits | undefined,
    campaignId: string,
    now: Date = new Date(),
  ): FleetRateBlockReason | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const reason =
        limits === undefined
          ? undefined
          : this.rateBlockReasonWithin(limits, { decisions: 1 }, now.getTime());
      if (reason === undefined) this.appendWindowEvent("decision", campaignId, 1, now);
      this.db.exec("COMMIT");
      return reason;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private appendWindowEvent(
    kind: FleetWindowKind,
    campaignId: string,
    amount: number,
    now: Date,
  ): void {
    this.db
      .prepare(
        "INSERT INTO fleet_window_events (kind, campaign_id, amount, at) VALUES (?, ?, ?, ?)",
      )
      .run(kind, campaignId, amount, now.toISOString());
  }

  prune(now = Date.now()): void {
    const terminalCutoff = new Date(now - this.retentionMs).toISOString();
    const activeCutoff = new Date(now - this.inFlightStaleMs).toISOString();
    const nowIso = new Date(now).toISOString();
    this.db
      .prepare(
        "DELETE FROM fleet_tasks WHERE status NOT IN ('queued', 'running') AND updated_at < ?",
      )
      .run(terminalCutoff);
    this.db
      .prepare(
        "DELETE FROM fleet_tasks WHERE status IN ('queued', 'running') AND updated_at < ?",
      )
      .run(activeCutoff);
    this.db
      .prepare("DELETE FROM spawn_reservations WHERE expires_at <= ?")
      .run(nowIso);
    // On its own schedule, for the reason `rateWindowMs` exists: pruning these with
    // the tasks would let a short retention setting empty a long rate window, and a
    // limit counting nothing permits everything.
    this.db
      .prepare("DELETE FROM fleet_window_events WHERE at < ?")
      .run(new Date(now - this.windowRetentionMs).toISOString());
  }
}
