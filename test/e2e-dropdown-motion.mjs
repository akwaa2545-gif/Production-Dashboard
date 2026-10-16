import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

// Read-only component fixture: real dashboard styles, no database or package installs.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright-core');
const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), 'dashboard-dropdown-motion-'));
const sourceHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const stylesheets = sourceHtml.match(/<link\b[^>]*rel="stylesheet"[^>]*>/g)?.join('\n') || '';
const app = express();
app.get('/', (_request, response) => response.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${stylesheets}<style>
body{margin:0;padding:24px;box-sizing:border-box}main{width:100%;max-width:600px;display:grid;gap:24px}.test-row{position:relative;min-width:0}select{width:100%;min-height:38px}.ta-machine-picker,.ta-yield-series-picker{width:max-content;max-width:100%}.ta-machine-picker-menu{left:0;right:auto}.test-row>label{display:block}.dynamic-card{margin-top:10px}
</style></head><body><main>
<div class="test-row"><label for="machineProcess">Process</label><select id="machineProcess"><option value="">Select process</option><optgroup label="Manufacturing"><option value="Welding">Welding</option><option value="Disabled" disabled>Disabled process</option><option value="EI">EI</option></optgroup></select></div>
<div class="test-row"><select id="disabledSelect" disabled aria-label="Disabled process"><option>Unavailable</option></select><select id="multipleSelect" multiple aria-label="Multiple series"><option>A</option><option>B</option></select><select id="listSelect" size="3" aria-label="Series list"><option>A</option><option>B</option></select></div>
<div class="test-row pn-picker"><button id="pnTrigger" aria-expanded="false" aria-controls="pnMenu">Part numbers</button><div id="pnMenu" class="pn-menu" hidden><button class="pn-option">PART-01</button><button class="pn-option">PART-02</button></div></div>
<div class="test-row serie-picker"><button id="serieTrigger" aria-expanded="false" aria-controls="serieMenu">All series</button><div id="serieMenu" class="serie-menu" hidden><label class="serie-option"><input type="checkbox">Series A</label></div></div>
<div class="test-row"><details class="ta-machine-picker" id="machineDetails"><summary class="ta-machine-picker-trigger">Machines</summary><div class="ta-machine-picker-menu"><div class="ta-machine-picker-options"><label><input type="checkbox">MACHINE-01</label></div></div></details></div>
<div class="test-row"><details class="ta-yield-series-picker" id="seriesDetails"><summary class="ta-yield-series-picker-trigger">TA series</summary><div class="ta-yield-series-picker-menu"><label><input type="checkbox">Series A</label></div></details></div>
<button id="addCard">Add graph</button><div id="cards"></div>
</main><script>
for(const prefix of ['pn','serie'])document.getElementById(prefix+'Trigger').addEventListener('click',e=>{const menu=document.getElementById(prefix+'Menu');menu.hidden=!menu.hidden;e.currentTarget.setAttribute('aria-expanded',String(!menu.hidden));});
document.getElementById('addCard').addEventListener('click',()=>document.getElementById('cards').insertAdjacentHTML('beforeend','<div class="dynamic-card ta-machine-comparison-filters"><label>Process<select id="dynamicProcess"><option>Welding</option><option>EI</option></select></label></div>'));
window.frames=[];window.probe=null;function sample(){if(window.probe){const node=document.querySelector(window.probe.selector);const style=getComputedStyle(node,window.probe.pseudo||null);window.frames.push({opacity:Number(style.opacity),display:style.display,contentVisibility:style.contentVisibility,open:node.matches(':open'),duration:style.transitionDuration});}requestAnimationFrame(sample)}requestAnimationFrame(sample);
</script></body></html>`));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
let server;
let browser;
let context;
let page;
const probe = async (selector, pseudo) => page.evaluate(({ selector, pseudo }) => { window.frames = []; window.probe = { selector, pseudo }; }, { selector, pseudo });
const intermediate = async (message) => {
  await page.waitForFunction(() => window.frames.some(frame => frame.opacity > 0 && frame.opacity < 1), null, { timeout: 2500 });
  const frames = await page.evaluate(() => window.frames);
  assert.ok(frames.some(frame => frame.opacity > 0 && frame.opacity < 1), message);
  assert.ok(frames.some(frame => frame.opacity > 0 && frame.opacity < 1 && frame.display !== 'none' && frame.contentVisibility !== 'hidden'), `${message} retains visible popup content`);
};
const finish = async (selector, pseudo, opacity) => page.waitForFunction(({ selector, pseudo, opacity }) => Number(getComputedStyle(document.querySelector(selector), pseudo || null).opacity) === opacity, { selector, pseudo, opacity });
const customCycle = async (trigger, selector, pseudo) => {
  await probe(selector, pseudo);
  await page.locator(trigger).click();
  await intermediate(`${selector} fades in`);
  await finish(selector, pseudo, 1);
  await probe(selector, pseudo);
  await page.locator(trigger).click();
  await intermediate(`${selector} fades out`);
  const closedInteraction = await page.locator(selector).evaluate(node => {
    const child = node.querySelector('button,input');
    child?.focus();
    return { focused: document.activeElement === child, hidden: node.matches('details') ? !node.open : node.hidden };
  });
  assert.equal(closedInteraction.hidden, true);
  assert.equal(closedInteraction.focused, false, 'Closing menus immediately prevent descendant focus');
  await page.screenshot({ path: path.join(artifactDirectory, `${selector.replace(/[^a-z]/gi, '')}-closing.png`) });
  await finish(selector, pseudo, 0);
  assert.equal(await page.locator(selector).evaluate(node => node.matches('details') ? !node.open : node.hidden), true);
  assert.equal(await page.locator(selector).evaluate((node, pseudo) => {
    const style = getComputedStyle(node, pseudo || null);
    return style.display === 'none' || style.contentVisibility === 'hidden';
  }, pseudo), true, 'Closed popup content is finally hidden');
};
try {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  page = await context.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  assert.deepEqual(await page.evaluate(() => ({ base: CSS.supports('appearance', 'base-select'), picker: CSS.supports('selector(::picker(select))'), details: CSS.supports('selector(::details-content)'), discrete: CSS.supports('transition-behavior', 'allow-discrete') })), { base: true, picker: true, details: true, discrete: true });
  assert.equal(await page.locator('#machineProcess').evaluate(node => getComputedStyle(node).appearance), 'base-select', 'native dropdown receives global motion enhancement');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await probe('#machineProcess', '::picker(select)');
    await page.locator('#machineProcess').click();
    await intermediate('Native process picker fades in');
    await finish('#machineProcess', '::picker(select)', 1);
    await page.screenshot({ path: path.join(artifactDirectory, `native-open-${width}.png`) });
    const optionBox = await page.locator('#machineProcess option[value="EI"]').boundingBox();
    assert.ok(optionBox && optionBox.x >= 0 && optionBox.x + optionBox.width <= width, 'Native picker stays inside viewport');
    await page.locator('#machineProcess option[value="EI"]').click();
    assert.equal(await page.locator('#machineProcess').inputValue(), 'EI');
    await finish('#machineProcess', '::picker(select)', 0);
    await page.locator('#machineProcess').click();
    await finish('#machineProcess', '::picker(select)', 1);
    await probe('#machineProcess', '::picker(select)');
    await page.keyboard.press('Escape');
    await intermediate('Native process picker fades out');
    await finish('#machineProcess', '::picker(select)', 0);
    assert.equal(await page.locator('#machineProcess').evaluate(node => node.matches(':open')), false);
    await customCycle('#pnTrigger', '#pnMenu');
    await customCycle('#serieTrigger', '#serieMenu');
    await customCycle('#machineDetails summary', '#machineDetails', '::details-content');
    await customCycle('#seriesDetails summary', '#seriesDetails', '::details-content');
  }
  await page.locator('#machineProcess').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#machineProcess').inputValue(), 'Welding', 'Keyboard skips disabled option');
  assert.equal(await page.locator('#disabledSelect').isDisabled(), true);
  const disabledBox = await page.locator('#disabledSelect').boundingBox();
  await page.mouse.click(disabledBox.x + disabledBox.width / 2, disabledBox.y + disabledBox.height / 2);
  assert.equal(await page.locator('#disabledSelect').evaluate(node => node.matches(':open')), false);
  assert.equal(await page.locator('#machineProcess optgroup').getAttribute('label'), 'Manufacturing');
  for (const selector of ['#multipleSelect', '#listSelect']) assert.notEqual(await page.locator(selector).evaluate(node => getComputedStyle(node).appearance), 'base-select', 'Listboxes retain native appearance');
  await page.locator('#addCard').click();
  assert.equal(await page.locator('#dynamicProcess').evaluate(node => getComputedStyle(node).appearance), 'base-select', 'New graph filters inherit motion automatically');
  await probe('#dynamicProcess', '::picker(select)');
  await page.locator('#dynamicProcess').click();
  await intermediate('Dynamically created graph dropdown fades in');
  await finish('#dynamicProcess', '::picker(select)', 1);
  await probe('#dynamicProcess', '::picker(select)');
  await page.keyboard.press('Escape');
  await intermediate('Dynamically created graph dropdown fades out');
  await finish('#dynamicProcess', '::picker(select)', 0);
  // Reopening during exit must cancel its pending hide and remain operable.
  await page.locator('#pnTrigger').click();
  await finish('#pnMenu', null, 1);
  await page.evaluate(() => { const button = document.querySelector('#pnTrigger'); button.click(); requestAnimationFrame(() => button.click()); });
  await finish('#pnMenu', null, 1);
  await page.locator('#pnMenu .pn-option').first().click();
  await page.locator('#pnTrigger').click();
  await finish('#pnMenu', null, 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const [trigger, selector, pseudo] of [['#machineProcess', '#machineProcess', '::picker(select)'], ['#pnTrigger', '#pnMenu', null], ['#machineDetails summary', '#machineDetails', '::details-content']]) {
    const durations = await page.locator(selector).evaluate((node, pseudo) => getComputedStyle(node, pseudo).transitionDuration, pseudo);
    assert.ok(durations.split(',').every(duration => parseFloat(duration) === 0), `Reduced motion removes ${selector} transition`);
    await page.locator(trigger).click();
    await finish(selector, pseudo, 1);
    if (pseudo === '::picker(select)') await page.keyboard.press('Escape'); else await page.locator(trigger).click();
    await finish(selector, pseudo, 0);
  }
  if (process.env.E2E_LIVE_ORIGIN) {
    // Verify assets and real app wiring from the running dashboard; API data stays read-only and synthetic.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await context.addInitScript(() => sessionStorage.setItem('onemes-dashboard-navigation-v1', JSON.stringify({ dataset: 'ta-yield', view: 'ta-yield-machine', product: 'NEO' })));
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET') return route.abort();
      if (['/api/config', '/api/data-mode'].includes(url.pathname)) return route.continue();
      const data = url.pathname === '/api/options' ? { product: ['NEO'], process: [], serie: ['Fixture series'], case: [], pn: ['PART-01'] }
        : url.pathname === '/api/ta-yield-machine-processes' ? { processes: ['Welding', 'EI'] }
          : url.pathname === '/api/ta-yield-machine-options' ? { machines: ['WELD-01'], codes: [], categories: ['Inproc Dw'] }
            : url.pathname === '/api/ta-yield-machine' ? { linkedModes: ['Welding defect'], totalMachines: 1, rows: [{ date: '2026-10-15', machineName: 'WELD-01', quantity: 12 }] } : [];
      return route.fulfill({ json: { success: true, data } });
    });
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.goto(process.env.E2E_LIVE_ORIGIN);
    await page.waitForFunction(() => {
      const control = document.querySelector('#taMachineProcess');
      return control && !control.disabled && [...control.options].some(option => option.value === 'Welding');
    });
    assert.equal(await page.locator('link[href*="dropdown-motion.css"]').count(), 1, 'Live dashboard loads motion asset');
    await page.locator('#taMachineProcess').selectOption('Welding');
    await page.waitForFunction(() => !document.querySelector('#taMachineDefect').disabled);
    await page.locator('#taMachineDefect').selectOption('category|Inproc Dw');
    await page.locator('#taMachineApply').click();
    await page.locator('#taMachineChart svg').waitFor();
    await page.locator('#taMachineAddGraph').click();
    const dynamic = page.locator('.ta-machine-comparison-card [data-machine-filter="process"]');
    await dynamic.waitFor();
    await page.waitForFunction(() => !document.querySelector('.ta-machine-comparison-card [data-machine-filter="process"]').disabled);
    await dynamic.scrollIntoViewIfNeeded();
    assert.equal(await dynamic.evaluate(node => getComputedStyle(node).appearance), 'base-select');
    await dynamic.click();
    await page.waitForFunction(() => document.querySelector('.ta-machine-comparison-card [data-machine-filter="process"]').matches(':open'));
    await page.screenshot({ path: path.join(artifactDirectory, 'live-dashboard-added-graph-dropdown.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await page.locator('#taMachineProcess').scrollIntoViewIfNeeded();
    await page.locator('#taMachineProcess').click();
    await page.screenshot({ path: path.join(artifactDirectory, 'live-dashboard-main-machine-dropdown.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#taMachineProcess').scrollIntoViewIfNeeded();
    await page.locator('#taMachineProcess').click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#taMachineProcess'), '::picker(select)').opacity === '1');
    const liveOption = await page.locator('#taMachineProcess option[value="Welding"]').boundingBox();
    assert.ok(liveOption && liveOption.x >= 0 && liveOption.x + liveOption.width <= 390, 'Live Machine picker fits mobile viewport');
    await page.screenshot({ path: path.join(artifactDirectory, 'live-dashboard-main-machine-mobile.png'), fullPage: true });
    await page.keyboard.press('Escape');
  }
  console.log(JSON.stringify({ success: true, viewports: [1280, 390], artifacts: artifactDirectory }));
} finally {
  await context?.close();
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
