import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { buildTaYieldCompareWorkbook } from '../src/taYieldCompareExport.js';

const ranges = { currentRange: { startDate: '2026-09-05', endDate: '2026-09-20' }, compareRange: { startDate: '2026-08-05', endDate: '2026-08-20' } };
const compare = { ...ranges, comparisonMode: 'same-dates', rangeNotes: ['Staged only'], rows: [
  { label: 'Total', currentYield: 95, compareYield: 94, delta: 1, currentInput: 2000, currentGood: 1900, compareInput: 1000, compareGood: 940 },
  { label: '=HYPERLINK("bad")', currentYield: null, compareYield: 95, delta: null, currentInput: 0, currentGood: 0, compareInput: 1000, compareGood: 950 },
  { label: 'FPS A3', currentYield: 90, compareYield: 92, delta: -2, currentInput: 1000, currentGood: 900, compareInput: 1000, compareGood: 920 }
] };
const jobs = Array.from({ length: 75 }, (_, index) => ({ lotNo: index === 0 ? '=1+1' : `6K01N${index}`, line: 'FPS series A3', itemName: 'part', tapingDate: '2026-09-05', input: 2000, good: 1900, yield: 95, defectQty: 100, groups: [{ group: 'ACC', quantity: 100 }] }));
const details = { ...ranges, selection: { label: 'FPS A3', kind: 'series', key: 'FPS SERIES A3' }, current: { input: 2000, good: 1900, yield: 95, lotCount: 75, defectQty: 100 }, compare: { input: 1000, good: 940, yield: 94, lotCount: 1, defectQty: 60 }, groups: [
  { group: 'Other2', currentQty: -10, compareQty: 0, currentRate: -.5, compareRate: 0, deltaRate: -.5 },
  { group: 'ACC & App', currentQty: 30, compareQty: 20, currentRate: 1.5, compareRate: 2, deltaRate: -.5 },
  { group: 'DF', currentQty: 20, compareQty: 0, currentRate: 1, compareRate: 0, deltaRate: 1 }
], lots: { current: { rows: jobs, total: 75 }, compare: { rows: jobs.slice(0, 1), total: 1 } } };

async function load(data, lookup) {
  const bytes = await buildTaYieldCompareWorkbook(data, lookup);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  return { bytes, book, zip: await JSZip.loadAsync(bytes) };
}

