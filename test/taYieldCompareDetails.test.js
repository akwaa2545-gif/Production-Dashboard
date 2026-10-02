import { describe, expect, it } from 'vitest';
import { createTaCompareDetailsLimiter, mapTaYieldCompareDetails, validateTaYieldCompareSelection } from '../src/taYieldCompareDetails.js';
const line = 'Ta NEO Capacitor FPS series A3 case';
const lot = (lotNo, categories, extra = {}) => ({ line, lotNo, itemName: 'PN1', tapingDate: '2026-09-01', categories, ...extra });
const selection = { kind: 'total', key: 'Total' };
describe('staged Compare investigation', () => {
  it('bounds per-client investigation reads, expires windows, and keeps clients separate', () => {
    let now = 0;
    const limiter = createTaCompareDetailsLimiter({ now: () => now, limit: 2, windowMs: 60000 });
    const response = { set: () => response, status: (status) => { response.statusCode = status; return response; }, json: (body) => { response.body = body; return response; } };
    let admitted = 0; const next = () => { admitted += 1; };
    limiter({ ip: 'one' }, response, next); limiter({ ip: 'one' }, response, next); limiter({ ip: 'one' }, response, next);
    expect(admitted).toBe(2); expect(response.statusCode).toBe(429); expect(response.body.code).toBe('COMPARE_DETAILS_RATE_LIMIT');
    limiter({ ip: 'two' }, response, next); expect(admitted).toBe(3);
    now = 60000; limiter({ ip: 'one' }, response, next); expect(admitted).toBe(4);
  });
  it('uses all jobs for adjusted denominators, distinct job counts, and signed Other2', () => {
    const current = [lot('6K01N00052', { Input: 100, Good: 80, ESR: 15 }), lot('clean', { Input: 200, Good: 200 })];
    const result = mapTaYieldCompareDetails(current, [lot('old', { Input: 100, Good: 90, ESR: 12 })], new Map(), selection);
    expect(result.current).toMatchObject({ input: 300, good: 280, lotCount: 2, defectQty: 20 });
    expect(result.current.yield).toBeCloseTo(280 / 300 * 100);
    expect(result.groups.find((group) => group.group === 'ESR')).toMatchObject({ currentQty: 15, compareQty: 12, currentRate: 5, compareRate: 12, deltaRate: -7 });
    expect(result.groups.find((group) => group.group === 'Other2')).toMatchObject({ currentQty: 5, compareQty: -2 });
    expect(result.lots.current.total).toBe(1);
    expect(result.lots.current.rows[0]).toMatchObject({ lotNo: '6K01N00052', defectQty: 20 });
  });
  it('returns calendar evidence dates in Bangkok and preserves date-only values', () => {
    const result = mapTaYieldCompareDetails([lot('edge', { Input: 100, Good: 90, ESR: 10 }, { tapingDate: '2026-08-31T17:00:00Z' }), lot('date', { Input: 100, Good: 90, ESR: 10 })], [], new Map(), selection);
    expect(result.lots.current.rows.map((row) => row.tapingDate)).toEqual(['2026-09-01', '2026-09-01']);
  });
  it('deduplicates normalized records, preserves evidence records, and pages affected jobs', () => {
    const first = lot('job', { Input: 100, Good: 90, ESR: 10 });
    const second = lot('job', { Input: 200, Good: 170, ESR: 30 }, { itemName: 'PN2' });
    const result = mapTaYieldCompareDetails([first, first, second, lot('next', { Input: 100, Good: 95, ESR: 5 })], [], new Map(), selection, { offset: 1, limit: 1 });
    expect(result.current).toMatchObject({ input: 400, good: 355, lotCount: 2 });
    expect(result.lots.current).toMatchObject({ total: 3, offset: 1, limit: 1 });
    expect(result.lots.current.rows[0].lotNo).toBe('job');
    expect(result.compare).toMatchObject({ yield: null, lotCount: 0 });
    expect(result.groups.every((group) => group.compareRate === null && group.deltaRate === null)).toBe(true);
  });
  it('keeps canonical case-size selections distinct and rejects nonexistent selections', () => {
    const result = mapTaYieldCompareDetails([lot('a', { Input: 100, Good: 90, ESR: 10 }), lot('b', { Input: 200, Good: 160, ESR: 40 }, { line: `${line} 0603` })], [], new Map(), { kind: 'series', key: line.toUpperCase() });
    expect(result.current.input).toBe(100);
    expect(() => mapTaYieldCompareDetails([], [], new Map(), { kind: 'series', key: 'missing' })).toThrow(/selection/i);
  });
  it.each([{ kind: 'unknown', key: 'Total' }, { kind: ['total'], key: 'Total' }, { kind: 'total', key: 'total' }, { kind: 'group', key: 'BAD' }, { kind: 'series', key: 'a'.repeat(501) }, { kind: 'total', key: 'Total', offset: '-1' }, { kind: 'total', key: 'Total', limit: '101' }, { kind: 'total', key: 'Total', limit: ['1'] }])('rejects invalid selection/pagination %j', (query) => {
    expect(validateTaYieldCompareSelection(query).error).toBeTruthy();
  });
});
