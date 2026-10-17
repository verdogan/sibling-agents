import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";
import type {
  MonitorItem,
  MonitorItemInput,
  MonitorItemQuery,
  MonitorRun,
  RecipeHealth,
} from "./types.js";

interface ItemRow {
  id: number;
  recipe_id: string;
  platform: string;
  source_id: string;
  url: string;
  author: string | null;
  text: string;
  created_at: string | null;
  captured_at: string;
  query: string;
  raw_json: string | null;
}

interface HealthRow {
  recipe_id: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  consecutive_empty: number;
  consecutive_failures: number;
  last_repair_at: string | null;
}

function mapItem(row: ItemRow): MonitorItem {
  return {
    id: row.id,
    recipeId: row.recipe_id,
    platform: row.platform,
    sourceId: row.source_id,
    url: row.url,
    author: row.author,
    text: row.text,
    createdAt: row.created_at,
    capturedAt: row.captured_at,
    query: row.query,
    ...(row.raw_json === null ? {} : { raw: JSON.parse(row.raw_json) as unknown }),
  };
}

function mapHealth(row: HealthRow): RecipeHealth {
  return {
    recipeId: row.recipe_id,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    consecutiveEmpty: row.consecutive_empty,
    consecutiveFailures: row.consecutive_failures,
    lastRepairAt: row.last_repair_at,
  };
}

export class MonitorStore {
  private readonly db: Database.Database;

  constructor(readonly dbPath = path.join(config.dataDir, "monitor.db")) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipe_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        source_id TEXT NOT NULL,
        url TEXT NOT NULL,
        author TEXT,
        text TEXT NOT NULL,
        created_at TEXT,
        captured_at TEXT NOT NULL,
        query TEXT NOT NULL,
        raw_json TEXT,
        UNIQUE(platform, source_id)
      );

      CREATE INDEX IF NOT EXISTS items_captured_at ON items(captured_at DESC);
      CREATE INDEX IF NOT EXISTS items_platform ON items(platform, captured_at DESC);
      CREATE INDEX IF NOT EXISTS items_query ON items(query, captured_at DESC);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        recipe_id TEXT NOT NULL,
        query TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        status TEXT NOT NULL,
        seen_count INTEGER NOT NULL,
        inserted_count INTEGER NOT NULL,
        error TEXT,
        browser_elapsed_ms INTEGER NOT NULL,
        agent_used INTEGER NOT NULL DEFAULT 0,
        agent_cost_usd REAL NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS runs_recipe ON runs(recipe_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS recipe_health (
        recipe_id TEXT PRIMARY KEY,
        last_attempt_at TEXT,
        last_success_at TEXT,
        consecutive_empty INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_repair_at TEXT
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  insertItems(recipeId: string, items: MonitorItemInput[], capturedAt: string): number {
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO items (
        recipe_id, platform, source_id, url, author, text,
        created_at, captured_at, query, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let inserted = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of items) {
        const result = statement.run(
          recipeId,
          item.platform,
          item.sourceId,
          item.url,
          item.author,
          item.text,
          item.createdAt,
          capturedAt,
          item.query,
          item.raw === undefined ? null : JSON.stringify(item.raw),
        );
        inserted += result.changes;
      }
      this.db.exec("COMMIT");
      return inserted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordRun(run: MonitorRun): void {
    this.db
      .prepare(`
        INSERT INTO runs (
          id, recipe_id, query, started_at, finished_at, status,
          seen_count, inserted_count, error, browser_elapsed_ms,
          agent_used, agent_cost_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        run.id,
        run.recipeId,
        run.query,
        run.startedAt,
        run.finishedAt,
        run.status,
        run.seenCount,
        run.insertedCount,
        run.error,
        run.browserElapsedMs,
        run.agentUsed ? 1 : 0,
        run.agentCostUsd,
      );

    this.db
      .prepare(`
        INSERT OR IGNORE INTO recipe_health (recipe_id)
        VALUES (?)
      `)
      .run(run.recipeId);

    if (run.status === "success") {
      this.db
        .prepare(`
          UPDATE recipe_health
          SET last_attempt_at = ?, last_success_at = ?,
              consecutive_empty = 0, consecutive_failures = 0
          WHERE recipe_id = ?
        `)
        .run(run.finishedAt, run.finishedAt, run.recipeId);
    } else if (run.status === "empty") {
      this.db
        .prepare(`
          UPDATE recipe_health
          SET last_attempt_at = ?, consecutive_empty = consecutive_empty + 1,
              consecutive_failures = 0
          WHERE recipe_id = ?
        `)
        .run(run.finishedAt, run.recipeId);
    } else {
      this.db
        .prepare(`
          UPDATE recipe_health
          SET last_attempt_at = ?, consecutive_failures = consecutive_failures + 1
          WHERE recipe_id = ?
        `)
        .run(run.finishedAt, run.recipeId);
    }
  }

  listItems(query: MonitorItemQuery = {}): MonitorItem[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.since !== undefined) {
      clauses.push("captured_at > ?");
      values.push(query.since);
    }
    if (query.platform !== undefined) {
      clauses.push("platform = ?");
      values.push(query.platform);
    }
    if (query.query !== undefined) {
      clauses.push("query = ?");
      values.push(query.query);
    }
    const limit = Math.min(1000, Math.max(1, Math.floor(query.limit ?? 100)));
    values.push(limit);

    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const rows = this.db
      .prepare(`SELECT * FROM items ${where} ORDER BY captured_at DESC, id DESC LIMIT ?`)
      .all(...values) as unknown as ItemRow[];
    return rows.map(mapItem);
  }

  getHealth(recipeId: string): RecipeHealth {
    this.db.prepare("INSERT OR IGNORE INTO recipe_health (recipe_id) VALUES (?)").run(recipeId);
    const row = this.db
      .prepare("SELECT * FROM recipe_health WHERE recipe_id = ?")
      .get(recipeId) as unknown as HealthRow;
    return mapHealth(row);
  }

  markRepair(recipeId: string, at: string): void {
    this.db.prepare("INSERT OR IGNORE INTO recipe_health (recipe_id) VALUES (?)").run(recipeId);
    this.db
      .prepare("UPDATE recipe_health SET last_repair_at = ? WHERE recipe_id = ?")
      .run(at, recipeId);
  }

  listRuns(recipeId?: string, limit = 50): MonitorRun[] {
    const bounded = Math.min(500, Math.max(1, Math.floor(limit)));
    const rows = (
      recipeId === undefined
        ? this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(bounded)
        : this.db
            .prepare("SELECT * FROM runs WHERE recipe_id = ? ORDER BY started_at DESC LIMIT ?")
            .all(recipeId, bounded)
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row["id"]),
      recipeId: String(row["recipe_id"]),
      query: String(row["query"]),
      startedAt: String(row["started_at"]),
      finishedAt: String(row["finished_at"]),
      status: row["status"] as MonitorRun["status"],
      seenCount: Number(row["seen_count"]),
      insertedCount: Number(row["inserted_count"]),
      error: row["error"] === null ? null : String(row["error"]),
      browserElapsedMs: Number(row["browser_elapsed_ms"]),
      agentUsed: Number(row["agent_used"]) === 1,
      agentCostUsd: Number(row["agent_cost_usd"]),
    }));
  }
}
