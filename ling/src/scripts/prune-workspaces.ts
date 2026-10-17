import path from "node:path";
import { config } from "../config.js";
import { SQLiteTaskStore } from "../queue.js";
import { pruneExpiredTasks } from "../retention.js";

// Maintenance opens the queue to read and prune, never to take ownership of it. With
// recovery on, running this against a live worker marked its in-flight tasks
// `interrupted` while their runners kept going.
const store = new SQLiteTaskStore(path.join(config.dataDir, "tasks.db"), { recover: false });
try {
  const count = await pruneExpiredTasks(
    store,
    config.workspacesDir,
    config.retentionDays,
    Date.now(),
    config.eventLogDir,
  );
  console.log(`pruned ${count} expired task(s)`);
} finally {
  store.close();
}
