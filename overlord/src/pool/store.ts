import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  artifactRedactorFromEnv,
  type ArtifactRedactor,
} from "../campaign/artifacts.js";
import type { CampaignManifest } from "../campaign/schema.js";
import { fenceUntrusted } from "../untrusted.js";
import {
  MAX_CLAIM_CHARS,
  MAX_TOPIC_CHARS,
  POOL_VERSION,
  PoolSchemaError,
  factId,
  normalizeFactLocator,
  normalizeFactText,
  normalizeFactTopic,
  parseFactProvenance,
  type FactProvenance,
  type FactSource,
  type KnowledgeFact,
} from "./schema.js";

/** What a caller may assert. Note the absence of `provenance`: see `record`. */
export interface FactInput {
  topic: string;
  claim: string;
  campaignId: string;
  /** The slice that produced it, or null for the overlord's own inference. */
  sliceId?: string | null;
  locator?: string | null;
}

export interface FactQuery {
  /** Restrict to these topics. Omit for every topic. */
  topics?: readonly string[];
  /** `verified` excludes hearsay entirely. Defaults to `claimed`, meaning everything. */
  minProvenance?: FactProvenance;
  /** Hard row cap, applied after ordering. */
  limit?: number;
}

export interface PromptSelection {
  /** Fenced, ready to seed. Empty string when nothing matched. */
  text: string;
  /** The facts that fitted, in the order they appear in `text`. */
  included: KnowledgeFact[];
  /** How many matching facts were left out by the character budget. */
  omitted: number;
}

export interface KnowledgePoolOptions {
  /**
   * How long an unpromoted claim survives. Claims are the bulk of the pool and
   * the least trustworthy part of it, so they expire; promoted facts do not age out.
   */
  claimedRetentionMs?: number;
  /** Row ceiling enforced by `prune`, oldest and least trusted evicted first. */
  maxFacts?: number;
  redact?: ArtifactRedactor;
}

const DEFAULT_CLAIMED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FACTS = 50_000;
const WAL_SWITCH_TIMEOUT_MS = 5_000;

/**
 * Switch to WAL, retrying while another process holds the lock. Two processes
 * opening a new pool at once both need it to change the journal mode, and
 * SQLite answers one of them SQLITE_BUSY at once, without the busy handler,
 * rather than let the two deadlock.
 */
