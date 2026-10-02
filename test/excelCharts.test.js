import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { addExcelCharts } from '../src/excelCharts.js';

describe('native Excel charts', () => {
  it.each(['column', 'bar'])('keeps explicit signed %s point fills instead of inverting negative bars to white', async (type) => {
    const book = new ExcelJS.Workbook(); book.addWorksheet('Graphs');
    const output = await addExcelCharts(await book.xlsx.writeBuffer(), [{
      sheetId: 1, title: 'Signed changes', type,
      categories: { formula: "'Graphs'!$A$1:$A$4", values: ['Increase', 'Decrease', 'Zero', 'Missing'] },
      series: [{ name: 'Change', formula: "'Graphs'!$B$1:$B$4", values: [1, -2, 0, null], color: '28358C',
        positiveColor: type === 'column' ? '008A3E' : 'D32F2F', negativeColor: type === 'column' ? 'D32F2F' : '008A3E' }]
    }]);
    const zip = await JSZip.loadAsync(output);
    const chart = await zip.file('xl/charts/chart1.xml').async('string');
    const points = [...chart.matchAll(/<c:dPt>(.*?)<\/c:dPt>/gs)].map((match) => match[1]);
    expect(points).toHaveLength(3);
    points.forEach((point, index) => expect(point).toContain(`<c:idx val="${index}"/><c:invertIfNegative val="0"/><c:spPr>`));
    expect(points[0]).toContain(`val="${type === 'column' ? '008A3E' : 'D32F2F'}"`);
    expect(points[1]).toContain(`val="${type === 'column' ? 'D32F2F' : '008A3E'}"`);
    expect(points[2]).toContain('val="526078"');
    expect(chart).not.toContain('<c:invertIfNegative val="1"/>');
  });

  it('escapes all dynamic XML, omits nonfinite cache values, and keeps all paths internal', async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Graphs');
    const buffer = await book.xlsx.writeBuffer();
    const output = await addExcelCharts(buffer, [{ sheetId: 1, title: 'A & <B>\u0001\uFFFE\uD800😀', categories: { formula: "'Graphs'!$A$1:$A$3", values: ['ACC & App', 'DF', 'Missing'] }, series: [{ name: '5–20 Sep 2026', formula: "'Graphs'!$B$1:$B$3", values: [1, -2, null], color: '28358C', positiveColor: '008A3E', negativeColor: 'D32F2F' }], type: 'column', anchor: { fromCol: 0, fromRow: 5, toCol: 12, toRow: 25 }, valueFormat: '0.00" pp"' }]);
    const zip = await JSZip.loadAsync(output);
    const chart = await zip.file('xl/charts/chart1.xml').async('string');
    expect(chart).toContain('A &amp; &lt;B&gt;');
    expect(chart).not.toMatch(/[\u0000-\u0008]/);
    expect(chart).not.toMatch(/[\uFFFE\uFFFF\uD800-\uDFFF]/u);
    expect(chart).toContain('😀');
    expect(chart).not.toMatch(/NaN|Infinity/);
    expect(chart).toContain('<c:ptCount val="3"/>');
    expect(chart.match(/<c:numCache>(.*?)<\/c:numCache>/s)?.[1]).not.toContain('<c:pt idx="2">');
    expect(chart).toContain('<c:numRef>');
    expect(chart).toContain('<c:numCache>');
    const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
    expect(sheet).toContain('<drawing r:id="rIdCompareCharts"/>');
    const drawing = await zip.file('xl/drawings/drawing1.xml').async('string');
    expect(drawing).toContain('<xdr:col>12</xdr:col>');
    const loaded = new ExcelJS.Workbook();
    await loaded.xlsx.load(output);
    expect(loaded.worksheets).toHaveLength(1);
    for (const file of Object.values(zip.files).filter((item) => !item.dir && /\.(xml|rels)$/.test(item.name))) {
      const parser = new SaxesParser({ xmlns: true });
      parser.write(await file.async('string')).close();
    }
  });

  it('retains an existing worksheet relationship and allocates unoccupied native part names', async () => {
    const book = new ExcelJS.Workbook(); book.addWorksheet('Graphs');
    const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
    zip.file('xl/charts/chart4.xml', '<placeholder/>');
    zip.file('xl/drawings/drawing3.xml', '<placeholder/>');
    zip.file('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="internal" Target="../internal.xml"/></Relationships>');
    const output = await addExcelCharts(await zip.generateAsync({ type: 'nodebuffer' }), [{ sheetId: 1, title: 'Chart', type: 'bar', categories: { formula: "'Graphs'!A1", values: ['A'] }, series: [{ name: 'Rate', formula: "'Graphs'!B1", values: [0] }] }]);
    const result = await JSZip.loadAsync(output);
    expect(result.file('xl/charts/chart5.xml')).not.toBeNull();
    expect(result.file('xl/drawings/drawing4.xml')).not.toBeNull();
    expect(await result.file('xl/worksheets/_rels/sheet1.xml.rels').async('string')).toContain('Id="rId1"');
  });

  it('rejects missing or invalid worksheet identifiers and existing drawing collisions', async () => {
    const book = new ExcelJS.Workbook(); book.addWorksheet('Graphs');
    const bytes = await book.xlsx.writeBuffer();
    await expect(addExcelCharts(bytes, [{ sheetId: 0 }])).rejects.toThrow('Invalid chart worksheet');
    await expect(addExcelCharts(bytes, [{ sheetId: 2 }])).rejects.toThrow('worksheet is missing');
    const zip = await JSZip.loadAsync(bytes);
    const path = 'xl/worksheets/sheet1.xml';
    zip.file(path, (await zip.file(path).async('string')).replace('</worksheet>', '<drawing r:id="old"/></worksheet>'));
    await expect(addExcelCharts(await zip.generateAsync({ type: 'nodebuffer' }), [{ sheetId: 1 }])).rejects.toThrow('already has a drawing');
    expect(Buffer.isBuffer(await addExcelCharts(bytes, []))).toBe(true);
  });
});
