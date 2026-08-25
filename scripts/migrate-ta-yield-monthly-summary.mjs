import 'dotenv/config';
import { readTaYieldStagingConfig } from '../src/config.js';
import { TaYieldStagingRepository } from '../src/taYieldStagingRepository.js';

const config = readTaYieldStagingConfig(process.env);
if (!config.ready) throw new Error('TA Yield staging configuration is incomplete.');

const table = config.monthlySummaryTable.split('.').map((part) => `[${part.replace(/]/g, ']]')}]`).join('.');
const pool = await new TaYieldStagingRepository(config).getPool();
await pool.request().query(`
  IF OBJECT_ID(N'${config.monthlySummaryTable}', N'U') IS NULL
  CREATE TABLE ${table} (
    MonthStart date NOT NULL,
    Serie nvarchar(4000) NOT NULL,
    PartNumber nvarchar(4000) NOT NULL,
    DefectGroup nvarchar(200) NOT NULL,
    InputQty decimal(18,4) NOT NULL,
    FinalGoodQty decimal(18,4) NOT NULL,
    DefectQty decimal(18,4) NOT NULL,
    RefreshedAt datetime2 NOT NULL CONSTRAINT DF_DashboardTaYieldMonthlySummary_RefreshedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_DashboardTaYieldMonthlySummary PRIMARY KEY CLUSTERED (MonthStart, Serie, PartNumber, DefectGroup)
  );
  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name=N'IX_DashboardTaYieldMonthlySummary_Lookup' AND object_id=OBJECT_ID(N'${config.monthlySummaryTable}'))
  CREATE INDEX IX_DashboardTaYieldMonthlySummary_Lookup ON ${table} (MonthStart, Serie, PartNumber) INCLUDE (InputQty, FinalGoodQty, DefectQty, RefreshedAt);
`);
console.log(`TA Yield monthly summary table is ready: ${config.monthlySummaryTable}`);
await pool.close();
