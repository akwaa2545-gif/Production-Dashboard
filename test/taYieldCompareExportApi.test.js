import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

const environment = { SQL_SERVER: 'test', SQL_DATABASE: 'test', DB_AUTH: 'ActiveDirectoryInteractive', DB_VIEW: 'dbo.LotCompleteLog', DATE_COLUMN: 'completedAt' };
const base = '/api/export/ta-yield-compare?dataset=ta-yield&startDate=2026-09-07&endDate=2026-09-18&compareMonth=2026-08&comparisonMode=same-dates';
function fixture(mode = 'staging') {
  const stage = {
    hasWorkbookCoverage: vi.fn(async () => true),
    getWorkbookRows: vi.fn(async (filters) => Array.from({ length: 75 }, (_, index) => ({
      line: 'FPS series A3 case', lotNo: `6K01N${String(index).padStart(5, '0')}`, itemName: 'PN1', tapingDate: filters.startDate,
      categories: { Input: 1000, Good: filters.startDate.startsWith('2026-09') ? 900 : 800, ESR: filters.startDate.startsWith('2026-09') ? 100 : 200 }
    })))
  };
  const mes = vi.fn(async () => { throw new Error('MES must not be used'); });
  const app = createApp({ environment: { ...environment, DASHBOARD_DATA_MODE: mode }, taYieldStagingRepository: stage, taYieldRepository: { getWorkbookReconciliationRows: mes } });
  return { app, stage, mes };
}
function binary(response, callback) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
  response.on('error', callback);
}
describe('Compare Excel API integration', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-08T19:00:00Z')); });
  afterEach(() => vi.useRealTimers());
  it('downloads all tables and three native graphs using both staged periods and full LOOKUP jobs', async () => {
    const { app, stage, mes } = fixture();
    const response = await request(app).get(`${base}&kind=total&key=Total&pn=PN1`).buffer(true).parse(binary);
    expect(response.status).toBe(200);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(response.body);
    expect(book.worksheets.map((sheet) => sheet.name)).toEqual(['Compare', 'Graphs', 'LOOKUP', 'Jobs Report', 'Jobs Compare']);
    expect(book.getWorksheet('Compare').getCell('B8').value).toBe(0.9);
    expect(book.getWorksheet('Compare').getCell('C8').value).toBe(0.8);
    expect(book.getWorksheet('Compare').getCell('E8').value).toBe(75);
    expect(book.getWorksheet('Jobs Report').rowCount).toBe(80);
    expect(book.getWorksheet('Jobs Compare').rowCount).toBe(80);
    expect(book.getWorksheet('Jobs Report').getCell('A6').value).toMatch(/^6K01N/);
    const zip = await JSZip.loadAsync(response.body);
    expect(Object.keys(zip.files).filter((name) => /^xl\/charts\/chart\d+\.xml$/.test(name))).toHaveLength(3);
    expect(stage.getWorkbookRows.mock.calls.map(([filters]) => filters)).toEqual([
      { startDate: '2026-09-07', endDate: '2026-09-18' }, { startDate: '2026-08-07', endDate: '2026-08-18' }
    ]);
    expect(mes).not.toHaveBeenCalled();
  });
  it('exports only the main table and graph when LOOKUP is closed', async () => {
    const { app } = fixture();
    const response = await request(app).get(base).buffer(true).parse(binary);
    expect(response.status).toBe(200);
    const book = new ExcelJS.Workbook(); await book.xlsx.load(response.body);
    expect(book.worksheets.map((sheet) => sheet.name)).toEqual(['Compare', 'Graphs']);
  });
  it.each(['comparisonMode=bad', 'kind=bad&key=Total', 'offset=50', 'startDate=2026-02-31', 'dataset=closed'])('rejects invalid scope without staged reads: %s', async (extra) => {
    const { app, stage } = fixture(); const params = new URLSearchParams(base.split('?')[1]);
    new URLSearchParams(extra).forEach((value, key) => params.set(key, value));
    expect((await request(app).get(`/api/export/ta-yield-compare?${params}`)).status).toBe(400);
    expect(stage.getWorkbookRows).not.toHaveBeenCalled();
  });
  it.each(['live', 'coverage', 'read'])('requires staging and never falls back to MES: %s', async (condition) => {
    const { app, stage, mes } = fixture(condition === 'live' ? 'live' : 'staging');
    if (condition === 'coverage') stage.hasWorkbookCoverage.mockResolvedValue(false);
    if (condition === 'read') stage.getWorkbookRows.mockRejectedValue(new Error('private SQL detail'));
    const response = await request(app).get(base);
    expect(response.status).toBe(503); expect(response.body.code).toBe('TA_COMPARE_STAGING_UNAVAILABLE');
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.body.error).not.toContain('private'); expect(mes).not.toHaveBeenCalled();
  });
});
