import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function resolveWorkbookPath(filename) {
  return path.isAbsolute(filename) ? filename : path.resolve(projectRoot, filename);
}

const inputCodes = new Set(['0201_Inp_Pellet_Assy', 'X01_Machine_Sample']);
const otherCodes = new Set(['0301_Sample_CV', '0302_Anodize_Def', '0303_Silicone_Def', '0901_Re_Anod', '0902_Over_Dip_App1', '0903_Bubble_App1', '0904_Other_App1', '1101_Bubble_App2', '1102_Over_Dip_App2', '1103_Bend_Def', '1104_Docking_Def', '1105_Other_App2', '1201_Inp_Deassembly', '1202_Inp_Check1', '1301_Inp_Scrape', '1302_Inp_Notching', '1303_Element_Weld', '1304_Welding_Def', '1305_Adjusting_def', '1306_Other_Weld', '1307_Sample_LC', '1308_Anode_Open', '1309_Image1', '1310_Image2', '1311_Fall', '1312_La_Ex1', '1313_Mount_Pos', '1314_No_Element', '1315_Anode_App', '1316_Inp_Mount', '1317_La_Ex2_GPS', '1318_Cathode_Open', '1319_Image_Def', '1320_Inp_Open_Check', '1321_Tcoat_Head1', '1322_Tcoat_Head2', '1323_Tcoat_Head3', '1324_Tcoat_Head4', '1325_Inp_Tcoat', '1326_Wire_Expose', '1327_Spacer_Exposure', '1328_Element_side', '1329_Mold_Die', '1330_Element_Top', '1401_Inp_Resin_Coat', '1402_Inp_Mold', '1501_Inp_Deflash', '1502_Inp_Mark', '1503_Mark_Expose', '1601_Inp_Heat_Treat1', '1602_Inp_Reflow1', '1603_Inp_Heat_Treat2', '1604_Inp_Armcutting', '1605_Inp_M-Aging', '1701_SH1_Def', '1702_Re1', '1703_Re2', '1704_CO_SH1', '1705_La_Ex2', '1706_Inp_SH1', '1707_Inp_Aging1', '1708_SH2_Def', '1709_CO_SH2', '1710_La_Ex3', '1711_Inp_SH2', '1712_Inp_Reflow2', '1713_Inp_Aging2', '1714_SH3_Def', '1715_CO_SH3', '1716_La_Ex4', '1717_Inp_SH3', '1801_Mold', '1802_Mold_Lack_Crack', '1803_Marking_def', '1804_Element_App', '1805_Side_Expose', '1806_Glue_Def', '1807_Anode_Ter_Flash', '1808_Cathode_Ter_Flash', '1809_Lead_Frame_ Dirty', '1810_Liquid_Leak', '1811_Other_App', '1812_SH_PLS', '1813_PLS_Def', '1814_PLS_Open', '1815_ESR_Def', '1816_B_Grade', '1817_La_Ex5', '1818_Inp_Pulse_ESR', '1901_Inp_Tape_mount', '1902_Lead_Stuck', '1903_Other_Form_Dic', '1904_Inp_Form_Dic', '1905_Inp_Deflash_GPS', '1906_Scratch', '1907_Lead_Frame_ Dirty_GPS', '1908_Terminal_def', '1909_Mold_Lack_Crack_GPS', '1910_Side_Expose_GPS', '1911_Other_App_GPS', '1912_Cam1', '1913_Cam2', '1914_Cam3', '1915_Inp_Pick_n_Place', '1916_Inp_Stick', '1917_Major_Xray', '1918_Minor_Xray', '1919_Inp_Array', '2001_Cam1_GPS', '2002_Cam2_GPS', '2003_Cam3_GPS', '2004_Cam4', '2005_Cam5', '2006_Inp_Picking', '2007_C_Plus', '2008_C_Minus', '2009_DF', '2010_CO', '2011_LC1', '2012_LC2', '2013_LCCO', '2014_ESR_Def', '2015_La_Ex6', '2016_Inp_EI', '2017_SH_PLS_GPS', '2018_PLS_SH_GPS', '2019_PLS_OP_GPS', '2020_PLS_GPS', '2021_CAM6']);
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const code = (value) => String(value ?? '').trim();
const thailandDate = (value) => {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const timestamp = value instanceof Date ? value : new Date(raw);
  return Number.isNaN(timestamp.getTime())
    ? raw.slice(0, 10)
    : new Date(timestamp.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
};
const baseCode = (value) => code(value).replace(/::SH_(?:FALLBACK|ACC_VOLT_ZERO)$/, '');
const isShFallback = (value) => code(value).endsWith('::SH_FALLBACK');
const isShAccVoltZero = (value) => code(value).endsWith('::SH_ACC_VOLT_ZERO');
const graphGroup = (mode, dispositionCode, entry) => {
  if (dispositionCode === '1812_SH_PLS' && (isShFallback(mode) || isShAccVoltZero(mode))) return 'SH';
  return entry?.main || (dispositionCode === '1812_SH_PLS' && entry?.category === 'ACC' ? 'ACC' : '');
};
const validLot = (lotNo) => { const match = String(lotNo || '').match(/(\d{2})N/); return Boolean(match && Number(match[1]) >= 1 && Number(match[1]) <= 31); };
const monthOf = (value) => thailandDate(value).slice(0, 7);
const dayOf = thailandDate;
const weekOf = (value) => {
  const source = thailandDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source)) return '';
  const date = new Date(`${source}T00:00:00Z`);
  const weekDate = new Date(date); weekDate.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(weekDate.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((weekDate - yearStart) / 86400000) + 1) / 7);
  return `${weekDate.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};
const workbookLotKey = (row) => `${row.line}|${row.lotNo}|${row.itemName}|${thailandDate(row.tapingDate)}`;
const mappingFor = (mapping, line) => {
  if (mapping instanceof Map) return mapping;
  return /GPS/i.test(String(line || '')) ? mapping.gps : mapping.neo;
};
const reportingSeries = (line) => {
  const value = String(line || '').trim();
  return value || 'Other TA series';
};
const workbookDefectCategories = ['ACC', 'App', 'CO', 'Cap', 'DF', 'ESR', 'Inproc Dw', 'Inproc Up', 'LC', 'La/Ex1', 'La/Ex2-6', 'PULSE', 'SH'];
export function calculateTaWorkbookLot(categories = {}) {
  const value = (key) => number(categories[key]); const input = value('Input'); const inputMinus = value('Input-'); const good = value('Good'); const defect = workbookDefectCategories.reduce((sum, key) => sum + value(key), 0); const other1 = input - inputMinus - defect - good; const inputF = Math.abs(other1) > 500 ? input - inputMinus - other1 : input - inputMinus; const other2 = Math.abs(other1) > 500 ? 0 : other1; const goodRate = inputF ? good / inputF * 100 : undefined; const defectRate = inputF ? (defect + other2) / inputF * 100 : undefined; const ttl = Number.isFinite(goodRate) && Number.isFinite(defectRate) ? Math.round((goodRate + defectRate) * 100) / 100 : undefined; return { defect, other1, inputF, other2, goodRate, defectRate, ttl, check: Number.isFinite(ttl) ? Math.abs(ttl - 100) : undefined };
}

const collectLots = (rows) => {
  const lots = new Map();
  rows.forEach((source) => {
    const key = `${source.line}|${source.lotNo}`;
    const lot = lots.get(key) || { ...source, inputQ: 0, finalGoodQ: 0, finalGoodOccuredOn: undefined, modes: new Map() };
    lot.inputQ = Math.max(lot.inputQ, number(source.inputQ));
    if (number(source.finalGoodQ) > 0) { lot.finalGoodQ = Math.max(lot.finalGoodQ, number(source.finalGoodQ)); lot.finalGoodOccuredOn = source.occuredOn; }
    const dispositionCode = code(source.dispositionCode);
    if (dispositionCode) lot.modes.set(dispositionCode, (lot.modes.get(dispositionCode) || 0) + number(source.quantity));
    lots.set(key, lot);
  });
  return lots;
};

const calculatedLot = (lot) => {
  const jobClass = String(lot.jobType || '').trim().toUpperCase();
  if (jobClass === 'NON-STANDARD' || jobClass === 'E' || !validLot(lot.lotNo)) return undefined;
  const deductions = [...inputCodes].reduce((sum, code) => sum + (lot.modes.get(code) || 0), 0);
  const usableInput = lot.inputQ - deductions;
  const defectSum = [...lot.modes.entries()].filter(([mode]) => otherCodes.has(baseCode(mode))).reduce((sum, [, quantity]) => sum + quantity, 0);
  const rawOther = usableInput - lot.finalGoodQ - defectSum;
  const input = usableInput > 0 && Math.abs(rawOther) > 500 ? usableInput - rawOther : usableInput;
  if ((input > 0 && lot.finalGoodQ / input <= .3) || (input <= 0 && !lot.modes.size)) return undefined;
  return { input, deductions };
};

const text = (value) => String(value?.richText ? value.richText.map((part) => part.text).join('') : value ?? '').trim();
export async function loadTaYieldMapping(filename) {
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(resolveWorkbookPath(filename));
  const parse = (name, codeColumn, categoryColumn, groupColumn) => { const sheet = workbook.getWorksheet(name); if (!sheet) throw new Error(`TA Yield mapping workbook is missing the ${name} worksheet.`); const map = new Map(); let grouped = 0; sheet.eachRow((row, index) => { if (index === 1) return; const code = text(row.getCell(codeColumn).value); const category = text(row.getCell(categoryColumn).value); const main = text(row.getCell(groupColumn).value); if (!code) return; if (main) grouped += 1; map.set(code, { main, category }); }); if (!grouped) throw new Error(`TA Yield mapping worksheet ${name} has no grouped disposition codes.`); return map; };
  const standard = parse('STD-FPS', 5, 4, 8);
  const gps = parse('GPS', 5, 4, 4);
  return { neo: standard, gps: new Map([...gps, ...standard]) };
}

export async function loadTaWorkbookReconciliationMapping(filename) {
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(resolveWorkbookPath(filename));
  const sheet = workbook.getWorksheet('Sheet1');
  if (!sheet) throw new Error('TA workbook reference is missing Sheet1.');
  const categories = new Map();
  sheet.eachRow((row, index) => { if (index > 1) { const category = text(row.getCell(1).value); const description = text(row.getCell(2).value); if (description) categories.set(description, category); } });
  return categories;
}

export function mapTaWorkbookReconciliationRows(rows, categories) {
  const normalizedLotsByKey = new Map();
  rows.filter((row) => row && typeof row === 'object' && row.categories && typeof row.categories === 'object').forEach((row) => {
    const key = workbookLotKey(row);
    const current = normalizedLotsByKey.get(key);
    if (!current) {
      normalizedLotsByKey.set(key, row);
      return;
    }
    const categoriesByName = new Set([...Object.keys(current?.categories || {}), ...Object.keys(row.categories)]);
    const mergedCategories = Object.fromEntries([...categoriesByName].map((category) => [category, Math.max(number(current?.categories?.[category]), number(row.categories[category]))]));
    normalizedLotsByKey.set(key, { ...current, ...row, categories: mergedCategories, calculation: calculateTaWorkbookLot(mergedCategories) });
  });
  const normalizedLots = [...normalizedLotsByKey.values()].map((row) => ({ ...row, calculation: row.calculation || calculateTaWorkbookLot(row.categories) }));
  const normalizedKeys = new Set(normalizedLots.map(workbookLotKey));
  const lots = new Map();
  rows.filter((row) => !row?.categories || typeof row.categories !== 'object').forEach((row) => {
    if (normalizedKeys.has(workbookLotKey(row))) return;
    const category = code(row.dispositionDescription) === 'ACC' ? 'ACC' : categories.get(code(row.dispositionDescription)) || '';
    if (!category || category === 'X') return;
    const key = workbookLotKey(row);
    const lot = lots.get(key) || { line: row.line, lotNo: row.lotNo, itemName: row.itemName, tapingDate: row.tapingDate, categories: { ACC: 0 } };
    lot.categories = { ...lot.categories, [category]: Number(lot.categories[category] || 0) + Number(row.quantity || 0) };
    lots.set(key, lot);
  });
  return [...normalizedLots, ...lots.values()].map((lot) => ({ ...lot, calculation: lot.calculation || calculateTaWorkbookLot(lot.categories) })).sort((left, right) => `${left.line}|${left.lotNo}`.localeCompare(`${right.line}|${right.lotNo}`));
}

export function mapTaWorkbookYieldRows(rows, categories, period = 'month') {
  const buckets = new Map();
  mapTaWorkbookReconciliationRows(rows, categories).forEach((lot) => {
    const date = thailandDate(lot.tapingDate); const parsed = new Date(`${date}T00:00:00Z`); const weekDate = new Date(parsed); weekDate.setUTCDate(parsed.getUTCDate() + 4 - (parsed.getUTCDay() || 7)); const yearStart = new Date(Date.UTC(weekDate.getUTCFullYear(), 0, 1)); const week = Math.ceil((((weekDate - yearStart) / 86400000) + 1) / 7); const month = period === 'day' ? date : period === 'week' ? `${weekDate.getUTCFullYear()}-W${String(week).padStart(2, '0')}` : date.slice(0, 7);
    const key = `${month}|${lot.line}`;
    const bucket = buckets.get(key) || { month, line: lot.line, input: 0, finalGood: 0, groups: new Map(), unmapped: 0, partNumbers: new Set() };
    const values = lot.categories || {}; const calculation = lot.calculation || calculateTaWorkbookLot(values);
    bucket.input += number(calculation.inputF);
    bucket.finalGood += number(values.Good);
    if (lot.itemName) bucket.partNumbers.add(String(lot.itemName));
    Object.entries(values).forEach(([group, quantity]) => { if (!['Input', 'Input-', 'Good'].includes(group)) bucket.groups.set(group, (bucket.groups.get(group) || 0) + number(quantity)); });
    if (number(calculation.other2)) bucket.groups.set('Other2', (bucket.groups.get('Other2') || 0) + number(calculation.other2));
    buckets.set(key, bucket);
  });
  return [...buckets.values()].map((bucket) => { const groups = [...bucket.groups.entries()].map(([group, quantity]) => ({ group, quantity, rate: bucket.input ? quantity / bucket.input * 100 : undefined })).sort((a, b) => a.group.localeCompare(b.group)); const defect = groups.reduce((sum, group) => sum + group.quantity, 0); return { ...bucket, partNumbers: [...bucket.partNumbers].sort(), groups, defect, defectRate: bucket.input ? defect / bucket.input * 100 : undefined, yield: bucket.input ? bucket.finalGood / bucket.input * 100 : undefined }; }).sort((a, b) => `${a.month}|${a.line}`.localeCompare(`${b.month}|${b.line}`));
}

export function mapTaYieldRows(rows, mapping, period = 'month') {
  const lots = collectLots(rows);
  const buckets = new Map();
  const bucketFor = (month, line) => {
    const key = `${month}|${line}`;
    const current = buckets.get(key) || { month, line, input: 0, finalGood: 0, groups: new Map(), unmapped: 0 };
    buckets.set(key, current);
    return current;
  };
  lots.forEach((lot) => {
    const calculation = calculatedLot(lot); if (!calculation) return;
    const { input } = calculation;
    const inputMonth = period === 'day' ? dayOf(lot.closeDate) : period === 'week' ? weekOf(lot.closeDate) : monthOf(lot.closeDate);
    const validPeriod = period === 'day'
      ? /^\d{4}-\d{2}-\d{2}$/.test(inputMonth)
      : period === 'week'
        ? /^\d{4}-W\d{2}$/.test(inputMonth)
        : /^\d{4}-\d{2}$/.test(inputMonth);
    if (!validPeriod) return;
    const series = reportingSeries(lot.line);
    bucketFor(inputMonth, series).input += input;
    const qualityBucket = bucketFor(inputMonth, series); qualityBucket.finalGood += lot.finalGoodQ;
    const codeMapping = mappingFor(mapping, lot.line);
    codeMapping?.forEach((entry) => { const group = entry.main || (entry.category === 'ACC' ? 'ACC' : ''); if (group && !qualityBucket.groups.has(group)) qualityBucket.groups.set(group, 0); });
    lot.modes.forEach((quantity, mode) => {
      const dispositionCode = baseCode(mode); const entry = codeMapping?.get(dispositionCode);
      const group = graphGroup(mode, dispositionCode, entry);
      if (!inputCodes.has(dispositionCode) && entry?.included !== false && group && quantity) qualityBucket.groups.set(group, (qualityBucket.groups.get(group) || 0) + quantity);
      else if (!inputCodes.has(dispositionCode) && !entry && quantity) qualityBucket.unmapped += quantity;
    });
  });
  return [...buckets.values()].map((bucket) => { const groups = [...bucket.groups.entries()].map(([group, quantity]) => ({ group, quantity, rate: bucket.input ? quantity / bucket.input * 100 : undefined })).sort((a, b) => a.group.localeCompare(b.group)); const defect = groups.reduce((sum, group) => sum + group.quantity, 0); return { ...bucket, groups, defect, defectRate: bucket.input ? defect / bucket.input * 100 : undefined, yield: bucket.input ? bucket.finalGood / bucket.input * 100 : undefined }; }).sort((a, b) => `${a.month}|${a.line}`.localeCompare(`${b.month}|${b.line}`));
}

export function mapTaYieldLotDetails(rows, mapping) {
  return [...collectLots(rows).values()].flatMap((lot) => {
    const calculation = calculatedLot(lot); if (!calculation) return [];
    const codeMapping = mappingFor(mapping, lot.line);
    const grouped = new Map(); const modes = [];
    lot.modes.forEach((quantity, mode) => {
      const dispositionCode = baseCode(mode); const shFallback = isShFallback(mode); const shAccVoltZero = isShAccVoltZero(mode); const entry = codeMapping?.get(dispositionCode); const group = graphGroup(mode, dispositionCode, entry);
      if (!inputCodes.has(dispositionCode) && entry?.included !== false && group && quantity) grouped.set(group, (grouped.get(group) || 0) + quantity);
      const accParameterMatch = dispositionCode === '1812_SH_PLS' && !shFallback && !shAccVoltZero && entry?.category === 'ACC';
      if (quantity) modes.push({ mode: dispositionCode, category: shFallback || shAccVoltZero ? 'SH' : entry?.category || 'Unmapped', quantity, role: inputCodes.has(dispositionCode) ? 'Input deduction' : 'Defect', shFallback, shAccVoltZero, accParameterMatch });
    });
    const groups = [...grouped.entries()].map(([group, quantity]) => ({ group, quantity })).sort((left, right) => left.group.localeCompare(right.group));
    const defect = groups.reduce((sum, group) => sum + group.quantity, 0);
    return [{ series: lot.line, lotNo: lot.lotNo, closeDate: thailandDate(lot.closeDate), input: calculation.input, finalGood: lot.finalGoodQ, defect, yield: calculation.input ? lot.finalGoodQ / calculation.input * 100 : undefined, groups, modes: modes.sort((left, right) => left.mode.localeCompare(right.mode)) }];
  }).sort((left, right) => `${left.series}|${left.lotNo}`.localeCompare(`${right.series}|${right.lotNo}`));
}

export function mapTaYieldMachineEvents(events, lots, selection, groupBy = 'day') {
  const lotModes = new Map(lots.map((lot) => [lot.lotNo, lot.modes || []]));
  const selectedModes = [...new Set([...lotModes.values()].flat().filter((mode) => selection.type === 'category' ? mode.category === selection.value : mode.mode === selection.value).map((mode) => mode.mode))].sort();
  const buckets = new Map();
  const distinctEvents = new Map();
  events.forEach((event) => {
    const date = thailandDate(event.occuredOn);
    const machineName = String(event.machineName || '').trim();
    distinctEvents.set(`${event.lotNo}|${date}|${machineName}`, { ...event, date, machineName });
  });
  distinctEvents.forEach((event) => {
    const modes = lotModes.get(event.lotNo) || [];
    modes.filter((mode) => selection.type === 'category' ? mode.category === selection.value : mode.mode === selection.value).forEach((mode) => {
      const date = groupBy === 'month' ? monthOf(event.date) : groupBy === 'week' ? weekOf(event.date) : event.date;
      const key = `${date}|${event.machineName}|${mode.mode}`;
      const current = buckets.get(key) || { date, machineName: event.machineName, mode: mode.mode, quantity: 0, lotNumbers: new Set() };
      current.quantity += number(mode.quantity);
      current.lotNumbers.add(event.lotNo);
      buckets.set(key, current);
    });
  });
  return { linkedModes: selection.type === 'category' ? selectedModes : [], rows: [...buckets.values()].map((row) => ({ date: row.date, machineName: row.machineName, mode: row.mode, quantity: row.quantity, lotCount: row.lotNumbers.size })).sort((left, right) => `${left.date}|${left.machineName}|${left.mode}`.localeCompare(`${right.date}|${right.machineName}|${right.mode}`)) };
}
