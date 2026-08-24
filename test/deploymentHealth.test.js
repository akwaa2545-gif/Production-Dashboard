import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('deployment health', () => {
  it('identifies the Git revision served by a supervised dashboard', async () => {
    const environment = {
      DEPLOY_REVISION: 'abc123',
      SQL_SERVER: 'server',
      SQL_DATABASE: 'database',
      DB_VIEW: 'dbo.LotCompleteLog',
      DATE_COLUMN: 'completedAt',
      PROCESS_COLUMN: 'processName',
      SERIE_COLUMN: 'serie',
      CASE_COLUMN: 'caseNumber',
      PN_COLUMN: 'from_itemName'
    };
    const response = await request(createApp({ environment })).get('/api/health');

    expect(response.body).toEqual({ success: true, data: { status: 'ok', revision: 'abc123' } });
  });
});
