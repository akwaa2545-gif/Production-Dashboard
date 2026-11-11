import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function refreshOptionsForProduct(');
const end = source.indexOf('async function refreshOptionsForProcess(', start);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(product = 'SC') {
  const order = [];
  const elements = { product: { value: product } };
  const options = { serie: product === 'SC' ? ['CAN', 'Element', 'FC', 'FM'] : ['FPS A2'] };
  const context = vm.createContext({
    URLSearchParams,
    byId: (id) => elements[id],
    selectedDataset: () => 'closed',
    setReportControlsLoading: vi.fn(),
    setStatus: vi.fn(),
    request: vi.fn(async () => { order.push('options'); return options; }),
    populateOptions: vi.fn(() => order.push('populate')),
    resetPartNumbers: vi.fn(() => order.push('reset-parts')),
    loadData: vi.fn(async () => order.push('apply')),
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, order, options };
}

describe('product button auto-apply', () => {
  it.each(['NEO', 'SC'])('loads %s results automatically after refreshing its available filters', async (product) => {
    const { context, order, options } = harness(product);
    await context.refreshOptionsForProduct();

    expect(order).toEqual(['options', 'populate', 'reset-parts', 'apply']);
    expect(context.populateOptions).toHaveBeenCalledWith(options);
    expect(context.loadData).toHaveBeenCalledTimes(1);
    const query = new URLSearchParams(context.request.mock.calls[0][0].split('?')[1]);
    expect(query.get('product')).toBe(product);
    expect(query.get('dataset')).toBe('closed');
  });

  it('keeps controls busy until both the filter refresh and automatic data load finish', async () => {
    const { context } = harness();
    const options = deferred();
    const data = deferred();
    context.request.mockReturnValue(options.promise);
    context.loadData.mockReturnValue(data.promise);
    const pending = context.refreshOptionsForProduct();

    expect(context.loadData).not.toHaveBeenCalled();
    expect(context.setReportControlsLoading.mock.calls).toEqual([[true]]);
    options.resolve({ serie: ['FC'] });
    await vi.waitFor(() => expect(context.loadData).toHaveBeenCalledTimes(1));
    expect(context.setReportControlsLoading.mock.calls).toEqual([[true]]);
    data.resolve();
    await pending;
    expect(context.setReportControlsLoading.mock.calls).toEqual([[true], [false]]);
  });

  it('shows an options failure without applying stale filters', async () => {
    const { context } = harness();
    context.request.mockRejectedValue(new Error('Options unavailable'));
    await context.refreshOptionsForProduct();

    expect(context.loadData).not.toHaveBeenCalled();
    expect(context.populateOptions).not.toHaveBeenCalled();
    expect(context.setStatus).toHaveBeenLastCalledWith('Options unavailable');
    expect(context.setReportControlsLoading.mock.calls).toEqual([[true], [false]]);
  });

  it('preserves a data-load error message and releases the product controls', async () => {
    const { context } = harness();
    context.loadData.mockRejectedValue(new Error('Data unavailable'));
    await context.refreshOptionsForProduct();

    expect(context.setStatus).toHaveBeenLastCalledWith('Data unavailable');
    expect(context.setReportControlsLoading.mock.calls).toEqual([[true], [false]]);
  });

  it('also reapplies when the active product is cleared to show all products', async () => {
    const { context } = harness('');
    await context.refreshOptionsForProduct();
    const query = new URLSearchParams(context.request.mock.calls[0][0].split('?')[1]);
    expect(query.has('product')).toBe(false);
    expect(context.loadData).toHaveBeenCalledTimes(1);
  });
});
