/** Small deterministic PRNG so a given seed always reproduces the same suggestion. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], rnd: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Pick one entry, favouring low scores. `temperature` controls randomness:
 * near 0 is almost deterministic, larger spreads the probability out.
 */
export function pickWeighted<T>(
  items: readonly T[],
  score: (item: T) => number,
  rnd: () => number,
  temperature = 1,
): T {
  if (items.length === 1) return items[0];
  const scores = items.map(score);
  const min = Math.min(...scores);
  const weights = scores.map((s) => Math.exp(-(s - min) / Math.max(temperature, 1e-6)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0) return items[Math.floor(rnd() * items.length)];
  let r = rnd() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}
