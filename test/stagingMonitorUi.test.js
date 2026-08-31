import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('Staging monitoring dashboard', () => {
  it('renders live pipeline health, progress, and activity without manual refresh controls', () => {
    const app = read('public/app.js');
    const styles = read('public/styles.css');
    const server = read('src/app.js');

    expect(app).toContain('Staging pipeline control room');
    expect(app).toContain('TA Yield live activity');
    expect(app).toContain('stagingMonitorTimer');
    expect(app).toContain('Updated every 10 seconds while this tab is open.');
    expect(app).toContain('pipelines?.taYield');
    expect(app).toContain('data-staging-pipeline');
    expect(app).toContain('showStagingPipelineConsole');
    expect(app).toContain('renderStagingStatusWithRetry');
    expect(app).toContain('Staging pipeline map');
    expect(app).toContain('data-staging-monitor-tab');
    expect(app).toContain('stagingPipelineBlueprint');
    expect(app).toContain('stagingMonitorTab');
    expect(app).toContain('row.table || \'Configured target table\'');
    expect(app).toContain('renderStagingStatusWithPersistentPipelineMap');
    expect(app).not.toContain('Refresh staging now');
    expect(styles).toContain('.staging-monitor');
    expect(styles).toContain('.staging-pipeline-card');
    expect(styles).toContain('.staging-log');
    expect(styles).toContain('.staging-activity-button');
    expect(styles).toContain('.staging-console-dialog');
    expect(styles).toContain('.staging-monitor-tabs');
    expect(styles).toContain('.staging-pipeline-map');
    expect(styles).toContain('.staging-flow-stage');
    expect(server).toContain("updateTaYieldPipeline('FAILED', 'Refresh failed. Check the server log for details.'");
    expect(server).not.toContain("updateTaYieldPipeline('FAILED', error.message");
  });
});
