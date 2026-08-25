import 'dotenv/config';
import { read901StagingConfig, readScYieldStagingConfig, readTaYieldStagingConfig, readWipStagingConfig } from '../src/config.js';
import { TaYieldStagingRepository } from '../src/taYieldStagingRepository.js';

const quote = (name) => name.split('.').map((part) => `[${part.replace(/]/g, ']]')}]`).join('.');
const ta = readTaYieldStagingConfig(process.env); const base = read901StagingConfig(process.env); const wip = readWipStagingConfig(process.env); const sc = readScYieldStagingConfig(process.env);
if (!ta.ready) throw new Error('Staging configuration is incomplete.');
const pool = await new TaYieldStagingRepository(ta).getPool();
const index = async (table, name, columns, include = '') => { await pool.request().query(`IF OBJECT_ID(N'${table}',N'U') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'${table}') AND name=N'${name}') CREATE INDEX [${name}] ON ${quote(table)} (${columns})${include ? ` INCLUDE (${include})` : ''};`); };
await index(ta.workbookTable, 'IX_DashboardTaYieldWorkbook_Scope', 'ScopeStart, ScopeEnd', 'RefreshedAt');
await index(ta.table, 'IX_DashboardTaYieldLotInput_Scope', 'ScopeStart, ScopeEnd', 'RefreshedAt');
await index(base.table, 'IX_Dashboard901Daily_Filter', 'ReportingDate, Product, Serie', 'QuantityMoved');
await index(wip.table, 'IX_DashboardWipDaily_Filter', 'ReportingDate, Product, Serie', 'QuantityMoved');
await index(wip.processTable, 'IX_DashboardWipProcessDaily_Filter', 'ReportingDate, Product, Serie', 'OperationName, QuantityMoved');
if (sc.ready) await index(sc.table, 'IX_DashboardScYieldSnapshot_Lookup', 'ScopeStart, ScopeEnd, Bucket', 'RefreshedAt');
console.log('Dashboard staging indexes are ready.');
await pool.close();
