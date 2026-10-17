import settings from "../config/settings.json" with { type: "json" };

// Split totalCents between payers in proportion to their weights (SPEC.md).
export function settle(totalCents, weights) {
  if (!Number.isInteger(totalCents)) throw new TypeError(`amounts are integer ${settings.currency} cents`);
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => Math.floor((totalCents * w) / sum));
  // Hand out remainder cents one at a time, in payer order (SPEC.md rule 3).
  let remainder = totalCents - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % shares.length) {
    shares[i] += 1;
    remainder -= 1;
  }
  return shares;
}
