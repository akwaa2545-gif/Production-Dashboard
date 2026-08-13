const identifierPart = /^[A-Za-z_][A-Za-z0-9_]*$/;
const qualifiedIdentifier = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

const requiredSettings = ['SQL_SERVER', 'SQL_DATABASE', 'DATE_COLUMN'];

export function isSafeColumn(value) {
  return typeof value === 'string' && identifierPart.test(value);
}

export function isSafeView(value) {
  return typeof value === 'string' && qualifiedIdentifier.test(value);
}

export function readConfig(environment = process.env) {
  const config = {
    server: environment.SQL_SERVER,
    database: environment.SQL_DATABASE,
    auth: environment.DB_AUTH || 'ActiveDirectoryInteractive',
    appUrl: environment.APP_URL || 'http://localhost:3000/',
    tenantId: environment.AZURE_TENANT_ID,
    view: environment.DB_VIEW || 'dbo.LotCompleteLog',
    dateColumn: environment.DATE_COLUMN,
    processColumn: environment.PROCESS_COLUMN,
    serieColumn: environment.SERIE_COLUMN,
    caseColumn: environment.CASE_COLUMN,
    pnColumn: environment.PN_COLUMN || 'from_itemName',
    groupColumn: environment.GROUP_COLUMN || environment.PN_COLUMN || 'from_itemName',
    quantityColumn: environment.QUANTITY_COLUMN || 'quantityMoved',
    dispositionColumn: environment.DISPOSITION_COLUMN,
    dispositionValue: environment.DISPOSITION_VALUE,
    chartColumn: environment.CHART_COLUMN,
    fromRouteStepColumn: environment.FROM_ROUTE_STEP_COLUMN,
    toRouteStepColumn: environment.TO_ROUTE_STEP_COLUMN,
    fromRouteSequenceColumn: environment.FROM_ROUTE_SEQUENCE_COLUMN,
    toRouteSequenceColumn: environment.TO_ROUTE_SEQUENCE_COLUMN,
    mtdEndOperationColumn: environment.MTD_END_OPERATION_COLUMN,
    mtdEndOperationValue: environment.MTD_END_OPERATION_VALUE,
    mtdExcludedProdLineColumn: environment.MTD_EXCLUDED_PROD_LINE_COLUMN,
    mtdExcludedProdLineValue: environment.MTD_EXCLUDED_PROD_LINE_VALUE,
    excludedProdLineColumn: environment.COMPLETION_EXCLUDED_PROD_LINE_COLUMN,
    excludedProdLineValue: environment.COMPLETION_EXCLUDED_PROD_LINE_VALUE,
    chartExcludedValues: (environment.CHART_EXCLUDED_VALUES || '').split(',').map((value) => value.trim()).filter(Boolean),
    productLookupColumn: environment.PRODUCT_LOOKUP_COLUMN,
    serieBlankProduct: environment.SERIE_BLANK_PRODUCT,
    serieBlankValue: environment.SERIE_BLANK_VALUE,
    serieBlankSourceProduct: environment.SERIE_BLANK_SOURCE_PRODUCT,
    serieBlankSourceColumn: environment.SERIE_BLANK_SOURCE_COLUMN,
    serieBlankSourceFormat: environment.SERIE_BLANK_SOURCE_FORMAT,
    serieActionFallbackView: environment.SERIE_ACTION_FALLBACK_VIEW,
    serieActionFallbackJobColumn: environment.SERIE_ACTION_FALLBACK_JOB_COLUMN,
    serieActionFallbackLineColumn: environment.SERIE_ACTION_FALLBACK_LINE_COLUMN,
    serieActionFallbackSourceJobColumn: environment.SERIE_ACTION_FALLBACK_SOURCE_JOB_COLUMN,
    serieLookupView: environment.SERIE_LOOKUP_VIEW,
    serieSourceJoinColumn: environment.SERIE_SOURCE_JOIN_COLUMN,
    serieLookupJoinColumn: environment.SERIE_LOOKUP_JOIN_COLUMN,
    requestTimeout: Number(environment.SQL_REQUEST_TIMEOUT || 0),
    trustServerCertificate: environment.SQL_TRUST_SERVER_CERTIFICATE === 'true'
  };

  const missing = requiredSettings.filter((setting) => !environment[setting]);
  const invalid = [
    ['DB_VIEW', config.view, isSafeView],
    ['DATE_COLUMN', config.dateColumn, isSafeColumn],
    ['PN_COLUMN', config.pnColumn, isSafeColumn],
    ['GROUP_COLUMN', config.groupColumn, isSafeColumn],
    ['QUANTITY_COLUMN', config.quantityColumn, isSafeColumn],
    ['DISPOSITION_COLUMN', config.dispositionColumn, (value) => !value || isSafeColumn(value)],
    ['CHART_COLUMN', config.chartColumn, (value) => !value || isSafeColumn(value)],
    ['FROM_ROUTE_STEP_COLUMN', config.fromRouteStepColumn, (value) => !value || isSafeColumn(value)],
    ['TO_ROUTE_STEP_COLUMN', config.toRouteStepColumn, (value) => !value || isSafeColumn(value)],
    ['FROM_ROUTE_SEQUENCE_COLUMN', config.fromRouteSequenceColumn, (value) => !value || isSafeColumn(value)],
    ['TO_ROUTE_SEQUENCE_COLUMN', config.toRouteSequenceColumn, (value) => !value || isSafeColumn(value)],
    ['MTD_END_OPERATION_COLUMN', config.mtdEndOperationColumn, (value) => !value || isSafeColumn(value)],
    ['MTD_EXCLUDED_PROD_LINE_COLUMN', config.mtdExcludedProdLineColumn, (value) => !value || isSafeColumn(value)],
    ['COMPLETION_EXCLUDED_PROD_LINE_COLUMN', config.excludedProdLineColumn, (value) => !value || isSafeColumn(value)],
    ['SERIE_LOOKUP_VIEW', config.serieLookupView, (value) => !value || isSafeView(value)],
    ['SERIE_SOURCE_JOIN_COLUMN', config.serieSourceJoinColumn, (value) => !value || isSafeColumn(value)],
    ['SERIE_LOOKUP_JOIN_COLUMN', config.serieLookupJoinColumn, (value) => !value || isSafeColumn(value)],
    ['PRODUCT_LOOKUP_COLUMN', config.productLookupColumn, (value) => !value || isSafeColumn(value)],
    ['SERIE_BLANK_SOURCE_COLUMN', config.serieBlankSourceColumn, (value) => !value || isSafeColumn(value)],
    ['SERIE_BLANK_SOURCE_FORMAT', config.serieBlankSourceFormat, (value) => !value || value === 'neo-capacitor'],
    ['SERIE_ACTION_FALLBACK_VIEW', config.serieActionFallbackView, (value) => !value || isSafeView(value)],
    ['SERIE_ACTION_FALLBACK_JOB_COLUMN', config.serieActionFallbackJobColumn, (value) => !value || isSafeColumn(value)],
    ['SERIE_ACTION_FALLBACK_LINE_COLUMN', config.serieActionFallbackLineColumn, (value) => !value || isSafeColumn(value)],
    ['SERIE_ACTION_FALLBACK_SOURCE_JOB_COLUMN', config.serieActionFallbackSourceJobColumn, (value) => !value || isSafeColumn(value)],
    ['PROCESS_COLUMN', config.processColumn, (value) => !value || isSafeColumn(value)],
    ['SERIE_COLUMN', config.serieColumn, (value) => !value || isSafeColumn(value)],
    ['CASE_COLUMN', config.caseColumn, (value) => !value || isSafeColumn(value)]
  ].filter(([, value, check]) => !check(value)).map(([name]) => name);

  const metadataReady = Boolean(config.server && config.database) && !invalid.includes('DB_VIEW');
  return { ...config, missing, invalid, ready: missing.length === 0 && invalid.length === 0, metadataReady };
}

