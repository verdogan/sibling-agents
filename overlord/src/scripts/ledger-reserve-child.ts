import { FleetLedgerStore } from "../ledger.js";

const [, , dbPath, requestKey] = process.argv;
if (dbPath === undefined || requestKey === undefined) {
  throw new Error("Expected ledger path and request key.");
}

const store = new FleetLedgerStore(dbPath);
try {
  const result = store.reserveSpawn(
    requestKey,
    `campaign-${requestKey}`,
    0.1,
    { maxConcurrentTasks: 1, maxTotalCostUsd: 1 },
    60_000,
  );
  console.log(result ?? "reserved");
} finally {
  store.close();
}