describe('Compare Excel workbook', () => {
  it('exports numeric percentages and kpcs, dates, N/A and inert identifier text', async () => {
    const { book } = await load(compare);
    const sheet = book.getWorksheet('Compare');
    expect(sheet.getCell('B8').value).toBe(.95);
    expect(sheet.getCell('B8').numFmt).toBe('0.00%');
    expect(sheet.getCell('D8').value).toBe(1);
    expect(sheet.getCell('E8').value).toBe(2);
    expect(sheet.getCell('B9').value).toBe('N/A');
    expect(sheet.getCell('A9').value).toBe('=HYPERLINK("bad")');
    expect(sheet.getCell('A9').type).toBe(ExcelJS.ValueType.String);
    expect(sheet.getCell('B7').value).toContain('5–20 Sep 2026');
    expect(sheet.getCell('C7').value).toContain('5–20 Aug 2026');
    expect(book.worksheets.map((item) => item.name)).toEqual(['Compare', 'Graphs']);
  });

  it('includes all job records and two native LOOKUP charts excluding neutral Other2', async () => {
    const { book, zip } = await load(compare, details);
    expect(book.getWorksheet('Jobs Report').rowCount).toBe(80);
    expect(book.getWorksheet('Jobs Report').getCell('A6').value).toBe('=1+1');
    expect(book.getWorksheet('Jobs Report').getCell('E6').value).toBe(2);
    expect(book.getWorksheet('Jobs Report').getCell('G6').value).toBe(.95);
    const lookup = book.getWorksheet('LOOKUP');
    expect(lookup.getCell('A12').value).toBe('Other2');
    expect(lookup.getCell('F12').font.color.argb).toBe('FF526078');
    const charts = Object.keys(zip.files).filter((name) => /^xl\/charts\/chart\d+\.xml$/.test(name));
    expect(charts).toHaveLength(3);
    const rates = await zip.file('xl/charts/chart2.xml').async('string');
    expect(rates).toContain('5–20 Sep 2026');
    expect(rates).toContain('5–20 Aug 2026');
    expect(rates).toContain('ACC &amp; App');
    expect(rates).not.toContain('Other2');
    expect(rates).toContain('28358C');
    expect(rates).toContain('007C91');
    expect(rates).not.toContain('<c:dPt>');
    const change = await zip.file('xl/charts/chart3.xml').async('string');
    expect(change).toContain('D32F2F');
    expect(change).toContain('008A3E');
    expect(change).not.toContain('Other2');
    const lowerDefects = change.match(/<c:dPt><c:idx val="0"\/>.*?<\/c:dPt>/s)?.[0];
    expect(lowerDefects).toContain('<c:invertIfNegative val="0"/>');
    expect(lowerDefects).toContain('<a:srgbClr val="008A3E"/>');
  });

  it('has editable worksheet references, cached points with missing gaps, complete internal relationships', async () => {
    const { zip } = await load(compare, details);
    const chart = await zip.file('xl/charts/chart1.xml').async('string');
    expect(chart).toContain("&apos;Compare&apos;!$A$8:$A$10");
    expect(chart).toContain("&apos;Compare&apos;!$D$8:$D$10");
    expect(chart).toContain('<c:ptCount val="3"/>');
    expect(chart).toContain('<c:pt idx="2"><c:v>-2</c:v></c:pt>');
    expect(chart).not.toContain('<c:pt idx="1"><c:v>0</c:v></c:pt>');
    expect(chart).toContain('<c:dispBlanksAs val="gap"/>');
    expect(chart).toContain('008A3E');
    expect(chart).toContain('D32F2F');
    const lowerYield = chart.match(/<c:dPt><c:idx val="2"\/>.*?<\/c:dPt>/s)?.[0];
    expect(lowerYield).toContain('<c:invertIfNegative val="0"/>');
    expect(lowerYield).toContain('<a:srgbClr val="D32F2F"/>');
    const contentTypes = await zip.file('[Content_Types].xml').async('string');
    expect(contentTypes).toContain('/xl/charts/chart3.xml');
    expect(await zip.file('xl/worksheets/_rels/sheet2.xml.rels').async('string')).toContain('relationships/drawing');
    const allRelationships = Object.keys(zip.files).filter((name) => name.endsWith('.rels'));
    for (const name of allRelationships) expect(await zip.file(name).async('string')).not.toContain('TargetMode="External"');
  });

  it('refuses an incomplete page instead of silently truncating exported evidence', async () => {
    await expect(buildTaYieldCompareWorkbook(compare, { ...details, lots: { ...details.lots, current: { rows: jobs.slice(0, 50), total: 75 } } })).rejects.toThrow(/complete|all/i);
  });

  it('handles empty categories and unavailable metrics without invalid chart numeric values', async () => {
    const { zip, book } = await load({ ...compare, rows: [] }, { ...details, groups: [], lots: { current: { rows: [], total: 0 }, compare: { rows: [], total: 0 } } });
    expect(Object.keys(zip.files).filter((name) => /^xl\/charts\/chart\d+\.xml$/.test(name))).toHaveLength(0);
    expect(book.getWorksheet('Compare').getCell('A8').value).toContain('No');
  });

  it('preserves typed job dates, zero rates, single-day and cross-month period labels', async () => {
    const data = { ...compare, comparisonMode: 'full-month', rangeNotes: [], currentRange: { startDate: '2026-09-05', endDate: '2026-09-05' }, compareRange: { startDate: '2026-07-30', endDate: '2026-08-02' }, rows: [{ label: 'Zero', currentYield: 0, compareYield: 0, delta: 0, currentInput: 1000, currentGood: 0, compareInput: 1000, compareGood: 0 }] };
    const lookup = { ...details, groups: [{ group: 'DF', currentQty: 0, compareQty: null, currentRate: 0, compareRate: null, deltaRate: null }] };
    const { book, zip } = await load(data, lookup);
    expect(book.getWorksheet('Compare').getCell('B7').value).toContain('5 Sep 2026');
    expect(book.getWorksheet('Compare').getCell('C7').value).toContain('30 Jul 2026 – 2 Aug 2026');
    expect(book.getWorksheet('LOOKUP').getCell('D10').value).toBe(0);
    expect(book.getWorksheet('LOOKUP').getCell('E10').value).toBe('N/A');
    expect(book.getWorksheet('Jobs Report').getCell('D6').value).toEqual(new Date('2026-09-05T00:00:00Z'));
    const chart = await zip.file('xl/charts/chart2.xml').async('string');
    expect(chart).toContain('<c:v>0</c:v>');
    expect(chart).not.toMatch(/NaN|Infinity/);
  });

  it('keeps missing metrics and absent period metadata explicitly unavailable', async () => {
    const { book } = await load({ rows: [{ label: null, currentYield: Infinity, compareYield: undefined, delta: '', currentInput: null, currentGood: undefined, compareInput: '', compareGood: NaN }] });
    const sheet = book.getWorksheet('Compare');
    expect(sheet.getCell('B7').value).toContain('Date range unavailable');
    for (const column of ['B', 'C', 'D', 'E', 'F', 'G', 'H']) expect(sheet.getCell(`${column}8`).value).toBe('N/A');
    const { book: invalid } = await load({ ...compare, currentRange: { startDate: 'invalid', endDate: 'invalid' } });
    expect(invalid.getWorksheet('Compare').getCell('B7').value).toContain('Date range unavailable');
  });

  it('exports neutral Other2-only data without inventing physical-defect graphs', async () => {
    const { book, zip } = await load(compare, { ...details, selection: {}, current: {}, compare: {}, groups: [details.groups[0]], lots: { current: { total: 1, rows: [{ lotNo: '@SUM(1)', tapingDate: 'invalid', groups: [] }] }, compare: { total: 0, rows: [] } } });
    expect(book.getWorksheet('LOOKUP').getCell('A10').value).toBe('Other2');
    expect(book.getWorksheet('LOOKUP').getCell('F10').font.color.argb).toBe('FF526078');
    expect(book.getWorksheet('Jobs Report').getCell('D6').value).toBe('N/A');
    expect(Object.keys(zip.files).filter((name) => /^xl\/charts\/chart\d+\.xml$/.test(name))).toHaveLength(1);
  });

  it('does not mutate caller-owned comparison data or reorder defect/job records', async () => {
    const freeze = (value) => {
      if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
      return value;
    };
    const data = freeze(JSON.parse(JSON.stringify(compare)));
    const lookup = freeze(JSON.parse(JSON.stringify(details)));
    await expect(buildTaYieldCompareWorkbook(data, lookup)).resolves.toBeInstanceOf(Buffer);
    expect(lookup.groups[0].group).toBe('Other2');
    expect(lookup.lots.current.rows[0].lotNo).toBe('=1+1');
  });
});
