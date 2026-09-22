import { describe, expect, it, vi } from 'vitest';
import { settleAll } from '../src/settleAll.js';
import { refreshDefectModeStaging } from '../src/defectModeStagingRefresh.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('settleAll', () => {
  it('returns ordered values and accepts an empty operation list', async () => {
    expect(await settleAll([Promise.resolve('first'), 'second'])).toEqual(['first', 'second']);
    expect(await settleAll([])).toEqual([]);
  });

  it('waits for every sibling before rejecting with the first input rejection reason', async () => {
    const first = deferred();
    const second = deferred();
    const firstError = new Error('first operation failed');
    const settled = vi.fn();
    const result = settleAll([first.promise, second.promise]);
    void result.then(settled, settled);
    second.reject(new Error('second failed sooner'));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    first.reject(firstError);
    await expect(result).rejects.toBe(firstError);
    expect(settled).toHaveBeenCalledOnce();
  });
});

describe('defect mode refresh draining', () => {
  it('keeps a failed write batch pending until its sibling write finishes', async () => {
    const pendingWrite = deferred();
    const failure = new Error('TA write failed');
    const finished = vi.fn();
    const target = { addModes: vi.fn((dataset) => dataset === 'TA' ? Promise.reject(failure) : pendingWrite.promise) };
    const source = { getDefectModes: async () => [{ mode: 'OPEN', description: 'Open' }] };
    const result = refreshDefectModeStaging({ taSource: source, scSource: source, target });
    void result.then(finished, finished);
    await vi.waitFor(() => expect(target.addModes).toHaveBeenCalledTimes(2));
    expect(finished).not.toHaveBeenCalled();
    pendingWrite.resolve();
    await expect(result).rejects.toBe(failure);
  });

  it('drains failed source reads before ending the refresh', async () => {
    const pendingRead = deferred();
    const failure = new Error('TA read failed');
    const finished = vi.fn();
    const target = { addModes: vi.fn() };
    const result = refreshDefectModeStaging({
      taSource: { getDefectModes: () => Promise.reject(failure) },
      scSource: { getDefectModes: () => pendingRead.promise },
      target
    });
    void result.then(finished, finished);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    pendingRead.resolve([{ mode: 'OPEN' }]);
    await expect(result).rejects.toBe(failure);
    expect(target.addModes).not.toHaveBeenCalled();
  });

  it('preserves mode normalization, result counts and empty source validation', async () => {
    const taSource = { getDefectModes: async () => [{ mode: ' open ', description: ' old ' }, { mode: 'OPEN', description: ' Open ' }, { mode: '  ' }] };
    const scSource = { getDefectModes: async () => [{ mode: 'Short', description: ' Short ' }] };
    const target = { addModes: vi.fn().mockResolvedValue(undefined) };
    expect(await refreshDefectModeStaging({ taSource, scSource, target })).toEqual({ ta: 3, sc: 1 });
    expect(target.addModes).toHaveBeenCalledWith('TA', [{ mode: 'OPEN', description: 'Open' }]);
    expect(target.addModes).toHaveBeenCalledWith('SC', [{ mode: 'Short', description: 'Short' }]);
    await expect(refreshDefectModeStaging({ taSource: { getDefectModes: async () => [] }, scSource, target })).rejects.toThrow('MES returned no defect modes.');
  });
});
