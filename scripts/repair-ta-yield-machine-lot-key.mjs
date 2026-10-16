import 'dotenv/config';
import sql from 'mssql';
import { readTaYieldStagingConfig } from '../src/config.js';
import { TaYieldStagingRepository } from '../src/taYieldStagingRepository.js';

const config = readTaYieldStagingConfig();
if (!config.ready) throw new Error('TA Yield staging configuration is incomplete.');

const quote = (value) => `[${value.replace(/]/g, ']]')}]`;
const table = config.machineLotTable.split('.').map(quote).join('.');
const tableName = config.machineLotTable.split('.').at(-1);
const newPrimaryKey = `PK_${tableName}_RowId`;
const expectedOldKey = ['ScopeMonth', 'LotNo', 'YieldCategory', 'DefectMode'];
const pool = await new TaYieldStagingRepository(config).getPool();

async function inspect() {
  const request = pool.request();
  request.input('tableName', sql.NVarChar(256), config.machineLotTable);
  const result = await request.query(`
    SELECT OBJECT_ID(@tableName, N'U') AS tableId;
    SELECT kc.name AS primaryKeyName, c.name AS columnName
    FROM sys.key_constraints AS kc
    JOIN sys.index_columns AS ic ON ic.object_id=kc.parent_object_id AND ic.index_id=kc.unique_index_id
    JOIN sys.columns AS c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
    WHERE kc.parent_object_id=OBJECT_ID(@tableName, N'U') AND kc.[type]=N'PK' AND ic.key_ordinal>0
    ORDER BY ic.key_ordinal;
    SELECT c.name FROM sys.columns AS c WHERE c.object_id=OBJECT_ID(@tableName, N'U') AND c.is_identity=1;
    SELECT COUNT(*) AS foreignKeyCount FROM sys.foreign_keys WHERE referenced_object_id=OBJECT_ID(@tableName, N'U');
  `);
  if (!result.recordsets[0][0]?.tableId) throw new Error(`${config.machineLotTable} does not exist.`);
  const keyRows = result.recordsets[1];
  return {
    primaryKeyName: keyRows[0]?.primaryKeyName,
    primaryKeyColumns: keyRows.map((row) => row.columnName),
    identityColumns: result.recordsets[2].map((row) => row.name),
    foreignKeyCount: result.recordsets[3][0].foreignKeyCount
  };
}

try {
  const before = await inspect();
  console.log('Machine lot key:', JSON.stringify(before));
  if (before.primaryKeyColumns.join('|') === 'MachineLotRowId' && before.identityColumns.join('|') === 'MachineLotRowId') {
    console.log('Machine lot key is already repaired.');
  } else {
    if (before.primaryKeyColumns.join('|') !== expectedOldKey.join('|') || before.identityColumns.length || before.foreignKeyCount) {
      throw new Error('Unexpected machine lot schema; no changes were made.');
    }
    if (!process.argv.includes('--apply')) {
      console.log('Check complete. Run with --apply during the dashboard maintenance window.');
    } else {
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        const execute = async (statement) => {
          const request = new sql.Request(transaction);
          request.timeout = 600000;
          return request.query(statement);
        };
        await execute('SET LOCK_TIMEOUT 15000');
        const countBefore = (await execute(`SELECT COUNT(*) AS [count] FROM ${table}`)).recordset[0].count;
        await execute(`ALTER TABLE ${table} ADD [MachineLotRowId] bigint IDENTITY(1,1) NOT NULL`);
        await execute(`ALTER TABLE ${table} DROP CONSTRAINT ${quote(before.primaryKeyName)}`);
        await execute(`ALTER TABLE ${table} ADD CONSTRAINT ${quote(newPrimaryKey)} PRIMARY KEY CLUSTERED ([MachineLotRowId])`);
        const countAfter = (await execute(`SELECT COUNT(*) AS [count] FROM ${table}`)).recordset[0].count;
        if (countAfter !== countBefore) throw new Error('Machine lot row count changed during migration.');
        await transaction.commit();
        console.log(`Machine lot key repaired; preserved ${countAfter} rows.`);
      } catch (error) {
        await transaction.rollback().catch(() => undefined);
        throw error;
      }
    }
  }
} finally {
  await pool.close();
}