export function readMtdTargetConfig(environment = process.env) {
  const config = {
    server: environment.SETTINGS_SQL_SERVER,
    database: environment.SETTINGS_SQL_DATABASE,
    user: environment.SETTINGS_SQL_USER,
    password: environment.SETTINGS_SQL_PASSWORD,
    table: environment.SETTINGS_SQL_TABLE || 'dbo.DashboardMtdTarget',
    trustServerCertificate: environment.SETTINGS_SQL_TRUST_SERVER_CERTIFICATE === 'true'
  };
  return { ...config, ready: Boolean(config.server && config.database && config.user && config.password && isSafeView(config.table)) };
}

export function read901StagingConfig(environment = process.env) {
  const config = {
    enabled: environment.DASHBOARD_901_STAGING_ENABLED === 'true',
    server: environment.STAGING_SQL_SERVER,
    database: environment.STAGING_SQL_DATABASE,
    user: environment.STAGING_SQL_USER,
    password: environment.STAGING_SQL_PASSWORD,
    table: environment.STAGING_901_SQL_TABLE || 'dbo.Dashboard901Daily',
    trustServerCertificate: environment.STAGING_SQL_TRUST_SERVER_CERTIFICATE === 'true'
  };
  return { ...config, ready: Boolean(config.server && config.database && config.user && config.password && isSafeView(config.table)) };
}

