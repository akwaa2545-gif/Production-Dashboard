import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { StagingWipRepository } from '../src/stagingWipRepository.js';

describe('StagingWipRepository options', () => {
  it('returns only series from WIP daily staging for a selected product', async () => {
    const calls = { inputs: [], statements: [] };
    const repository = new StagingWipRepository({ table: 'dbo.DashboardWipDaily', processTable: 'dbo.DashboardWipProcessDaily' });
    repository.pool = {
      request: () => {
        const request = {
          input: (...input) => { calls.inputs.push(input); return request; },
          query: (statement) => {
            calls.statements.push(statement);
            return Promise.resolve({ recordset: [{ value: 'FPS A3' }, { value: 'FPS B2' }] });
          }
        };
        return request;
      }
    };

    await expect(repository.getOptions({ product: 'NEO' })).resolves.toEqual({
      process: [],
      serie: ['FPS A3', 'FPS B2'],
      case: [],
      pn: []
    });
    expect(calls.inputs).toContainEqual(['product', expect.anything(), '["NEO"]']);
    expect(calls.statements).toHaveLength(1);
    expect(calls.statements[0]).toContain('[dbo].[DashboardWipDaily]');
    expect(calls.statements[0]).not.toContain('[dbo].[DashboardWipProcessDaily]');
  });
});

describe('WIP staging API options', () => {
  it('serves Lot Complete Log options from WIP staging instead of MES', async () => {
    const stagingWipRepository = { getOptions: () => Promise.resolve({ process: [], serie: ['FPS A3'], case: [], pn: [] }) };
    const repository = { getOptions: () => Promise.reject(new Error('MES must not be queried for staged WIP options')) };
    const environment = {
      SQL_SERVER: 'mes', SQL_DATABASE: 'OneMES_Report_THR', DB_VIEW: 'dbo.ClosedBatch', DATE_COLUMN: 'CloseDate',
      LOT_DB_VIEW: 'PowerBIThailand.LotCompleteLog', LOT_DATE_COLUMN: 'OccuredOn', LOT_PROCESS_COLUMN: 'ProdType', LOT_SERIE_COLUMN: 'Series',
      DASHBOARD_WIP_STAGING_ENABLED: 'true', STAGING_SQL_SERVER: 'staging', STAGING_SQL_DATABASE: 'ProductionMES', STAGING_SQL_USER: 'user', STAGING_SQL_PASSWORD: 'password'
    };

    const response = await request(createApp({ environment, repository, stagingWipRepository }))
      .get('/api/options?dataset=lot&product=NEO');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ process: [], serie: ['FPS A3'], case: [], pn: [] });
  });
});
