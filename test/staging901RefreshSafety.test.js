import { describe, expect, it } from 'vitest';
import { missing901SourceDates } from '../src/staging901Refresh.js';

describe('901 staging replacement safety', () => {
  it('detects a staged day omitted from a partially populated MES range', () => {
    const source = [
      { reportingDate: new Date('2026-09-01T00:00:00.000Z') },
      { reportingDate: new Date('2026-09-03T00:00:00.000Z') }
    ];
    const existing = [
      { bucketDate: '2026-09-01' },
      { bucketDate: '2026-09-02' },
      { bucketDate: '2026-09-03' }
    ];
    expect(missing901SourceDates(source, existing)).toEqual(['2026-09-02']);
  });

  it('allows a complete replacement and a genuinely new empty range', () => {
    expect(missing901SourceDates([{ reportingDate: '2026-09-03' }], [{ bucketDate: '2026-09-03' }])).toEqual([]);
    expect(missing901SourceDates([], [])).toEqual([]);
  });
});