export function readWipStagingConfig(environment = process.env) {
  const base = read901StagingConfig(environment);
  const table = environment.STAGING_WIP_SQL_TABLE || 'dbo.DashboardWipDaily';
  const processTable = environment.STAGING_WIP_PROCESS_SQL_TABLE || 'dbo.DashboardWipProcessDaily';
  return { ...base, enabled: environment.DASHBOARD_WIP_STAGING_ENABLED === 'true', table, processTable, ready: Boolean(base.server && base.database && base.user && base.password && isSafeView(table) && isSafeView(processTable)) };
}

export function readScYieldTargetConfig(environment = process.env) {
  const base = readMtdTargetConfig(environment);
  const table = environment.SC_YIELD_TARGETS_SQL_TABLE || 'dbo.DashboardScYieldTarget';
  return { ...base, table, ready: Boolean(base.ready && isSafeView(table)) };
}

export function readTaYieldTargetConfig(environment = process.env) {
  const base = readMtdTargetConfig(environment);
  const table = environment.TA_YIELD_TARGETS_SQL_TABLE || 'dbo.DashboardTaYieldTarget';
  return { ...base, table, ready: Boolean(base.ready && isSafeView(table)) };
}

export function readCellCommentConfig(environment = process.env) {
  const base = readMtdTargetConfig(environment);
  const config = { ...base, table: environment.COMMENTS_SQL_TABLE || 'dbo.DashboardCellComments', displayName: environment.COMMENT_DISPLAY_NAME };
  return { ...config, ready: Boolean(base.ready && isSafeView(config.table) && typeof config.displayName === 'string' && /^[^<>]{1,255}$/.test(config.displayName)) };
}

