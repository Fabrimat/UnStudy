export const WORDS_PER_CREDIT = 1000;

// Integer arithmetic on the multiplier: ceil(11 * 1.1) would be ceil(12.100000000000001).
export function creditsForJob(words: number, multiplier: number): number {
  return Math.max(1, Math.ceil((creditsFor(words) * Math.round(multiplier * 100)) / 100));
}

export function creditsFor(words: number): number {
  return Math.max(1, Math.ceil(words / WORDS_PER_CREDIT));
}
