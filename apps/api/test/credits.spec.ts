import { creditsFor } from '../src/credits/credits';

describe('creditsFor', () => {
  it('charges one credit per started 1000 words, at least one', () => {
    expect([0, 1, 999, 1000, 1001, 2500].map(creditsFor)).toEqual([1, 1, 1, 1, 2, 3]);
  });
});