export function readDatasetConfig(environment = process.env, dataset = 'closed') {
  const prefix = dataset === 'lot' ? 'LOT' : 'CLOSED';
  const datasetEnvironment = {
    ...environment,
    DB_VIEW: environment[`${prefix}_DB_VIEW`] || environment.DB_VIEW,
    DATE_COLUMN: environment[`${prefix}_DATE_COLUMN`] || environment.DATE_COLUMN,
    PROCESS_COLUMN: environment[`${prefix}_PROCESS_COLUMN`] || environment.PROCESS_COLUMN,
    SERIE_COLUMN: environment[`${prefix}_SERIE_COLUMN`] || environment.SERIE_COLUMN,
    CASE_COLUMN: environment[`${prefix}_CASE_COLUMN`] || environment.CASE_COLUMN,
    PN_COLUMN: environment[`${prefix}_PN_COLUMN`] || environment.PN_COLUMN,
    GROUP_COLUMN: environment[`${prefix}_GROUP_COLUMN`] || environment.GROUP_COLUMN,
    QUANTITY_COLUMN: environment[`${prefix}_QUANTITY_COLUMN`] || environment.QUANTITY_COLUMN,
    DISPOSITION_COLUMN: environment[`${prefix}_DISPOSITION_COLUMN`] || environment.DISPOSITION_COLUMN,
    DISPOSITION_VALUE: environment[`${prefix}_DISPOSITION_VALUE`] || environment.DISPOSITION_VALUE,
    CHART_COLUMN: environment[`${prefix}_CHART_COLUMN`] || environment.CHART_COLUMN,
    FROM_ROUTE_STEP_COLUMN: environment[`${prefix}_FROM_ROUTE_STEP_COLUMN`] || environment.FROM_ROUTE_STEP_COLUMN,
    TO_ROUTE_STEP_COLUMN: environment[`${prefix}_TO_ROUTE_STEP_COLUMN`] || environment.TO_ROUTE_STEP_COLUMN,
    FROM_ROUTE_SEQUENCE_COLUMN: environment[`${prefix}_FROM_ROUTE_SEQUENCE_COLUMN`] || environment.FROM_ROUTE_SEQUENCE_COLUMN,
    TO_ROUTE_SEQUENCE_COLUMN: environment[`${prefix}_TO_ROUTE_SEQUENCE_COLUMN`] || environment.TO_ROUTE_SEQUENCE_COLUMN,
    MTD_END_OPERATION_COLUMN: environment[`${prefix}_MTD_END_OPERATION_COLUMN`] || environment.MTD_END_OPERATION_COLUMN,
    MTD_END_OPERATION_VALUE: environment[`${prefix}_MTD_END_OPERATION_VALUE`] || environment.MTD_END_OPERATION_VALUE,
    MTD_EXCLUDED_PROD_LINE_COLUMN: environment[`${prefix}_MTD_EXCLUDED_PROD_LINE_COLUMN`] || environment.MTD_EXCLUDED_PROD_LINE_COLUMN,
    MTD_EXCLUDED_PROD_LINE_VALUE: environment[`${prefix}_MTD_EXCLUDED_PROD_LINE_VALUE`] || environment.MTD_EXCLUDED_PROD_LINE_VALUE,
    COMPLETION_EXCLUDED_PROD_LINE_COLUMN: dataset === 'closed' ? environment.CLOSED_COMPLETION_EXCLUDED_PROD_LINE_COLUMN || environment.CLOSED_MTD_EXCLUDED_PROD_LINE_COLUMN || environment.COMPLETION_EXCLUDED_PROD_LINE_COLUMN : undefined,
    COMPLETION_EXCLUDED_PROD_LINE_VALUE: dataset === 'closed' ? environment.CLOSED_COMPLETION_EXCLUDED_PROD_LINE_VALUE || environment.CLOSED_MTD_EXCLUDED_PROD_LINE_VALUE || environment.COMPLETION_EXCLUDED_PROD_LINE_VALUE : undefined,
    CHART_EXCLUDED_VALUES: environment[`${prefix}_CHART_EXCLUDED_VALUES`] || environment.CHART_EXCLUDED_VALUES,
    PRODUCT_LOOKUP_COLUMN: environment[`${prefix}_PRODUCT_LOOKUP_COLUMN`] || environment.PRODUCT_LOOKUP_COLUMN,
    SERIE_BLANK_PRODUCT: environment[`${prefix}_SERIE_BLANK_PRODUCT`] || environment.SERIE_BLANK_PRODUCT,
    SERIE_BLANK_VALUE: environment[`${prefix}_SERIE_BLANK_VALUE`] || environment.SERIE_BLANK_VALUE,
    SERIE_BLANK_SOURCE_PRODUCT: environment[`${prefix}_SERIE_BLANK_SOURCE_PRODUCT`] || environment.SERIE_BLANK_SOURCE_PRODUCT,
    SERIE_BLANK_SOURCE_COLUMN: environment[`${prefix}_SERIE_BLANK_SOURCE_COLUMN`] || environment.SERIE_BLANK_SOURCE_COLUMN,
    SERIE_BLANK_SOURCE_FORMAT: environment[`${prefix}_SERIE_BLANK_SOURCE_FORMAT`] || environment.SERIE_BLANK_SOURCE_FORMAT,
    SERIE_ACTION_FALLBACK_VIEW: environment[`${prefix}_SERIE_ACTION_FALLBACK_VIEW`] || environment.SERIE_ACTION_FALLBACK_VIEW,
    SERIE_ACTION_FALLBACK_JOB_COLUMN: environment[`${prefix}_SERIE_ACTION_FALLBACK_JOB_COLUMN`] || environment.SERIE_ACTION_FALLBACK_JOB_COLUMN,
    SERIE_ACTION_FALLBACK_LINE_COLUMN: environment[`${prefix}_SERIE_ACTION_FALLBACK_LINE_COLUMN`] || environment.SERIE_ACTION_FALLBACK_LINE_COLUMN,
    SERIE_ACTION_FALLBACK_SOURCE_JOB_COLUMN: environment[`${prefix}_SERIE_ACTION_FALLBACK_SOURCE_JOB_COLUMN`] || environment.SERIE_ACTION_FALLBACK_SOURCE_JOB_COLUMN,
    SERIE_LOOKUP_VIEW: environment[`${prefix}_SERIE_LOOKUP_VIEW`] || environment.SERIE_LOOKUP_VIEW,
    SERIE_SOURCE_JOIN_COLUMN: environment[`${prefix}_SERIE_SOURCE_JOIN_COLUMN`] || environment.SERIE_SOURCE_JOIN_COLUMN,
    SERIE_LOOKUP_JOIN_COLUMN: environment[`${prefix}_SERIE_LOOKUP_JOIN_COLUMN`] || environment.SERIE_LOOKUP_JOIN_COLUMN
  };
  return { ...readConfig(datasetEnvironment), dataset };
}

