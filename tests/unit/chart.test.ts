import { describe, expect, it } from 'vitest';
import { niceTicks } from '../../src/ui/Chart';

describe('Achsenteilung', () => {
  it('deckt den ganzen Wertebereich ab', () => {
    const t = niceTicks(66.7, 87.8);
    expect(t[0]).toBeLessThanOrEqual(66.7);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(87.8);
    expect(niceTicks(50, 50)[0]).toBeLessThanOrEqual(50);
  });
});
