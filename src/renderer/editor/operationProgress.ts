import type { OperationProgress } from '@shared/ipc.js';

export interface OperationHandle {
  readonly id: string;
  update(message: string, ratio?: number | null): void;
  /** Yield through a browser paint without ending the operation. */
  waitForPaint(): Promise<void>;
  finish(): void;
}

export interface OperationStatus {
  message: string;
  busy: boolean;
}

type RenderStatus = (status: OperationStatus) => void;
type ScheduleFrame = (callback: () => void) => void;

const scheduleBrowserFrame: ScheduleFrame = (callback) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback());
  else setTimeout(callback, 0);
};

interface ActiveOperation {
  id: string;
  message: string;
  ratio: number | null;
  visible: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Keeps fast work quiet, then turns the status bar into an activity indicator
 * once an operation has actually lasted long enough to need reassurance.
 *
 * Operations can overlap -- a paste while an upload is still sending files --
 * so every one stays tracked until it finishes. The status bar shows the
 * newest visible one; when that finishes, the one beneath it shows again.
 * A newer operation must never end an older one's reporting: the upload kept
 * running with nothing on screen to say so.
 */
export class DelayedOperationProgress {
  private sequence = 0;
  /** In the order they began; the last visible one is on screen. */
  private readonly active = new Map<string, ActiveOperation>();

  constructor(
    private readonly render: RenderStatus,
    private readonly delayMs = 500,
    private readonly scheduleFrame: ScheduleFrame = scheduleBrowserFrame,
  ) {}

  begin(message: string): OperationHandle {
    const id = `operation-${Date.now()}-${++this.sequence}`;
    const operation: ActiveOperation = {
      id,
      message,
      ratio: null,
      visible: false,
      timer: setTimeout(() => {
        if (this.active.get(id) !== operation) return;
        operation.visible = true;
        if (this.shown() === operation) this.renderOperation(operation);
      }, this.delayMs),
    };
    this.active.set(id, operation);
    return {
      id,
      update: (nextMessage, ratio = null) => this.update({ id, message: nextMessage, ratio }),
      waitForPaint: () => this.waitForPaint(id),
      finish: () => this.finish(id),
    };
  }

  /** Accept a detailed phase pushed by the main process. */
  update(progress: OperationProgress): void {
    const operation = this.active.get(progress.id);
    if (!operation) return;
    operation.message = progress.message;
    operation.ratio = progress.ratio;
    if (this.shown() === operation) this.renderOperation(operation);
  }

  finish(id: string): void {
    const operation = this.active.get(id);
    if (!operation) return;
    clearTimeout(operation.timer);
    const wasShown = this.shown() === operation;
    this.active.delete(id);
    if (!wasShown) return;
    const next = this.shown();
    if (next) this.renderOperation(next);
    else this.render({ message: '', busy: false });
  }

  /**
   * Keep the operation alive across two animation frames. A frame callback
   * runs before Chromium paints; the second frame guarantees that the status
   * and the newly-created deck DOM were actually presented in between. This
   * also gives an overdue 500 ms timer a chance to surface after a long,
   * synchronous layout pass blocked the renderer event loop.
   */
  private async waitForPaint(id: string): Promise<void> {
    if (!this.active.has(id)) return;
    await new Promise<void>((resolve) => this.scheduleFrame(resolve));
    if (!this.active.has(id)) return;
    await new Promise<void>((resolve) => this.scheduleFrame(resolve));
  }

  /** The operation the status bar shows: the newest that has been running long enough. */
  private shown(): ActiveOperation | null {
    let newest: ActiveOperation | null = null;
    for (const operation of this.active.values()) if (operation.visible) newest = operation;
    return newest;
  }

  private renderOperation(operation: ActiveOperation): void {
    const percent = operation.ratio === null
      ? ''
      : ` (${Math.round(Math.max(0, Math.min(1, operation.ratio)) * 100)}%)`;
    this.render({ message: `${operation.message}${percent}`, busy: true });
  }
}
