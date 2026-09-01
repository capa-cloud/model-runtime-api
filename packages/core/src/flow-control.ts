import { RuntimeError } from "./errors.js";

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ConcurrencyGate {
  readonly maxConcurrency: number;
  readonly maxQueueDepth: number;
  #active = 0;
  readonly #queue: Waiter[] = [];

  constructor(maxConcurrency = 16, maxQueueDepth = 64) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error("maxConcurrency must be a positive integer");
    }
    if (!Number.isInteger(maxQueueDepth) || maxQueueDepth < 0) {
      throw new Error("maxQueueDepth must be a non-negative integer");
    }
    this.maxConcurrency = maxConcurrency;
    this.maxQueueDepth = maxQueueDepth;
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#queue.length;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new RuntimeError("cancelled", "Execution was cancelled"));
    }
    if (this.#active < this.maxConcurrency) {
      this.#active += 1;
      return Promise.resolve(this.#releaseOnce());
    }
    if (this.#queue.length >= this.maxQueueDepth) {
      return Promise.reject(
        new RuntimeError("queue_full", "Provider execution queue is full", { retryable: true }),
      );
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(new RuntimeError("cancelled", "Execution was cancelled"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#queue.push(waiter);
    });
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#drain();
    };
  }

  #drain(): void {
    while (this.#active < this.maxConcurrency && this.#queue.length > 0) {
      const waiter = this.#queue.shift();
      if (!waiter || waiter.signal?.aborted) continue;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      this.#active += 1;
      waiter.resolve(this.#releaseOnce());
    }
  }
}
