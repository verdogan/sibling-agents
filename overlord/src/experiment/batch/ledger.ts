/**
 * Ledger operations (§2.6): append-only JSONL with fsync on run_started. Each
 * ledger line has a timestamp. The harness never modifies a line; it only
 * appends. On resume, a run_started with no terminal line becomes
 * run_interrupted.
 */
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, fsyncSync, readdirSync } from "node:fs";
import { dirname } from "node:path";

export interface LedgerTimestamp {
  timestamp: string;
}

export type LedgerLine =
  | ({ event: "batch_started"; batchId: string; manifestSha256: string } & LedgerTimestamp)
  | ({ event: "run_started"; runId: string; cap: number; estimate: number; spentBefore: number } & LedgerTimestamp)
  | ({
      event: "run_finished";
      runId: string;
      status: string;
      stoppedBy: string | null;
      outcome: "included" | "excluded";
      reason: string | null;
      costUsd: number;
      reconciled: boolean;
      lookupFailed?: boolean;
    } & LedgerTimestamp)
  | ({ event: "run_failed"; runId: string; error: string; costUsd: number } & LedgerTimestamp)
  | ({ event: "run_not_started"; runId: string; reason: string } & LedgerTimestamp)
  | ({ event: "run_interrupted"; runId: string; costUsd: number } & LedgerTimestamp)
  | ({ event: "batch_stopped"; reason: string } & LedgerTimestamp)
  | ({ event: "batch_finished" } & LedgerTimestamp)
  | ({
      event: "calibration";
      aOnlyRatio: number;
      modelBRatio: number;
      within: boolean;
      maxCallCostUsd: { a: number; b: number };
    } & LedgerTimestamp)
  | ({ event: "rerun_scheduled"; runId: string; cell: string } & LedgerTimestamp);

export function ledgerPath(runsDir: string, batchId: string): string {
  return `${runsDir}/${batchId}/ledger.jsonl`;
}

export function appendLine(path: string, line: LedgerLine): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const json = JSON.stringify(line);
  appendFileSync(path, json + "\r\n", "utf8");
}

export function appendWithFsync(path: string, line: LedgerLine): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const json = JSON.stringify(line);
  const fd = openSync(path, "a");
  try {
    appendFileSync(fd, json + "\r\n", "utf8");
    fsyncSync(fd);
  } finally {
    // Close is implicit in Node, but being explicit for clarity
  }
}

export function readLedger(path: string): LedgerLine[] {
  if (!existsSync(path)) {
    return [];
  }
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line) => JSON.parse(line) as LedgerLine);
}

export interface LedgerCounts {
  done: number;
  excluded: number;
  notStarted: number;
  failed: number;
}

export interface LedgerSpend {
  spent: number;
  remaining: number;
}

export function analyzeLedger(
  lines: LedgerLine[],
  ceilingUsd: number,
): { counts: LedgerCounts; spend: LedgerSpend } {
  let spent = 0;
  let done = 0;
  let excluded = 0;
  let notStarted = 0;
  let failed = 0;

  for (const line of lines) {
    switch (line.event) {
      case "run_finished":
        if (line.outcome === "included") {
          done++;
        } else {
          excluded++;
        }
        spent += line.costUsd;
        break;
      case "run_failed":
        failed++;
        spent += line.costUsd;
        break;
      case "run_interrupted":
        excluded++;
        spent += line.costUsd;
        break;
      case "run_not_started":
        notStarted++;
        break;
    }
  }

  return {
    counts: { done, excluded, notStarted, failed },
    spend: { spent, remaining: Math.max(0, ceilingUsd - spent) },
  };
}

/** What the family's batches spent, from their ledgers; `excludeBatchId` leaves one batch out (the one running). */
export function familySpend(runsDir: string, family: "pilot" | "counted", excludeBatchId?: string): number {
  // Scan all batch directories in runsDir for this family
  if (!existsSync(runsDir)) {
    return 0;
  }
  // No catch: a ledger that cannot be read must stop the batch, never read as nothing spent.
  const entries = readdirSync(runsDir, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(`${family}-`) && entry.name !== excludeBatchId) {
      const ledger = ledgerPath(runsDir, entry.name);
      const lines = readLedger(ledger);
      const { spend } = analyzeLedger(lines, Infinity);
      total += spend.spent;
    }
  }
  return total;
}
