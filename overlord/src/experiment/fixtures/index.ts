/**
 * Every pre-registered scorer fixture, (a) to (u), in the protocol's order.
 */
import { CRM_FIXTURES } from "./crm-import.js";
import { LEDGER_FIXTURES } from "./ledger.js";
import type { ScorerFixture } from "./types.js";

export const SCORER_FIXTURES: readonly ScorerFixture[] = [...LEDGER_FIXTURES, ...CRM_FIXTURES].sort(
  (left, right) => left.id.localeCompare(right.id),
);

export { WAIT_FOR_RELEASE } from "./crm-import.js";
export { CANARY } from "./ledger.js";
export {
  HOLD_END_TEXTS,
  SYNTHETIC_CHILD,
  SYNTHETIC_CONTEXT,
  SYNTHETIC_REPO,
  synthesize,
} from "./synthetic.js";
export type { ScorerFixture } from "./types.js";
