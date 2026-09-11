import 'dotenv/config';
import { readWipStagingConfig } from '../src/config.js';
import { StagingWipRepository } from '../src/stagingWipRepository.js';

const config = readWipStagingConfig(process.env);
if (!config.ready) throw new Error('WIP staging configuration is incomplete.');

const table = config.processTable.split('.').map((part) => `[${part.replace(/]/g, ']]')}]`).join('.');
const pool = await new StagingWipRepository(config).getPool();

await pool.request().query(`
  IF OBJECT_ID(N'${config.processTable}', N'U') IS NULL
    THROW 50001, 'WIP process staging table does not exist. Run the WIP staging refresh first.', 1;
  IF COL_LENGTH('${config.processTable}', 'PartNumber') IS NULL
    ALTER TABLE ${table} ADD PartNumber nvarchar(4000) NULL;
`);

console.log(`WIP process PartNumber column is ready: ${config.processTable}`);
await pool.close();
