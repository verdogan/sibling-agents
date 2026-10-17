import settings from "../config/settings.json" with { type: "json" };

// Split totalCents between payers in proportion to their weights (SPEC.md).
export function settle(totalCents, weights) {
  if (!Number.isInteger(totalCents)) throw new TypeError(`amounts are integer ${settings.currency} cents`);
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => Math.floor((totalCents * w) / sum));
  let remainder = totalCents - shares.reduce((a, b) => a + b, 0);
  let i = 0;
  while (remainder > 0) {
    shares[i % weights.length] += 1;
    remainder -= 1;
    i += 1;
  }
  return shares;
}
