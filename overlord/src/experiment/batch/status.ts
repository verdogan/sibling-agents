/**
 * Status command: counts from the ledger and spend/remaining. Never shows
 * outcome fields.
 */
import { readLedger, analyzeLedger, type LedgerLine } from "./ledger.js";
import type { BatchManifest } from "./manifest.js";

export interface ExclusionReason {
  reason: string;
  count: number;
}

export interface StatusResult {
  batchId: string;
  counts: {
    done: number;
    excluded: number;
    notStarted: number;
    failed: number;
  };
  exclusionReasons: ExclusionReason[];
  spend: {
    spent: number;
    remaining: number;
  };
}

export function statusBatch(manifest: BatchManifest, ledgerPath: string): StatusResult {
  const lines = readLedger(ledgerPath);
  const { counts, spend } = analyzeLedger(lines, manifest.ceilingUsd);

  // Collect exclusion reasons
  const reasonCounts = new Map<string, number>();
  for (const line of lines) {
    if (line.event === "run_finished" && line.outcome === "excluded") {
      const reason = line.reason ?? "unknown";
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    } else if (line.event === "run_interrupted") {
      reasonCounts.set("interrupted", (reasonCounts.get("interrupted") ?? 0) + 1);
    }
  }

  const exclusionReasons = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    batchId: manifest.id,
    counts,
    exclusionReasons,
    spend,
  };
}

export function printStatus(status: StatusResult): void {
  console.log(`Batch: ${status.batchId}`);
  console.log(`Done: ${status.counts.done}`);
  console.log(`Excluded: ${status.counts.excluded}`);
  if (status.exclusionReasons.length > 0) {
    console.log(`  Reasons:`);
    for (const { reason, count } of status.exclusionReasons) {
      console.log(`    ${reason}: ${count}`);
    }
  }
  console.log(`Not started: ${status.counts.notStarted}`);
  console.log(`Failed: ${status.counts.failed}`);
  console.log(`Spent: $${status.spend.spent.toFixed(2)}`);
  console.log(`Remaining: $${status.spend.remaining.toFixed(2)}`);
}
