import settings from "../config/settings.json" with { type: "json" };

// Split totalCents between payers in proportion to their weights (SPEC.md):
// proportional shares rounded down, remainder cents handed out one at a time
// in payer order starting with the first payer.
export function settle(totalCents, weights) {
  if (!Number.isInteger(totalCents)) throw new TypeError(`amounts are integer ${settings.currency} cents`);
  if (weights.some((w) => !Number.isInteger(w) || w < 0)) throw new TypeError("weights must be non-negative integers");
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => Math.floor((totalCents * w) / sum));
  let remainder = totalCents - shares.reduce((a, b) => a + b, 0);
  let i = 0;
  while (remainder > 0) {
    shares[i % shares.length] += 1;
    remainder -= 1;
    i += 1;
  }
  return shares;
}
