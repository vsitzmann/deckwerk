import { describe, expect, it, vi } from 'vitest';
import { DelayedOperationProgress } from '../src/renderer/editor/operationProgress.js';

describe('delayed operation progress', () => {
  it('keeps sub-500 ms work quiet', () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const progress = new DelayedOperationProgress(render);
    const operation = progress.begin('Opening presentation…');

    vi.advanceTimersByTime(499);
    operation.finish();
    vi.runAllTimers();

    expect(render).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('shows the latest phase after 500 ms and clears it on completion', () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const progress = new DelayedOperationProgress(render);
    const operation = progress.begin('Opening presentation…');
    operation.update('Reading example/deck.json', 0.25);

    vi.advanceTimersByTime(500);
    expect(render).toHaveBeenLastCalledWith({
      message: 'Reading example/deck.json (25%)',
      busy: true,
    });

    progress.update({ id: operation.id, message: 'Reading theme.css', ratio: 0.75 });
    expect(render).toHaveBeenLastCalledWith({
      message: 'Reading theme.css (75%)',
      busy: true,
    });

    operation.finish();
    expect(render).toHaveBeenLastCalledWith({ message: '', busy: false });
    vi.useRealTimers();
  });

  it('ignores phase updates from a different operation', () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const progress = new DelayedOperationProgress(render);
    const operation = progress.begin('Exporting…');
    progress.update({ id: 'stale-operation', message: 'Wrong file', ratio: 1 });

    vi.advanceTimersByTime(500);
    expect(render).toHaveBeenLastCalledWith({ message: 'Exporting…', busy: true });
    operation.finish();
    vi.useRealTimers();
  });

  it('keeps the operation active until the browser has painted the loaded view', async () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const frames: Array<() => void> = [];
    const progress = new DelayedOperationProgress(render, 500, (callback) => frames.push(callback));
    const operation = progress.begin('Opening presentation…');

    vi.advanceTimersByTime(500);
    operation.update('Finishing initial display', 0.99);
    const painted = operation.waitForPaint();

    expect(frames).toHaveLength(1);
    frames.shift()?.();
    await Promise.resolve();
    expect(frames).toHaveLength(1);
    expect(render).toHaveBeenLastCalledWith({
      message: 'Finishing initial display (99%)',
      busy: true,
    });

    frames.shift()?.();
    await painted;
    operation.finish();
    expect(render).toHaveBeenLastCalledWith({ message: '', busy: false });
    vi.useRealTimers();
  });

  it('keeps reporting an operation that a shorter one overlapped', () => {
    // An upload still sending files when a paste began: the paste took the
    // status bar, and the upload's later phases were dropped as stale.
    vi.useFakeTimers();
    const render = vi.fn();
    const progress = new DelayedOperationProgress(render);
    const upload = progress.begin('Uploading to lab…');
    vi.advanceTimersByTime(500);
    upload.update('Uploading assets/a.mp4 (1 of 3 files)', 0.3);

    const paste = progress.begin('Pasting clipboard content');
    vi.advanceTimersByTime(500);
    expect(render).toHaveBeenLastCalledWith({ message: 'Pasting clipboard content', busy: true });

    // The paste is on screen; the upload's phase is kept, not drawn over it.
    progress.update({ id: upload.id, message: 'Uploading assets/b.mp4 (2 of 3 files)', ratio: 0.6 });
    expect(render).toHaveBeenLastCalledWith({ message: 'Pasting clipboard content', busy: true });

    paste.finish();
    expect(render).toHaveBeenLastCalledWith({
      message: 'Uploading assets/b.mp4 (2 of 3 files) (60%)',
      busy: true,
    });
    progress.update({ id: upload.id, message: 'Uploading assets/c.mp4 (3 of 3 files)', ratio: 0.9 });
    expect(render).toHaveBeenLastCalledWith({
      message: 'Uploading assets/c.mp4 (3 of 3 files) (90%)',
      busy: true,
    });

    upload.finish();
    expect(render).toHaveBeenLastCalledWith({ message: '', busy: false });
    vi.useRealTimers();
  });

  it('leaves a long operation on screen when a quick one overlaps it', () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const progress = new DelayedOperationProgress(render);
    const upload = progress.begin('Uploading to lab…');
    vi.advanceTimersByTime(500);
    expect(render).toHaveBeenLastCalledWith({ message: 'Uploading to lab…', busy: true });
    render.mockClear();

    const paste = progress.begin('Pasting clipboard content');
    vi.advanceTimersByTime(100);
    paste.finish();
    vi.runOnlyPendingTimers();

    expect(render).not.toHaveBeenCalled();
    upload.update('Uploading assets/a.mp4', 0.5);
    expect(render).toHaveBeenLastCalledWith({ message: 'Uploading assets/a.mp4 (50%)', busy: true });
    upload.finish();
    vi.useRealTimers();
  });

  it('clears the status only when the last operation finishes, in any order', () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const progress = new DelayedOperationProgress(render);
    const first = progress.begin('First');
    const second = progress.begin('Second');
    vi.advanceTimersByTime(500);
    expect(render).toHaveBeenLastCalledWith({ message: 'Second', busy: true });

    first.finish();
    expect(render).toHaveBeenLastCalledWith({ message: 'Second', busy: true });
    second.finish();
    expect(render).toHaveBeenLastCalledWith({ message: '', busy: false });
    const calls = render.mock.calls.length;
    second.finish();
    expect(render).toHaveBeenCalledTimes(calls);
    vi.useRealTimers();
  });
});
