/**
 * Which role may deliver a message into which other role's context.
 *
 * Default deny, and the single place a new pairing is enabled. This exists
 * ahead of anything that needs it, because the alternative is retrofitting a
 * gate onto a channel already carrying traffic — and because the pairing most
 * likely to want one is exactly the pairing that must not have it.
 *
 * There are two tables, and they stay apart.
 *
 * `canDeliverMessage` is campaign_send, peer to peer between the roles that do
 * the work. A watcher is not one of them, so campaign_send stays closed to and
 * from it in both directions: an observer's prose never arrives in a worker's
 * context as a peer message, and a worker cannot lobby its observer that way.
 *
 * `canDeliverOversight` is the watched pair's channel, and it is open because
 * the owner chose a two-way channel over the earlier rule that an observer
 * must not talk to the worker it reports on. The cautions behind that rule are
 * kept rather than dropped. The channel runs only through the overlord and only
 * through this table: a pair's outbox asks it about every message, and refuses
 * one it does not allow before that message is persisted or sent
 * (oversight-coordinator.ts, `enqueue`). B's words reach A only fenced,
 * bounded and labelled as an overseer that can be wrong: as an answer to a
 * question A asked, as one of at most three cautions citing evidence, or as
 * the reason beside a hold. A's words reach B only inside an overlord-authored
 * feed, as claims to be checked against facts. And B's only brake is a bounded
 * hold the overlord applies and ends; B cannot cancel A, and losing B never
 * stops A.
 *
 * Kept as pure functions on plain strings rather than methods on the driver so
 * the deny path can be exercised with a role the union does not contain. A
 * gate whose refusal cannot be tested until the thing it refuses exists is a
 * gate nobody has checked.
 */

/**
 * Roles that carry out campaign work and may coordinate with each other. Every
 * other combination has to be added deliberately, with a reason.
 */
export const COORDINATING_ROLES: readonly string[] = [
  "planner",
  "builder",
  "reviewer",
  "integration",
];

export function canDeliverMessage(fromRole: string, toRole: string): boolean {
  return COORDINATING_ROLES.includes(fromRole) && COORDINATING_ROLES.includes(toRole);
}

/**
 * Every oversight delivery v1 permits, literally: the overlord feeds the
 * watcher; the watcher's advice and cautions reach the builder; the overlord's
 * holds and releases reach the builder. Anything else is refused, including
 * any pairing of roles outside the campaign's union.
 */
const OVERSIGHT_ROUTES: readonly (readonly [kind: string, from: string, to: string])[] = [
  ["feed", "overlord", "watcher"],
  ["advice", "watcher", "builder"],
  ["caution", "watcher", "builder"],
  ["hold", "overlord", "builder"],
  ["release", "overlord", "builder"],
];

export function canDeliverOversight(kind: string, fromRole: string, toRole: string): boolean {
  return OVERSIGHT_ROUTES.some(
    ([routeKind, routeFrom, routeTo]) =>
      routeKind === kind && routeFrom === fromRole && routeTo === toRole,
  );
}
