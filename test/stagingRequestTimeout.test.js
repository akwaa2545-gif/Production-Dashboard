import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { read901StagingConfig, readConfig, readScYieldConfig } from '../src/config.js';

const sourceEnvironment = {
  SQL_SERVER: 'mes-server',
  SQL_DATABASE: 'OneMES',
  DATE_COLUMN: 'OccuredOn'
};

const stagingEnvironment = {
  STAGING_SQL_SERVER: 'staging-server',
  STAGING_SQL_DATABASE: 'ProductionMES',
  STAGING_SQL_USER: 'dashboard',
  STAGING_SQL_PASSWORD: 'test-password'
};

describe('staging pipeline SQL timeout configuration', () => {
  it('uses a two-minute request timeout when none is configured', () => {
    expect(readConfig(sourceEnvironment).requestTimeout).toBe(120000);
    expect(readScYieldConfig(sourceEnvironment).requestTimeout).toBe(120000);
    expect(read901StagingConfig(stagingEnvironment).requestTimeout).toBe(120000);
  });

  it('keeps a valid configured request timeout for every pipeline connection', () => {
    const environment = { ...sourceEnvironment, ...stagingEnvironment, SQL_REQUEST_TIMEOUT: '180000' };

    expect(readConfig(environment).requestTimeout).toBe(180000);
    expect(readScYieldConfig(environment).requestTimeout).toBe(180000);
    expect(read901StagingConfig(environment).requestTimeout).toBe(180000);
  });

  it('passes the configured timeout to every staging SQL connection pool', () => {
    ['src/staging901Repository.js', 'src/scYieldStagingRepository.js'].forEach((file) => {
      expect(readFileSync(file, 'utf8')).toContain('requestTimeout: this.config.requestTimeout');
    });
  });
});
