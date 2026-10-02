import { describe, expect, it } from 'vitest';
import { mapTaYieldCompare, taYieldComparePeriods } from '../src/taYieldCompare.js';

describe('accumulated TA yield comparison', () => {
  it('compares weighted yield for Total, reporting families, and series plus case', () => {
    const current = [
      { line: 'Ta NEO Capacitor FPS series A3 case', input: 100, finalGood: 90 },
      { line: 'Ta NEO Capacitor FPS series A3 case', input: 900, finalGood: 720 },
      { line: 'PSL B2', input: 500, finalGood: 450 },
      { line: 'GPS SP2', input: 100, finalGood: 95 }
    ];
    const previous = [{ line: 'Ta NEO Capacitor FPS series A3 case', input: 200, finalGood: 180 }, { line: 'PSL B2', input: 100, finalGood: 80 }, { line: 'GPS SP2', input: 100, finalGood: 90 }];
    const rows = mapTaYieldCompare(current, previous);
    expect(rows.map((row) => row.label)).toEqual(['Total', 'STD', 'FPS', 'GPS', 'FPS A3', 'GPS SP2', 'PSL B2']);
    expect(rows[0].currentYield).toBeCloseTo(1355 / 1600 * 100);
    expect(rows.find((row) => row.label === 'FPS A3')).toMatchObject({ kind: 'series', currentYield: 81, compareYield: 90, delta: -9, currentInput: 1000, currentGood: 810 });
    expect(rows.find((row) => row.label === 'STD')).toMatchObject({ currentYield: 90, compareYield: 80, delta: 10 });
    expect(current[0]).toEqual({ line: 'Ta NEO Capacitor FPS series A3 case', input: 100, finalGood: 90 });
  });

  it('keeps one-sided and zero-input series as unavailable rather than false changes', () => {
    const rows = mapTaYieldCompare([{ line: 'FPS B10', input: 100, finalGood: 90 }, { line: 'FPS A08', input: 0, finalGood: 0 }], [{ line: 'FPS B2', input: 100, finalGood: 80 }, { line: 'FPS A08', input: 100, finalGood: 70 }]);
    expect(rows.slice(4).map((row) => row.label)).toEqual(['FPS A08', 'FPS B2', 'FPS B10']);
    expect(rows.slice(4).every((row) => row.delta === null)).toBe(true);
    expect(rows.find((row) => row.label === 'FPS B2')).toMatchObject({ currentYield: null, compareYield: 80, currentInput: 0 });
    expect(mapTaYieldCompare([], []).every((row) => row.delta === null)).toBe(true);
  });

  it('uses percentage point differences and preserves same-yield zero', () => {
    const rows = mapTaYieldCompare([{ line: 'PSL A', input: 100, finalGood: 95 }], [{ line: 'PSL A', input: 200, finalGood: 190 }]);
    expect(rows[0].delta).toBe(0);
    expect(rows[0].kind).toBe('total');
  });

  it('preserves distinct case sizes that share a shortened series name', () => {
    const current = [
      { line: 'Ta NEO Capacitor FPS series A3 case 0402', input: 100, finalGood: 95 },
      { line: 'Ta NEO Capacitor FPS series A3 case 0603', input: 300, finalGood: 240 }
    ];
    const comparison = [
      { line: ' ta neo capacitor fps series a3 case 0402 ', input: 200, finalGood: 180 },
      { line: 'Ta NEO Capacitor FPS series A3 case 0603', input: 100, finalGood: 90 }
    ];
    const rows = mapTaYieldCompare(current, comparison).filter((row) => row.kind === 'series');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ label: 'FPS A3 · case 0402', currentInput: 100, compareInput: 200, delta: 5 });
    expect(rows[1]).toMatchObject({ label: 'FPS A3 · case 0603', currentInput: 300, compareInput: 100, delta: -10 });
  });
});

