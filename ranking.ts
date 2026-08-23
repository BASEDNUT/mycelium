// v0.12.0 ranking primitives — pure functions.
// Patterns rewritten from a study of muesli/littr.go (MIT); no code copied.

/** Wilson lower-bound score for up/down votes (z = 1.94 ≈ 95%). */
export function wilsonScore(up: number, down: number, z = 1.94): number {
  const n = up + down;
  if (n === 0) return 0;
  const phat = up / n;
  const z2 = z * z;
  return (phat + z2 / (2 * n) - z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) /
    (1 + z2 / n);
}

/** Reddit-style hot score with time decay. */
export function hotScore(up: number, down: number, ageHours: number): number {
  const score = up - down;
  const order = Math.log10(Math.max(Math.abs(score), 1));
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0;
  return sign * order - ageHours / 12;
}
