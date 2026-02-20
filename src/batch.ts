/**
 * Batch operation utilities for Cloudflare Workers
 *
 * Provides:
 * - BatchTask: Task manager for tracking batch operation progress
 * - runBatch: Generic batch processing with concurrency control
 * - SSE event streaming for real-time progress updates
 */

export interface BatchTaskSnapshot {
  task_id: string;
  status: "running" | "done" | "error" | "cancelled";
  total: number;
  processed: number;
  ok: number;
  fail: number;
  warning?: string;
}

export interface BatchProgressEvent {
  type: "progress";
  task_id: string;
  total: number;
  processed: number;
  ok: number;
  fail: number;
  item?: string;
  detail?: unknown;
  error?: string;
}

export interface BatchDoneEvent {
  type: "done";
  task_id: string;
  total: number;
  processed: number;
  ok: number;
  fail: number;
  warning?: string;
  result: Record<string, unknown>;
}

export interface BatchErrorEvent {
  type: "error";
  task_id: string;
  total: number;
  processed: number;
  ok: number;
  fail: number;
  error: string;
}

export interface BatchCancelledEvent {
  type: "cancelled";
  task_id: string;
  total: number;
  processed: number;
  ok: number;
  fail: number;
}

export type BatchEvent = BatchProgressEvent | BatchDoneEvent | BatchErrorEvent | BatchCancelledEvent;

export class BatchTask {
  public readonly id: string;
  public readonly total: number;
  public processed = 0;
  public ok = 0;
  public fail = 0;
  public status: "running" | "done" | "error" | "cancelled" = "running";
  public warning?: string;
  public result?: Record<string, unknown>;
  public error?: string;
  public readonly createdAt: number;
  public cancelled = false;

  private queues: Array<{ queue: unknown[]; push: (event: BatchEvent) => void }> = [];
  private finalEvent?: BatchEvent;

  constructor(total: number) {
    this.id = crypto.randomUUID().replaceAll("-", "");
    this.total = total;
    this.createdAt = Date.now();
  }

  snapshot(): BatchTaskSnapshot {
    return {
      task_id: this.id,
      status: this.status,
      total: this.total,
      processed: this.processed,
      ok: this.ok,
      fail: this.fail,
      warning: this.warning,
    };
  }

  attach(): { queue: unknown[]; push: (event: BatchEvent) => void } {
    const queue: unknown[] = [];
    const push = (event: BatchEvent) => {
      if (queue.length < 200) {
        queue.push(event);
      }
    };
    const handle = { queue, push };
    this.queues.push(handle);
    return handle;
  }

  detach(handle: { queue: unknown[]; push: (event: BatchEvent) => void }): void {
    const idx = this.queues.indexOf(handle);
    if (idx >= 0) {
      this.queues.splice(idx, 1);
    }
  }

  private publish(event: BatchEvent): void {
    for (const handle of this.queues) {
      try {
        handle.push(event);
      } catch {
        // Drop if queue is full
      }
    }
  }

  record(success: boolean, opts?: { item?: string; detail?: unknown; error?: string }): void {
    this.processed++;
    if (success) {
      this.ok++;
    } else {
      this.fail++;
    }

    const event: BatchProgressEvent = {
      type: "progress",
      task_id: this.id,
      total: this.total,
      processed: this.processed,
      ok: this.ok,
      fail: this.fail,
    };

    if (opts?.item !== undefined) event.item = opts.item;
    if (opts?.detail !== undefined) event.detail = opts.detail;
    if (opts?.error) event.error = opts.error;

    this.publish(event);
  }

  finish(result: Record<string, unknown>, warning?: string): void {
    this.status = "done";
    this.result = result;
    this.warning = warning;

    const event: BatchDoneEvent = {
      type: "done",
      task_id: this.id,
      total: this.total,
      processed: this.processed,
      ok: this.ok,
      fail: this.fail,
      warning: this.warning,
      result,
    };

    this.finalEvent = event;
    this.publish(event);
  }

  failTask(error: string): void {
    this.status = "error";
    this.error = error;

    const event: BatchErrorEvent = {
      type: "error",
      task_id: this.id,
      total: this.total,
      processed: this.processed,
      ok: this.ok,
      fail: this.fail,
      error,
    };

    this.finalEvent = event;
    this.publish(event);
  }

  cancel(): void {
    this.cancelled = true;
  }

  finishCancelled(): void {
    this.status = "cancelled";

    const event: BatchCancelledEvent = {
      type: "cancelled",
      task_id: this.id,
      total: this.total,
      processed: this.processed,
      ok: this.ok,
      fail: this.fail,
    };

    this.finalEvent = event;
    this.publish(event);
  }

  getFinalEvent(): BatchEvent | undefined {
    return this.finalEvent;
  }
}

// Global task registry
const TASKS = new Map<string, BatchTask>();

export function createTask(total: number): BatchTask {
  const task = new BatchTask(total);
  TASKS.set(task.id, task);
  return task;
}

export function getTask(taskId: string): BatchTask | undefined {
  return TASKS.get(taskId);
}

export function deleteTask(taskId: string): void {
  TASKS.delete(taskId);
}

/**
 * Generic batch processing with concurrency control
 */
export async function runBatch<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  options: {
    batchSize?: number;
    task?: BatchTask;
    shouldCancel?: () => boolean;
  } = {},
): Promise<Map<T, { ok: boolean; data?: R; error?: string; cancelled?: boolean }>> {
  const batchSize = Math.max(1, options.batchSize ?? 50);
  const results = new Map<T, { ok: boolean; data?: R; error?: string; cancelled?: boolean }>();

  const processOne = async (item: T): Promise<void> => {
    if ((options.shouldCancel?.() ?? false) || (options.task?.cancelled ?? false)) {
      results.set(item, { ok: false, error: "cancelled", cancelled: true });
      return;
    }

    try {
      const data = await worker(item);
      results.set(item, { ok: true, data });
      options.task?.record(true);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      results.set(item, { ok: false, error });
      options.task?.record(false, { error });
    }
  };

  // Process in batches to avoid creating too many concurrent promises
  for (let i = 0; i < items.length; i += batchSize) {
    if ((options.shouldCancel?.() ?? false) || (options.task?.cancelled ?? false)) {
      break;
    }
    const chunk = items.slice(i, i + batchSize);
    await Promise.all(chunk.map(processOne));
  }

  return results;
}

/**
 * Create SSE stream from BatchTask
 */
export function createBatchEventStream(task: BatchTask): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const handle = task.attach();

      const sendEvent = (event: BatchEvent) => {
        try {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));
        } catch (e) {
          console.error("Failed to send SSE event:", e);
        }
      };

      // Send initial snapshot
      sendEvent({
        type: "progress",
        task_id: task.id,
        total: task.total,
        processed: task.processed,
        ok: task.ok,
        fail: task.fail,
      });

      // Poll for events
      const interval = setInterval(() => {
        while (handle.queue.length > 0) {
          const event = handle.queue.shift() as BatchEvent;
          sendEvent(event);

          // Close stream on final event
          if (event.type === "done" || event.type === "error" || event.type === "cancelled") {
            clearInterval(interval);
            task.detach(handle);
            controller.close();
            return;
          }
        }
      }, 100);

      // Cleanup on stream close
      return () => {
        clearInterval(interval);
        task.detach(handle);
      };
    },
  });
}