describe('comparison calendar periods', () => {
  const today = { startDate: '2026-10-01', endDate: '2026-10-09' };
  it('matches exact report days and returns explicit mode notes', () => {
    expect(taYieldComparePeriods({ comparisonMode: 'same-dates' }, today, { startDate: '2026-09-07', endDate: '2026-09-18' })).toMatchObject({ comparisonMode: 'same-dates', rangeNotes: [], compareRange: { startDate: '2026-08-07', endDate: '2026-08-18' } });
  });
  it('clamps shorter months and current-month availability visibly', () => {
    const short = taYieldComparePeriods({ comparisonMode: 'same-dates', compareMonth: '2024-02' }, today, { startDate: '2024-03-20', endDate: '2024-03-31' });
    expect(short.compareRange).toEqual({ startDate: '2024-02-20', endDate: '2024-02-29' });
    expect(short.rangeNotes.join(' ')).toMatch(/clamp/i);
    const current = taYieldComparePeriods({ comparisonMode: 'full-month', compareMonth: '2026-10' }, today);
    expect(current.rangeNotes.join(' ')).toMatch(/2026-10-09/);
  });
  it.each([
    [{ comparisonMode: 'same-dates' }, { startDate: '2026-08-10', endDate: '2026-09-15' }],
    [{ comparisonMode: 'same-dates', compareMonth: '2026-02' }, { startDate: '2026-03-30', endDate: '2026-03-31' }],
    [{ comparisonMode: 'same-dates', compareMonth: '2026-10' }, { startDate: '2026-09-12', endDate: '2026-09-15' }],
    [{ comparisonMode: 'wrong' }, today],
    [{ comparisonMode: ['same-dates', 'full-month'] }, today],
    [{ comparisonMode: 'same-dates' }, { startDate: '2026-02-31', endDate: '2026-03-01' }],
    [{ comparisonMode: 'full-month' }, { startDate: '2026-02-01', endDate: '2026-02-31' }]
  ])('rejects unsupported fair-period ranges and modes', (query, range) => {
    expect(taYieldComparePeriods(query, today, range).error).toBeTruthy();
  });
  it('defaults to the current accumulated month minus the previous complete month', () => {
    expect(taYieldComparePeriods({}, today)).toEqual({ currentMonth: '2026-10', compareMonth: '2026-09', currentRange: today, compareRange: { startDate: '2026-09-01', endDate: '2026-09-30' } });
  });
  it('handles January rollover, leap February, and historical accumulated months', () => {
    expect(taYieldComparePeriods({}, { startDate: '2026-01-01', endDate: '2026-01-01' }).compareRange).toEqual({ startDate: '2025-12-01', endDate: '2025-12-31' });
    expect(taYieldComparePeriods({ currentMonth: '2024-03', compareMonth: '2024-02' }, today).compareRange.endDate).toBe('2024-02-29');
    expect(taYieldComparePeriods({ currentMonth: '2026-09' }, today).currentRange.endDate).toBe('2026-09-30');
    expect(taYieldComparePeriods({ compareMonth: '2026-10' }, today).compareRange.endDate).toBe('2026-10-09');
  });
  it.each(['2026-13', '2026-00', '2026-1', '2026-11', '0000-01', ['2026-09'], ''])('rejects invalid or future comparison month %j', (compareMonth) => {
    expect(taYieldComparePeriods({ compareMonth }, today).error).toBeTruthy();
  });
  it('rejects malformed current months', () => {
    expect(taYieldComparePeriods({ currentMonth: '2026-11' }, today).error).toBeTruthy();
  });
  it('preserves exact selected report dates and defaults to the month before the start', () => {
    const reportRange = { startDate: '2026-09-07', endDate: '2026-09-18' };
    expect(taYieldComparePeriods({}, today, reportRange)).toEqual({ currentMonth: '2026-09', compareMonth: '2026-08', currentRange: reportRange, compareRange: { startDate: '2026-08-01', endDate: '2026-08-31' } });
  });
  it('compares the entire selected multi-month range without truncating it', () => {
    const reportRange = { startDate: '2026-01-12', endDate: '2026-03-21' };
    const periods = taYieldComparePeriods({}, today, reportRange);
    expect(periods.currentRange).toEqual(reportRange);
    expect(periods.compareMonth).toBe('2025-12');
    expect(taYieldComparePeriods({ compareMonth: '2026-10' }, today, reportRange).compareRange.endDate).toBe('2026-10-09');
  });
});