export function readScYieldConfig(environment = process.env) {
  const config = {
    server: environment.SQL_SERVER,
    database: environment.SQL_DATABASE,
    auth: environment.DB_AUTH || 'ActiveDirectoryInteractive',
    appUrl: environment.APP_URL || 'http://localhost:3000/',
    tenantId: environment.AZURE_TENANT_ID,
    requestTimeout: Number(environment.SQL_REQUEST_TIMEOUT || 0),
    trustServerCertificate: environment.SQL_TRUST_SERVER_CERTIFICATE === 'true',
    view: environment.SC_YIELD_DB_VIEW || 'PowerBIThailand.CompleteAction_v',
    dateColumn: environment.SC_YIELD_DATE_COLUMN || 'OccuredOn',
    jobColumn: environment.SC_YIELD_JOB_COLUMN || 'JobName',
    partNumberColumn: environment.SC_YIELD_PART_NUMBER_COLUMN || 'From_ItemName',
    productColumn: environment.SC_YIELD_PRODUCT_COLUMN || 'ProdType',
    productValue: environment.SC_YIELD_PRODUCT_VALUE || 'SC',
    lineColumn: environment.SC_YIELD_LINE_COLUMN || 'ProdLine',
    operationColumn: environment.SC_YIELD_OPERATION_COLUMN || 'From_OperationName',
    inputOperationValue: environment.SC_YIELD_INPUT_OPERATION_VALUE || 'SFG_input',
    dispositionTypeColumn: environment.SC_YIELD_DISPOSITION_TYPE_COLUMN || 'DispositionType',
    dispositionCodeColumn: environment.SC_YIELD_DISPOSITION_CODE_COLUMN || 'DispositionCode',
    quantityColumn: environment.SC_YIELD_QUANTITY_COLUMN || 'QuantityMoved',
    closedView: environment.CLOSED_DB_VIEW || 'PowerBIThailand.ClosedBatch_v',
    closedJobColumn: environment.SC_YIELD_CLOSED_JOB_COLUMN || 'JobName',
    closedPartNumberColumn: environment.SC_YIELD_CLOSED_PART_NUMBER_COLUMN || 'PartNumber',
    closedProductColumn: environment.CLOSED_PROCESS_COLUMN || 'ProdType',
    closedSerieColumn: environment.SC_YIELD_CLOSED_SERIE_COLUMN || environment.CLOSED_SERIE_COLUMN || 'Series',
    closedDateColumn: environment.SC_YIELD_CLOSED_DATE_COLUMN || environment.CLOSED_DATE_COLUMN || 'CloseDate',
    closedCategoryColumn: environment.SC_YIELD_CLOSED_CATEGORY_COLUMN || 'Category',
    closedCategoryValue: environment.SC_YIELD_CLOSED_CATEGORY_VALUE || 'FG',
    closedGrossQuantityColumn: environment.SC_YIELD_CLOSED_GROSS_QTY_COLUMN || 'GrossQty',
    closedEndOperationColumn: environment.CLOSED_MTD_END_OPERATION_COLUMN,
    closedEndOperationValue: environment.CLOSED_MTD_END_OPERATION_VALUE,
    closedProdLineColumn: environment.CLOSED_MTD_EXCLUDED_PROD_LINE_COLUMN,
    closedProdLineValue: environment.CLOSED_MTD_EXCLUDED_PROD_LINE_VALUE,
    mappingFile: environment.SC_YIELD_MAPPING_FILE || 'SC/Yield Calculation SC.xlsx'
  };
  const invalid = [
    ['SC_YIELD_DB_VIEW', config.view, isSafeView], ['SC_YIELD_DATE_COLUMN', config.dateColumn, isSafeColumn], ['SC_YIELD_JOB_COLUMN', config.jobColumn, isSafeColumn], ['SC_YIELD_PART_NUMBER_COLUMN', config.partNumberColumn, isSafeColumn],
    ['SC_YIELD_PRODUCT_COLUMN', config.productColumn, isSafeColumn], ['SC_YIELD_LINE_COLUMN', config.lineColumn, isSafeColumn], ['SC_YIELD_OPERATION_COLUMN', config.operationColumn, isSafeColumn],
    ['SC_YIELD_DISPOSITION_TYPE_COLUMN', config.dispositionTypeColumn, isSafeColumn], ['SC_YIELD_DISPOSITION_CODE_COLUMN', config.dispositionCodeColumn, isSafeColumn], ['SC_YIELD_QUANTITY_COLUMN', config.quantityColumn, isSafeColumn],
    ['SC_YIELD_CLOSED_JOB_COLUMN', config.closedJobColumn, isSafeColumn], ['SC_YIELD_CLOSED_PART_NUMBER_COLUMN', config.closedPartNumberColumn, isSafeColumn], ['SC_YIELD_CLOSED_SERIE_COLUMN', config.closedSerieColumn, isSafeColumn], ['SC_YIELD_CLOSED_DATE_COLUMN', config.closedDateColumn, isSafeColumn], ['SC_YIELD_CLOSED_CATEGORY_COLUMN', config.closedCategoryColumn, isSafeColumn], ['SC_YIELD_CLOSED_GROSS_QTY_COLUMN', config.closedGrossQuantityColumn, isSafeColumn], ['CLOSED_DB_VIEW', config.closedView, isSafeView], ['CLOSED_PROCESS_COLUMN', config.closedProductColumn, isSafeColumn],
    ['CLOSED_MTD_END_OPERATION_COLUMN', config.closedEndOperationColumn, (value) => !value || isSafeColumn(value)], ['CLOSED_MTD_EXCLUDED_PROD_LINE_COLUMN', config.closedProdLineColumn, (value) => !value || isSafeColumn(value)]
  ].filter(([, value, check]) => !check(value)).map(([name]) => name);
  const missing = ['SQL_SERVER', 'SQL_DATABASE'].filter((setting) => !environment[setting]);
  return { ...config, invalid, missing, ready: !missing.length && !invalid.length, metadataReady: Boolean(config.server && config.database) && !invalid.includes('SC_YIELD_DB_VIEW') };
}