function enableWal(db: Database.Database): void {
  const deadline = Date.now() + WAL_SWITCH_TIMEOUT_MS;
  for (;;) {
    try {
      db.pragma("journal_mode = WAL");
      return;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "SQLITE_BUSY" || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/** Default budget for one prompt seeding. Roughly a few hundred short facts. */
export const DEFAULT_PROMPT_CHAR_BUDGET = 24_000;

interface FactRow {
  id: string;
  topic: string;
  claim: string;
  provenance: string;
  recorded_at: string;
  verified_at: string | null;
}

interface SourceRow {
  fact_id: string;
  campaign_id: string;
  slice_id: string | null;
  locator: string | null;
  recorded_at: string;
}

/**
 * What the overlord has learned, outliving any single campaign.
 *
 * Three properties are load-bearing, and each is enforced here rather than left to
 * the caller, because the caller is the component this store exists to keep honest.
 *
 * Provenance is recorded at write time and cannot be asserted. `record` writes
 * `claimed`, always; the only route to `verified` is `promoteFromCampaign`, which
 * reads a persisted manifest and promotes only what a slice's evidence gate passed.
 * A store that accepted a provenance argument would be a store where the component
 * with a motive to believe its own output decides what counts as verified.
 *
 * Text is redacted on write. A long-lived pool accumulating raw worker output is a
 * far more attractive target than one campaign directory, and redacting on read
 * would leave the secret on disk.
 *
 * Reads that reach a prompt are fenced. `selectForPrompt` is the only method that
 * returns prompt-shaped text and it fences unconditionally, so there is no path
 * that seeds pool contents as trusted instruction.
 */
export class KnowledgePool {
  private readonly db: Database.Database;
  private readonly claimedRetentionMs: number;
  private readonly maxFacts: number;
  private readonly redact: ArtifactRedactor;

  constructor(
    readonly dbPath: string,
    options: KnowledgePoolOptions = {},
  ) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("busy_timeout = 5000");
    enableWal(this.db);
    this.db.pragma("foreign_keys = ON");
    this.claimedRetentionMs = Math.max(
      60_000,
      options.claimedRetentionMs ?? DEFAULT_CLAIMED_RETENTION_MS,
    );
    this.maxFacts = Math.max(1, options.maxFacts ?? DEFAULT_MAX_FACTS);
    this.redact = options.redact ?? artifactRedactorFromEnv();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pool_facts (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        claim TEXT NOT NULL,
        provenance TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        verified_at TEXT
      );
      CREATE INDEX IF NOT EXISTS pool_facts_topic ON pool_facts(topic);
      CREATE INDEX IF NOT EXISTS pool_facts_provenance ON pool_facts(provenance);
      CREATE TABLE IF NOT EXISTS pool_fact_sources (
        fact_id TEXT NOT NULL REFERENCES pool_facts(id) ON DELETE CASCADE,
        campaign_id TEXT NOT NULL,
        slice_id TEXT,
        locator TEXT,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (fact_id, campaign_id, slice_id)
      );
      CREATE INDEX IF NOT EXISTS pool_fact_sources_campaign
        ON pool_fact_sources(campaign_id, slice_id);
    `);
    this.assertSchemaVersion();
  }

  /**
   * Refuse a file this build cannot read, rather than reading it wrongly.
   *
   * A fact's id is derived from its text, so a change to how text is normalized
   * changes every id. Opening such a file anyway would not fail loudly: it would
   * store new rows beside old ones that say the same thing under different ids, and
   * every count of corroboration afterwards would be wrong. That is exactly the class
   * of error the pool exists to prevent, so the store declines instead.
   *
   * An unversioned file is adopted only when it is empty, which is the one case where
   * nothing can have been written under the old rules.
   */
  private assertSchemaVersion(): void {
    const recorded = Number(this.db.pragma("user_version", { simple: true }));
    if (recorded === POOL_VERSION) return;
    if (recorded === 0 && this.count() === 0) {
      this.db.pragma(`user_version = ${POOL_VERSION}`);
      return;
    }
    this.db.close();
    throw new PoolSchemaError(
      `pool: ${this.dbPath} was written by pool schema version ${recorded}, and this build reads version ${POOL_VERSION}. ` +
        "Fact ids are derived from normalized text, so the two cannot be mixed; rebuild the pool from the campaign manifests that produced it.",
    );
  }

  close(): void {
    this.db.close();
  }

  /**
   * Record a claim. Returns the fact as it now stands.
   *
   * Always enters as `claimed`, even when the caller knows the campaign passed:
   * promotion is a separate act keyed on a persisted manifest, so that the
   * distinction survives the enthusiasm of whoever is writing.
   *
   * Recording the same claim again from a different slice adds a source rather
   * than a row, and does not disturb a provenance already earned. Repetition is
   * not evidence, so a claim asserted forty times is still one claim.
   */
  record(input: FactInput, now: Date = new Date()): KnowledgeFact {
    const topic = normalizeFactTopic(this.redact(String(input.topic)));
    const claim = normalizeFactText(this.redact(String(input.claim)), "claim", MAX_CLAIM_CHARS);
    const campaignId = normalizeFactText(input.campaignId, "campaignId", MAX_TOPIC_CHARS);
    const sliceId =
      input.sliceId == null
        ? null
        : normalizeFactText(input.sliceId, "sliceId", MAX_TOPIC_CHARS);
    const locator =
      input.locator == null
        ? null
        : normalizeFactLocator(this.redact(input.locator), "locator");
    const id = factId(topic, claim);
    const recordedAt = now.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO pool_facts (id, topic, claim, provenance, recorded_at, verified_at)
           VALUES (?, ?, ?, 'claimed', ?, NULL)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(id, topic, claim, recordedAt);
      // The primary key makes a second assertion from the same slice a no-op, so a
      // worker cannot inflate its own corroboration by writing in a loop.
      this.db
        .prepare(
          `INSERT INTO pool_fact_sources (fact_id, campaign_id, slice_id, locator, recorded_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(fact_id, campaign_id, slice_id) DO NOTHING`,
        )
        .run(id, campaignId, sliceId, locator, recordedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const fact = this.get(id);
    if (fact === undefined) throw new Error(`Fact ${id} vanished immediately after being recorded.`);
    return fact;
  }

  get(id: string): KnowledgeFact | undefined {
    const row = this.db
      .prepare<[string], FactRow>("SELECT * FROM pool_facts WHERE id = ?")
      .get(id);
    if (row === undefined) return undefined;
    return this.hydrate([row])[0];
  }

  /**
   * Promote every fact a finished campaign evidenced.
   *
   * The manifest is the evidence, and it is compare-and-swap persisted and
   * schema-validated, so it is not something a caller can shape to taste. Three
   * conditions must hold for a slice's facts to be promoted, and each closes a
   * specific way the word "verified" could otherwise be earned cheaply:
   *
   * - the campaign completed, so its acceptance criteria were checked at all;
   * - the slice was accepted, so a reviewer passed the deliverable;
   * - the slice's accepted attempt has a findings gate outcome of `pass`.
   *
   * That last condition is the strict one, and deliberately so. `inapplicable`
   * means nothing was independently re-checked — including the case where the
   * campaign withheld the verification tool from its reviewer — so promoting on it
   * would make opting out of verification a route to verified facts. Those claims
   * stay claims. Non-research campaigns therefore mint nothing here, which costs
   * little: they produce code, not assertions about the world.
   *
   * The slice condition is, today, implied by the first: the campaign schema only
   * accepts `completed` when every slice is accepted, so no test can distinguish a
   * build with it from a build without. It stays anyway, because that invariant
   * lives in another file and is free to be relaxed, and the cost of it being wrong
   * here is a permanently mislabelled fact.
   *
   * Returns the ids promoted. Already-promoted facts keep their original
   * `verifiedAt`, so replaying this after a crash is a no-op rather than a rewrite.
   */
  promoteFromCampaign(manifest: CampaignManifest, now: Date = new Date()): string[] {
    if (manifest.status !== "completed") return [];
    const eligible = manifest.slices
      .filter(
        (slice) =>
          slice.status === "accepted" &&
          slice.attempts.some(
            (attempt) =>
              attempt.verdict === "accept" && attempt.findingsGate?.outcome === "pass",
          ),
      )
      .map((slice) => slice.id);
    if (eligible.length === 0) return [];
    const verifiedAt = now.toISOString();
    const placeholders = eligible.map(() => "?").join(", ");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare<string[], { fact_id: string }>(
          `SELECT DISTINCT fact_id FROM pool_fact_sources
           WHERE campaign_id = ? AND slice_id IN (${placeholders})`,
        )
        .all(manifest.id, ...eligible);
      const promote = this.db.prepare(
        `UPDATE pool_facts SET provenance = 'verified', verified_at = ?
         WHERE id = ? AND provenance = 'claimed'`,
      );
      const promoted = rows
        .filter((row) => promote.run(verifiedAt, row.fact_id).changes > 0)
        .map((row) => row.fact_id);
      this.db.exec("COMMIT");
      return promoted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Facts matching a query, best first: verified before claimed, then most
   * recently recorded. Callers that truncate therefore keep the strongest facts.
   */
  select(query: FactQuery = {}): KnowledgeFact[] {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (query.topics !== undefined) {
      if (query.topics.length === 0) return [];
      // Folded the same way as on write, so a caller querying `Antalya` finds what a
      // worker recorded under `antalya`.
      const topics = query.topics.map((topic) => normalizeFactTopic(topic));
      clauses.push(`topic IN (${topics.map(() => "?").join(", ")})`);
      parameters.push(...topics);
    }
    if (query.minProvenance !== undefined) {
      // Only two levels exist, so "at least verified" is an equality test. A third
      // level would need an ordinal column rather than another branch here.
      if (parseFactProvenance(query.minProvenance, "minProvenance") === "verified") {
        clauses.push("provenance = 'verified'");
      }
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const limit = query.limit === undefined ? -1 : Math.max(0, Math.trunc(query.limit));
    const rows = this.db
      .prepare<unknown[], FactRow>(
        `SELECT * FROM pool_facts ${where}
         ORDER BY provenance = 'verified' DESC, recorded_at DESC, id ASC
         LIMIT ?`,
      )
      .all(...parameters, limit);
    return this.hydrate(rows);
  }

  /**
   * Render matching facts as fenced text for a prompt, within a character budget.
   *
   * The budget is not decoration. A pool that has run for weeks will not fit in a
   * context window, so something must choose what to leave out; doing it here, by
   * a stated ordering, beats letting a provider truncate at an arbitrary byte. The
   * count of what was dropped is returned rather than hidden, because a caller
   * that is silently seeing a third of the pool should be able to notice.
   */
  selectForPrompt(
    query: FactQuery = {},
    options: { maxChars?: number; label?: string } = {},
  ): PromptSelection {
    const maxChars = Math.max(0, options.maxChars ?? DEFAULT_PROMPT_CHAR_BUDGET);
    const facts = this.select(query);
    const included: KnowledgeFact[] = [];
    const lines: string[] = [];
    let used = 0;
    for (const fact of facts) {
      const line = renderFact(fact);
      // +1 for the newline that will join it. Budgeting the rendered body rather
      // than the fenced result keeps the caller's number meaningful when the
      // fence label changes length.
      if (used + line.length + 1 > maxChars) continue;
      used += line.length + 1;
      lines.push(line);
      included.push(fact);
    }
    return {
      text:
        lines.length === 0
          ? ""
          : fenceUntrusted(options.label ?? "knowledge-pool", lines.join("\n")),
      included,
      omitted: facts.length - included.length,
    };
  }

  /**
   * Evict expired claims, then enforce the row ceiling. Returns how many facts went.
   *
   * Claims expire and verified facts do not, so a pool under pressure loses its
   * least trustworthy contents first. Only when expiry alone cannot reach the
   * ceiling does it start evicting verified facts, oldest first — at which point
   * the ceiling is the thing to raise.
   */
  prune(now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - this.claimedRetentionMs).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let removed = this.db
        .prepare("DELETE FROM pool_facts WHERE provenance = 'claimed' AND recorded_at <= ?")
        .run(cutoff).changes;
      const { total } = this.db
        .prepare<[], { total: number }>("SELECT COUNT(*) AS total FROM pool_facts")
        .get()!;
      const excess = total - this.maxFacts;
      if (excess > 0) {
        removed += this.db
          .prepare(
            `DELETE FROM pool_facts WHERE id IN (
               SELECT id FROM pool_facts
               ORDER BY provenance = 'verified' ASC, recorded_at ASC, id ASC
               LIMIT ?
             )`,
          )
          .run(excess).changes;
      }
      this.db.exec("COMMIT");
      return removed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Every topic the pool holds, with how much it holds under each.
   *
   * Retrieval here is exact match on a folded label, deliberately: a ranked or fuzzy
   * search over worker-written text would be a surface a worker could aim at, and the
   * point of this store is that nothing in it can be influenced into looking more
   * important than it is. The cost of that choice is that a caller has to know the
   * label, so it gets the vocabulary rather than having to guess it from memory.
   */
  topics(): { topic: string; facts: number; verified: number }[] {
    return this.db
      .prepare<[], { topic: string; facts: number; verified: number }>(
        `SELECT topic,
                COUNT(*) AS facts,
                SUM(CASE WHEN provenance = 'verified' THEN 1 ELSE 0 END) AS verified
           FROM pool_facts
          GROUP BY topic
          ORDER BY facts DESC, topic ASC`,
      )
      .all();
  }

  count(provenance?: FactProvenance): number {
    const row =
      provenance === undefined
        ? this.db
            .prepare<[], { total: number }>("SELECT COUNT(*) AS total FROM pool_facts")
            .get()
        : this.db
            .prepare<[string], { total: number }>(
              "SELECT COUNT(*) AS total FROM pool_facts WHERE provenance = ?",
            )
            .get(parseFactProvenance(provenance, "provenance"));
    return row?.total ?? 0;
  }

  private hydrate(rows: FactRow[]): KnowledgeFact[] {
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => "?").join(", ");
    const sources = this.db
      .prepare<string[], SourceRow>(
        `SELECT * FROM pool_fact_sources WHERE fact_id IN (${placeholders})
         ORDER BY recorded_at ASC, campaign_id ASC`,
      )
      .all(...rows.map((row) => row.id));
    const byFact = new Map<string, FactSource[]>();
    for (const source of sources) {
      const list = byFact.get(source.fact_id) ?? [];
      list.push({
        campaignId: source.campaign_id,
        sliceId: source.slice_id,
        locator: source.locator,
        recordedAt: source.recorded_at,
      });
      byFact.set(source.fact_id, list);
    }
    return rows.map((row) => ({
      id: row.id,
      topic: row.topic,
      claim: row.claim,
      provenance: parseFactProvenance(row.provenance, `pool_facts.${row.id}.provenance`),
      sources: byFact.get(row.id) ?? [],
      recordedAt: row.recorded_at,
      verifiedAt: row.verified_at,
    }));
  }
}

/**
 * One fact on one line, with its provenance stated where the reader cannot miss it.
 *
 * The marker is spelled out rather than implied by ordering, because the whole
 * point of the store is that the reader treats the two kinds differently, and a
 * model reading a flat list will not infer that from position.
 */
function renderFact(fact: KnowledgeFact): string {
  const corroboration = fact.sources.length > 1 ? ` [${fact.sources.length} sources]` : "";
  const locator = fact.sources.find((source) => source.locator !== null)?.locator;
  return (
    `[${fact.provenance}]${corroboration} (${fact.topic}) ${fact.claim}` +
    (locator === undefined ? "" : ` <${locator}>`)
  );
}
