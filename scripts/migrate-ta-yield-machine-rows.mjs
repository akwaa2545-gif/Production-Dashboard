import 'dotenv/config';
import { readTaYieldStagingConfig } from '../src/config.js';
import { TaYieldStagingRepository } from '../src/taYieldStagingRepository.js';

const config = readTaYieldStagingConfig(process.env);
if (!config.ready) throw new Error('TA Yield staging configuration is incomplete.');
const quote = (name) => name.split('.').map((part) => `[${part.replace(/]/g, ']]')}]`).join('.');
const eventTable = quote(config.machineRowTable);
const lotTable = quote(config.machineLotTable);
const pool = await new TaYieldStagingRepository(config).getPool();

await pool.request().query(`
  IF OBJECT_ID(N'${config.machineRowTable}', N'U') IS NULL
  CREATE TABLE ${eventTable} (
    ScopeMonth date NOT NULL,
    EventDate date NOT NULL,
    LotNo nvarchar(4000) NOT NULL,
    OperationName nvarchar(4000) NOT NULL,
    MachineName nvarchar(4000) NOT NULL,
    RefreshedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
    PRIMARY KEY CLUSTERED (ScopeMonth, EventDate, LotNo, OperationName, MachineName)
  );
  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name=N'IX_DashboardTaYieldMachineEventRow_Lookup' AND object_id=OBJECT_ID(N'${config.machineRowTable}'))
  CREATE INDEX IX_DashboardTaYieldMachineEventRow_Lookup ON ${eventTable} (EventDate, OperationName, MachineName, LotNo) INCLUDE (ScopeMonth, RefreshedAt);
  IF OBJECT_ID(N'${config.machineLotTable}', N'U') IS NULL
  CREATE TABLE ${lotTable} (
    ScopeMonth date NOT NULL,
    LotNo nvarchar(4000) NOT NULL,
    Serie nvarchar(4000) NOT NULL,
    PartNumber nvarchar(4000) NOT NULL,
    TapingDate date NOT NULL,
    YieldCategory nvarchar(200) NOT NULL,
    DefectMode nvarchar(4000) NOT NULL,
    Quantity decimal(18,4) NOT NULL,
    RefreshedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
    PRIMARY KEY CLUSTERED (ScopeMonth, LotNo, YieldCategory, DefectMode)
  );
  IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name=N'IX_DashboardTaYieldMachineLotDefect_Lookup' AND object_id=OBJECT_ID(N'${config.machineLotTable}'))
  CREATE INDEX IX_DashboardTaYieldMachineLotDefect_Lookup ON ${lotTable} (TapingDate, Serie, PartNumber, LotNo) INCLUDE (YieldCategory, DefectMode, Quantity, ScopeMonth, RefreshedAt);
`);
console.log(`TA Yield normalized Machine tables are ready: ${config.machineRowTable}, ${config.machineLotTable}`);
await pool.close();
