/**
 * Records into a knowledge pool from its own process, so `pool-check` can put two
 * real writers on one database file.
 *
 * A second writer in-process would prove nothing: `better-sqlite3` is synchronous, so
 * two instances in one process take turns by construction. Only another process
 * actually contends for the write lock, which is what `journal_mode = WAL` and
 * `busy_timeout` are configured for.
 */
import { KnowledgePool } from "../pool/index.js";

const [, , dbPath, tag, roundsText] = process.argv;
if (dbPath === undefined || tag === undefined || roundsText === undefined) {
  throw new Error("Expected pool path, writer tag, and round count.");
}

const rounds = Number(roundsText);
const pool = new KnowledgePool(dbPath, { redact: (content) => content });
try {
  for (let round = 0; round < rounds; round += 1) {
    // One claim only this writer makes, and one both make: the first proves nothing
    // was lost, the second proves a contended write still merges rather than duplicates.
    pool.record({
      topic: "contention",
      claim: `claim ${round} from ${tag}`,
      campaignId: "c1",
      sliceId: tag,
    });
    pool.record({
      topic: "contention",
      claim: "a claim both writers make",
      campaignId: "c1",
      sliceId: tag,
    });
  }
  console.log(`${tag} done`);
} finally {
  pool.close();
}
