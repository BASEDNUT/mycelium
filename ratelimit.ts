// Mycelium RateLimit — in-memory token buckets.
// Fixes audit MEDIUM: no rate limiting on write + fan-out endpoints.
// Framework: Mycelium (this implementation: Taproot node).
// Original code. MIT license.

interface Bucket {
  tokens: number;
  last: number;
}

export class TokenBucketLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  constructor(
    private capacity: number,
    private refillPerSecond: number,
    private sweepIntervalMs = 60_000,
  ) {}

  /** Try to consume one token for a key. Returns true when allowed. */
  allow(key: string): boolean {
    const now = Date.now();
    this.sweep(now);
    let b = this.buckets.get(key);
    if (b == null) {
      b = { tokens: this.capacity, last: now };
      this.buckets.set(key, b);
    }
    // Refill proportional to elapsed time.
    const elapsed = (now - b.last) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSecond);
    b.last = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Remove idle buckets to bound memory. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.sweepIntervalMs) return;
    this.lastSweep = now;
    const drainSeconds = this.capacity / this.refillPerSecond;
    for (const [key, b] of this.buckets) {
      if ((now - b.last) / 1000 > drainSeconds) this.buckets.delete(key);
    }
  }
}

/** Shared limiters for the Taproot node. Tuned for a small production node. */
export class NodeRateLimits {
  // Writes: 30 burst, 0.5/s sustained per actor token.
  readonly write: TokenBucketLimiter;
  // Reads: 120 burst, 4/s sustained per IP.
  readonly read: TokenBucketLimiter;
  // Federation-triggering ops (follow): 6 burst, 0.1/s sustained per actor.
  readonly federation: TokenBucketLimiter;

  constructor() {
    this.write = new TokenBucketLimiter(30, 0.5);
    this.read = new TokenBucketLimiter(120, 4);
    this.federation = new TokenBucketLimiter(6, 0.1);
  }
}

export function clientKey(request: Request): string {
  // Rightmost XFF entry: the trusted reverse proxy APPENDS the real client
  // IP; leftmost is client-spoofable (audit: XFF spoof bypasses limits).
  // Assumes exactly one trusted proxy hop in front of the node.
  const xff = request.headers.get("x-forwarded-for");
  if (xff != null) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return request.headers.get("x-real-ip") ?? "local";
}
