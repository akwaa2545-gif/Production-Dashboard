import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readScYieldActionConfig } from '../src/config.js';

describe('SC Yield action storage', () => {
  it('uses TA SQL connection settings with a separate SC-only table', () => {
    const config = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
    const repository = readFileSync(new URL('../src/scYieldActionRepository.js', import.meta.url), 'utf8');
    expect(config).toContain('function readScYieldActionConfig');
    expect(config).toContain('const base = readTaYieldActionConfig(environment);');
    expect(config).toContain("'dbo.DashboardScYieldActions'");
    expect(config).toContain('const separateTable =');
    expect(repository).toContain('export class ScYieldActionRepository');
  });

  it('rejects an SC action table that is the TA action table', () => {
    const environment = { STAGING_SQL_SERVER: 'server', STAGING_SQL_DATABASE: 'database', STAGING_SQL_USER: 'user', STAGING_SQL_PASSWORD: 'password', COMMENT_DISPLAY_NAME: 'Dashboard', TA_YIELD_ACTIONS_SQL_TABLE: 'dbo.DashboardTaYieldActions', SC_YIELD_ACTIONS_SQL_TABLE: 'dbo.DashboardTaYieldActions' };
    expect(readScYieldActionConfig(environment).ready).toBe(false);
  });
});
