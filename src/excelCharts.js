import JSZip from 'jszip';

const chartNs = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const drawingNs = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const relationNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const xml = (value) => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF\uD800-\uDFFF]/gu, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const validNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const fill = (color) => `<c:spPr><a:solidFill><a:srgbClr val="${xml(color)}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>`;
const font = '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000"/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>';

function stringReference(categories) {
  const points = categories.values.map((value, index) => `<c:pt idx="${index}"><c:v>${xml(value)}</c:v></c:pt>`).join('');
  return `<c:strRef><c:f>${xml(categories.formula)}</c:f><c:strCache><c:ptCount val="${categories.values.length}"/>${points}</c:strCache></c:strRef>`;
}

function numberReference(series, format) {
  const points = series.values.map((value, index) => validNumber(value) ? `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>` : '').join('');
  return `<c:numRef><c:f>${xml(series.formula)}</c:f><c:numCache><c:formatCode>${xml(format)}</c:formatCode><c:ptCount val="${series.values.length}"/>${points}</c:numCache></c:numRef>`;
}

function chartSeries(series, index, categories, format) {
  const overrides = series.values.map((value, point) => {
    if (!validNumber(value) || !series.positiveColor || !series.negativeColor) return '';
    const color = value > 0 ? series.positiveColor : value < 0 ? series.negativeColor : '526078';
    // Explicit point formatting also needs inversion disabled; series-only settings can leave negative bars hollow in Excel.
    return `<c:dPt><c:idx val="${point}"/><c:invertIfNegative val="0"/>${fill(color)}</c:dPt>`;
  }).join('');
  return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:v>${xml(series.name)}</c:v></c:tx>${fill(series.color || '28358C')}<c:invertIfNegative val="0"/>${overrides}<c:cat>${stringReference(categories)}</c:cat><c:val>${numberReference(series, format)}</c:val></c:ser>`;
}

function title(value) {
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="1"/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>${xml(value)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
}

function chartXml(chart, index) {
  const horizontal = chart.type === 'bar';
  const categoryId = 10000 + index * 2; const valueId = categoryId + 1;
  const format = chart.valueFormat || '0.00';
  const series = chart.series.map((item, position) => chartSeries(item, position, chart.categories, format)).join('');
  const legend = chart.series.length > 1 ? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/>${font}</c:legend>` : '';
  const axes = `<c:catAx><c:axId val="${categoryId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'l' : 'b'}"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${font}<c:crossAx val="${valueId}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>`
    + `<c:valAx><c:axId val="${valueId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'b' : 'l'}"/><c:majorGridlines><c:spPr><a:ln><a:solidFill><a:srgbClr val="E2E7F1"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="${xml(format)}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${font}<c:crossAx val="${categoryId}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
  return `${xmlHeader}<c:chartSpace xmlns:c="${chartNs}" xmlns:a="${drawingNs}" xmlns:r="${relationNs}"><c:lang val="en-US"/><c:roundedCorners val="0"/><c:chart>${title(chart.title)}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:barChart><c:barDir val="${horizontal ? 'bar' : 'col'}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="60"/><c:overlap val="0"/><c:axId val="${categoryId}"/><c:axId val="${valueId}"/></c:barChart>${axes}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="0"/></c:chart><c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>${font}</c:chartSpace>`;
}

function marker(kind, col, row) {
  return `<xdr:${kind}><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:${kind}>`;
}

function drawingAnchor(chart, chartId) {
  const anchor = chart.anchor || { fromCol: 0, fromRow: 0, toCol: 12, toRow: 24 };
  return `<xdr:twoCellAnchor>${marker('from', anchor.fromCol, anchor.fromRow)}${marker('to', anchor.toCol, anchor.toRow)}<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${chartId}" name="Compare chart ${chartId}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${chartNs}"><c:chart xmlns:c="${chartNs}" xmlns:r="${relationNs}" r:id="rIdChart${chartId}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
}

const relationships = (entries) => `${xmlHeader}<Relationships xmlns="${packageNs}">${entries.join('')}</Relationships>`;
const relationship = (id, type, target) => `<Relationship Id="${id}" Type="${relationNs}/${type}" Target="${target}"/>`;
const nextPart = (zip, pattern) => 1 + Math.max(0, ...Object.keys(zip.files).map((path) => Number(path.match(pattern)?.[1] || 0)));

// ExcelJS has no native chart writer. This adds chart/drawing parts only; cell data stays owned by ExcelJS.
export async function addExcelCharts(buffer, charts) {
  if (!charts.length) return Buffer.from(buffer);
  const zip = await JSZip.loadAsync(buffer);
  let chartId = nextPart(zip, /^xl\/charts\/chart(\d+)\.xml$/);
  let drawingId = nextPart(zip, /^xl\/drawings\/drawing(\d+)\.xml$/);
  const overrides = [];
  for (const sheetId of [...new Set(charts.map((chart) => chart.sheetId))]) {
    if (!Number.isSafeInteger(sheetId) || sheetId < 1) throw new Error('Invalid chart worksheet id.');
    const sheetPath = `xl/worksheets/sheet${sheetId}.xml`;
    const file = zip.file(sheetPath);
    if (!file) throw new Error('Chart worksheet is missing.');
    const sheet = await file.async('string');
    if (/<drawing\b/.test(sheet)) throw new Error('Chart worksheet already has a drawing.');
    const sheetCharts = charts.filter((chart) => chart.sheetId === sheetId);
    const anchors = []; const chartRelationships = [];
    for (const chart of sheetCharts) {
      zip.file(`xl/charts/chart${chartId}.xml`, chartXml(chart, chartId));
      anchors.push(drawingAnchor(chart, chartId));
      chartRelationships.push(relationship(`rIdChart${chartId}`, 'chart', `../charts/chart${chartId}.xml`));
      overrides.push(`<Override PartName="/xl/charts/chart${chartId}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
      chartId += 1;
    }
    zip.file(`xl/drawings/drawing${drawingId}.xml`, `${xmlHeader}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="${drawingNs}">${anchors.join('')}</xdr:wsDr>`);
    zip.file(`xl/drawings/_rels/drawing${drawingId}.xml.rels`, relationships(chartRelationships));
    const relPath = `xl/worksheets/_rels/sheet${sheetId}.xml.rels`;
    const existing = zip.file(relPath) ? await zip.file(relPath).async('string') : relationships([]);
    if (/Id="rIdCompareCharts"/.test(existing)) throw new Error('Chart relationship already exists.');
    zip.file(relPath, existing.replace('</Relationships>', `${relationship('rIdCompareCharts', 'drawing', `../drawings/drawing${drawingId}.xml`)}</Relationships>`));
    // Drawing precedes worksheet extensions in the SpreadsheetML sequence.
    const drawing = '<drawing r:id="rIdCompareCharts"/>';
    zip.file(sheetPath, sheet.includes('<extLst') ? sheet.replace('<extLst', `${drawing}<extLst`) : sheet.replace('</worksheet>', `${drawing}</worksheet>`));
    overrides.push(`<Override PartName="/xl/drawings/drawing${drawingId}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
    drawingId += 1;
  }
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml', contentTypes.replace('</Types>', `${overrides.join('')}</Types>`));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
