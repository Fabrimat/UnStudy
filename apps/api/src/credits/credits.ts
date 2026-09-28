export const WORDS_PER_CREDIT = 1000;

export function creditsFor(words: number): number {
  return Math.max(1, Math.ceil(words / WORDS_PER_CREDIT));
}