export function readTaYieldConfig(environment = process.env) {
  const configuredView = environment.TA_YIELD_DB_VIEW;
  const view = configuredView === 'PowerBIThailand.Yield_v' ? 'PowerBIThailand.ClosedBatch_v' : configuredView || 'PowerBIThailand.ClosedBatch_v';
  const config = { server: environment.SQL_SERVER, database: environment.SQL_DATABASE, auth: environment.DB_AUTH || 'ActiveDirectoryInteractive', appUrl: environment.APP_URL || 'http://localhost:3000/', tenantId: environment.AZURE_TENANT_ID, requestTimeout: Number(environment.SQL_REQUEST_TIMEOUT || 0), trustServerCertificate: environment.SQL_TRUST_SERVER_CERTIFICATE === 'true', view, releasedJobView: environment.TA_YIELD_RELEASED_JOB_DB_VIEW || 'KMESV3.ReleasedJob', defectView: environment.TA_YIELD_DEFECT_DB_VIEW || 'PowerBIThailand.CompleteAction_v', parameterView: environment.TA_YIELD_PARAMETER_VIEW || 'PowerBIThailand.ParametersECP_v', finalGoodDispositionCode: environment.TA_YIELD_FINAL_GOOD_DISPOSITION_CODE || 'To rteTaping_ALL', productValue: environment.TA_YIELD_PRODUCT_VALUE || 'NEO', linePrefix: environment.TA_YIELD_LINE_PREFIX || 'Ta NEO Capacitor%', mappingFile: environment.TA_YIELD_MAPPING_FILE || 'TA/Direction and guidance for TA Yield report.xlsx', excludedJobType: environment.TA_YIELD_EXCLUDED_JOB_TYPE || 'NON-STANDARD' };
  const invalid = [['TA_YIELD_DB_VIEW', config.view, isSafeView], ['TA_YIELD_RELEASED_JOB_DB_VIEW', config.releasedJobView, isSafeView], ['TA_YIELD_DEFECT_DB_VIEW', config.defectView, isSafeView], ['TA_YIELD_PARAMETER_VIEW', config.parameterView, isSafeView]].filter(([, value, check]) => !check(value)).map(([name]) => name);
  const missing = ['SQL_SERVER', 'SQL_DATABASE'].filter((setting) => !environment[setting]);
  return { ...config, invalid, missing, ready: !missing.length && !invalid.length, metadataReady: Boolean(config.server && config.database) && !invalid.length };
}

