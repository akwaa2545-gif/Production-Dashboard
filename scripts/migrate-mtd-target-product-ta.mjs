import 'dotenv/config';
import sql from 'mssql';

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
  if (process.argv.includes('--apply')) {
    await pool.request().query(`
      IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE parent_object_id = OBJECT_ID(N'dbo.DashboardMtdTarget') AND name = N'CK_DashboardMtdTarget_Product')
        ALTER TABLE [dbo].[DashboardMtdTarget] DROP CONSTRAINT [CK_DashboardMtdTarget_Product];
      ALTER TABLE [dbo].[DashboardMtdTarget] WITH CHECK ADD CONSTRAINT [CK_DashboardMtdTarget_Product]
        CHECK ([Product] IN (N'NEO', N'SC', N'TA'));
    `);
    console.log('MTD target storage now permits NEO, SC, and TA products.');
  }

  const result = await pool.request().query(`
    SELECT definition
    FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID(N'dbo.DashboardMtdTarget')
      AND name = N'CK_DashboardMtdTarget_Product';
  `);
  console.log(result.recordset[0]?.definition || 'Product constraint is not present.');
} finally {
  await pool.close();
}
