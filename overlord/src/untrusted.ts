/** Wrap text as data while preventing its contents from closing the fence. */
export function fenceUntrusted(label: string, body: string): string {
  const encodedLabel = Buffer.from(label, "utf8").toString("base64url") || "unlabelled";
  const marker = `LING-UNTRUSTED-${encodedLabel}`;
  const splitAt = Math.floor(marker.length / 2);
  const neutralizedMarker = `${marker.slice(0, splitAt)}\u200b${marker.slice(splitAt)}`;
  const safeBody = body.replaceAll(marker, neutralizedMarker);
  return `<<<${marker}:BEGIN>>>\n${safeBody}\n<<<${marker}:END>>>`;
}
