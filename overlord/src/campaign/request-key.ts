import type { CampaignRole } from "./schema.js";

/**
 * Campaign request keys: the idempotency key every campaign spawn carries.
 *
 * They live apart from the driver because more than the driver needs them. The
 * schema checks that a summon intent belongs to its campaign, and the decision
 * validators refuse a replanned slice id whose key Ling would reject, and
 * neither should have to import the run loop to do it.
 *
 * A key encodes campaign, role, slice and round, so a task found on a worker
 * after a crash can be adopted into the attempt it was spawned for. The format
 * is persisted in manifests and on workers; changing it strands tasks already
 * spawned under the old one.
 */

/** Ling's own bound on a request key. */
export const MAX_CAMPAIGN_REQUEST_KEY_CHARS = 240;

/** The prefix every request key of one campaign shares. */
export function campaignRequestKeyPrefix(campaignId: string): string {
  return `campaign:${Buffer.from(campaignId).toString("base64url")}:`;
}

export function campaignRequestKey(
  campaignId: string,
  role: CampaignRole,
  sliceId: string | null,
  round: number,
): string {
  const slice = sliceId === null ? "-" : Buffer.from(sliceId).toString("base64url");
  const key = `${campaignRequestKeyPrefix(campaignId)}${role}:${slice}:${round}`;
  if (key.length > MAX_CAMPAIGN_REQUEST_KEY_CHARS) {
    throw new Error(
      `Campaign request key is ${key.length} characters; Ling accepts at most ${MAX_CAMPAIGN_REQUEST_KEY_CHARS}.`,
    );
  }
  return key;
}

/**
 * Every role a key can name: the four work roles, and the watcher spawned as
 * half of a builder's pair. A reconcile that did not know the watcher would
 * take one for a stranger's task and cancel it unrecorded.
 */
const KEY_ROLES: readonly CampaignRole[] = [
  "planner",
  "builder",
  "reviewer",
  "integration",
  "watcher",
];

/**
 * The role, slice and round a key of this campaign was written for, or
 * undefined for any string `campaignRequestKey` would not have written. Which
 * roles carry a slice is for the caller adopting the task to judge.
 */
export function parseCampaignRequestKey(
  campaignId: string,
  requestKey: string,
): { role: CampaignRole; sliceId: string | null; round: number } | undefined {
  const prefix = campaignRequestKeyPrefix(campaignId);
  if (!requestKey.startsWith(prefix)) return undefined;
  const [role, encodedSlice, roundRaw, ...extra] = requestKey.slice(prefix.length).split(":");
  if (
    extra.length > 0 ||
    !(KEY_ROLES as readonly string[]).includes(role ?? "") ||
    encodedSlice === undefined ||
    roundRaw === undefined
  ) {
    return undefined;
  }
  const round = Number.parseInt(roundRaw, 10);
  if (!Number.isInteger(round) || round < 1 || String(round) !== roundRaw) return undefined;
  if (encodedSlice === "-") return { role: role as CampaignRole, sliceId: null, round };
  // Decoding is lenient: it skips characters outside the alphabet and the
  // unused low bits of the last one, so many strings decode to one slice id.
  // Only the encoding campaignRequestKey writes is this campaign's key.
  const sliceId = Buffer.from(encodedSlice, "base64url").toString("utf8");
  if (Buffer.from(sliceId, "utf8").toString("base64url") !== encodedSlice) return undefined;
  return { role: role as CampaignRole, sliceId, round };
}