export function publicTaYieldConfig(config) { return { server: config.server, database: config.database, view: config.view, filters: { process: false, serie: true, case: false, pn: false }, chartAxis: 'yield', ready: config.ready, ...(config.ready ? {} : { missing: [...config.missing, ...config.invalid] }) }; }

export function publicConfig(config) {
  return {
    server: config.server,
    database: config.database,
    view: config.view,
    filters: {
      process: Boolean(config.processColumn),
      serie: Boolean(config.serieColumn),
      case: Boolean(config.caseColumn),
      pn: Boolean(config.pnColumn)
    },
    chartAxis: config.chartColumn ? 'process' : 'date',
    ready: config.ready,
    ...(config.ready ? {} : { missing: [...config.missing, ...config.invalid] })
  };
}

export function publicScYieldConfig(config) {
  return {
    server: config.server,
    database: config.database,
    view: config.view,
    filters: { process: false, serie: true, case: false, pn: false },
    chartAxis: 'yield',
    ready: config.ready,
    ...(config.ready ? {} : { missing: [...config.missing, ...config.invalid] })
  };
}

export function publicDataModel(config) {
  return {
    dataset: config.dataset,
    view: config.view,
    columns: {
      reportingDate: config.dateColumn,
      productOrProcess: config.processColumn,
      serie: config.serieColumn,
      partNumber: config.pnColumn,
      quantity: config.quantityColumn,
      sourceOperation: config.chartColumn,
      fromRouteStep: config.fromRouteStepColumn,
      toRouteStep: config.toRouteStepColumn,
      fromRouteSequence: config.fromRouteSequenceColumn,
      toRouteSequence: config.toRouteSequenceColumn,
      disposition: config.dispositionColumn,
      prodLine: config.serieBlankSourceColumn
    },
    seriesLookup: config.serieLookupView ? {
      view: config.serieLookupView,
      sourceJoinColumn: config.serieSourceJoinColumn,
      lookupJoinColumn: config.serieLookupJoinColumn,
      productColumn: config.productLookupColumn,
      serieColumn: config.serieColumn
    } : undefined
  };
}
