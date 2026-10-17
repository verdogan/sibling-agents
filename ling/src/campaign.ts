export const CAMPAIGN_SEND_TOOL_NAME = "campaign_send";

export const MAX_CAMPAIGN_MESSAGE_IDS = 64;
export const MAX_CAMPAIGN_ID_CHARS = 240;
export const MAX_CAMPAIGN_THREAD_CHARS = 240;
export const MAX_CAMPAIGN_FROM_CHARS = 240;
export const MAX_CAMPAIGN_CONTENT_CHARS = 4096;
export const MAX_CAMPAIGN_MENTIONS = 16;
export const MAX_CAMPAIGN_MENTION_CHARS = 240;
export const MAX_CAMPAIGN_SENT_AT_CHARS = 64;
export const MAX_CAMPAIGN_MESSAGE_BODY_BYTES = 32 * 1024;

export const campaignPriorities = ["fyi", "normal", "urgent"] as const;
export type CampaignPriority = (typeof campaignPriorities)[number];

/** Exact data emitted by the campaign_send task tool. */
export interface CampaignOutgoingMessage {
  thread: string;
  content: string;
  mentions: string[];
  priority: CampaignPriority;
}

/** Exact authenticated wire shape accepted by POST /tasks/:id/messages. */
export interface CampaignPeerMessage {
  id: string;
  thread: string;
  from: string;
  content: string;
  priority: CampaignPriority;
  sentAt: string;
}

export type CampaignPeerMessageListener = (message: CampaignPeerMessage) => void;

/** Wrap peer text while preventing its contents from forging the closing marker. */
export function fenceCampaignData(label: string, body: string): string {
  const encodedLabel = Buffer.from(label, "utf8").toString("base64url") || "unlabelled";
  const marker = `LING-UNTRUSTED-CAMPAIGN-${encodedLabel}`;
  const splitAt = Math.floor(marker.length / 2);
  const neutralizedMarker = `${marker.slice(0, splitAt)}\u200b${marker.slice(splitAt)}`;
  const safeBody = body.replaceAll(marker, neutralizedMarker);
  return `<<<${marker}:BEGIN>>>\n${safeBody}\n<<<${marker}:END>>>`;
}

export class CampaignMessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignMessageValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new CampaignMessageValidationError(`"${key}" must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new CampaignMessageValidationError(
      `"${key}" must be at most ${maxLength} characters.`,
    );
  }
  return value;
}

const MESSAGE_KEYS = ["id", "thread", "from", "content", "priority", "sentAt"] as const;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Parse without coercion, trimming, defaults, or tolerated extra fields. */
export function parseCampaignPeerMessage(input: unknown): CampaignPeerMessage {
  if (!isRecord(input)) {
    throw new CampaignMessageValidationError("Message body must be a JSON object.");
  }

  const actualKeys = Object.keys(input);
  const accepted = new Set<string>(MESSAGE_KEYS);
  const unknown = actualKeys.filter((key) => !accepted.has(key));
  const missing = MESSAGE_KEYS.filter((key) => !Object.hasOwn(input, key));
  if (unknown.length > 0 || missing.length > 0) {
    const details = [
      ...(unknown.length > 0 ? [`unknown: ${unknown.join(", ")}`] : []),
      ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
    ].join("; ");
    throw new CampaignMessageValidationError(
      `Message body must contain exactly: ${MESSAGE_KEYS.join(", ")} (${details}).`,
    );
  }

  const id = boundedString(input, "id", MAX_CAMPAIGN_ID_CHARS);
  const thread = boundedString(input, "thread", MAX_CAMPAIGN_THREAD_CHARS);
  const from = boundedString(input, "from", MAX_CAMPAIGN_FROM_CHARS);
  const content = boundedString(input, "content", MAX_CAMPAIGN_CONTENT_CHARS);
  const priority = input["priority"];
  if (
    typeof priority !== "string" ||
    !campaignPriorities.includes(priority as CampaignPriority)
  ) {
    throw new CampaignMessageValidationError(
      `"priority" must be one of: ${campaignPriorities.join(", ")}.`,
    );
  }
  const sentAt = boundedString(input, "sentAt", MAX_CAMPAIGN_SENT_AT_CHARS);
  if (!ISO_TIMESTAMP.test(sentAt) || Number.isNaN(Date.parse(sentAt))) {
    throw new CampaignMessageValidationError(
      '"sentAt" must be an ISO 8601 timestamp with a timezone.',
    );
  }

  return {
    id,
    thread,
    from,
    content,
    priority: priority as CampaignPriority,
    sentAt,
  };
}
