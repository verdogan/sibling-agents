export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly refillPerMs: number;
  private lastSweepAt = 0;

  constructor(
    requestsPerMinute: number,
    private readonly burst: number,
    private readonly maxBuckets = 10_000,
    private readonly idleMs = 60 * 60 * 1000,
  ) {
    if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) {
      throw new RangeError("requestsPerMinute must be positive.");
    }
    if (!Number.isInteger(burst) || burst <= 0) throw new RangeError("burst must be positive.");
    if (!Number.isInteger(maxBuckets) || maxBuckets <= 0) {
      throw new RangeError("maxBuckets must be positive.");
    }
    if (!Number.isFinite(idleMs) || idleMs <= 0) throw new RangeError("idleMs must be positive.");
    this.refillPerMs = requestsPerMinute / 60_000;
  }

  take(caller: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    this.sweep(now);
    const current = this.buckets.get(caller) ?? { tokens: this.burst, updatedAt: now };
    current.tokens = Math.min(
      this.burst,
      current.tokens + Math.max(0, now - current.updatedAt) * this.refillPerMs,
    );
    current.updatedAt = now;
    this.buckets.delete(caller);
    this.buckets.set(caller, current);
    while (this.buckets.size > this.maxBuckets) {
      const oldest = this.buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    if (current.tokens >= 1) {
      current.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((1 - current.tokens) / this.refillPerMs / 1000),
      ),
    };
  }

  size(): number {
    return this.buckets.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweepAt < Math.min(this.idleMs, 60_000)) return;
    this.lastSweepAt = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= this.idleMs) this.buckets.delete(key);
    }
  }
}
