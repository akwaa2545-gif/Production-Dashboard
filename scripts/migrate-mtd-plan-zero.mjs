import 'dotenv/config';
import sql from 'mssql';

const constraintName = 'CK_DashboardMtdTarget_MonthlyPlan';
const tableName = '[dbo].[DashboardMtdTarget]';
const config = {
  server: process.env.SETTINGS_SQL_SERVER,
  database: process.env.SETTINGS_SQL_DATABASE,
  user: process.env.SETTINGS_SQL_USER,
  password: process.env.SETTINGS_SQL_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: process.env.SETTINGS_SQL_TRUST_SERVER_CERTIFICATE === 'true'
  }
};

if (!config.server || !config.database || !config.user || !config.password) {
  throw new Error('Settings database configuration is incomplete.');
}

const pool = await sql.connect(config);
try {
  const result = await pool.request().query(`
    SELECT name, definition
    FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID(N'dbo.DashboardMtdTarget')
      AND name = N'${constraintName}';`);
  const existing = result.recordset[0];
  console.log(existing ? `Current constraint: ${existing.definition}` : 'Monthly-plan constraint is not present.');

  if (process.argv.includes('--apply')) {
    await pool.request().query(`
      IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE parent_object_id = OBJECT_ID(N'dbo.DashboardMtdTarget') AND name = N'${constraintName}')
        ALTER TABLE ${tableName} DROP CONSTRAINT [${constraintName}];
      ALTER TABLE ${tableName} WITH CHECK ADD CONSTRAINT [${constraintName}] CHECK ([MonthlyPlan] >= 0);`);
    console.log('MonthlyPlan now permits zero and rejects negative values.');
  }
} finally {
  await pool.close();
}
