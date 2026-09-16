import type { EventEmitter } from "../events/event-emitter.js";
import type { ClientEvents } from "../client/client.js";
import type { HttpMethod, Priority, SchedulerOptions, SchedulerRateLimitOptions } from "../types.js";
import { CancelledError } from "../errors.js";
import { delay } from "../utils/timing.js";

export type ParkReason = "retry" | "retry-after" | "rate-limit";

export const PRIORITIES: readonly Priority[] = ["high", "normal", "low"];

/** Weighted round-robin interest per lane. Guarantees low-priority traffic still gets served. */
const PRIORITY_WEIGHTS: Record<Priority, number> = { high: 4, normal: 2, low: 1 };

/** Stats exposed by `client.scheduler.stats()`. */
export interface SchedulerStats {
  /** Requests holding a network slot right now. */
  active: number;
  /** Requests waiting in the priority lanes. */
  queued: number;
  /** Requests parked until a future moment (backoff / Retry-After / rate budget). */
  delayed: number;
  /** Requests that finished their full lifecycle (success or terminal error). */
  completed: number;
  /** Requests stopped by the scheduler (queue cancellation, cancelGroup, cancelAll). */
  rejected: number;
  /** How many queued requests sit in each lane. */
  lanes: Record<Priority, number>;
}

/**
 * Control surface handed to a job's executor while it holds the network slot.
 */
export interface JobControl {
  /**
   * Pause this job for `ms`, releasing its network slot while waiting, and
   * resolve once the scheduler re-admits it (e.g. after a backoff or the
   * server's Retry-After window). Rejects if the request is cancelled while
   * parked.
   */
  park(ms: number, reason: ParkReason): Promise<void>;
}

export interface SubmitInput<T> {
  key: string;
  method: HttpMethod;
  url: string;
  /** Hostname used for per-host concurrency accounting. */
  host: string;
  group?: string;
  priority: Priority;
  signal: AbortSignal;
  /** Abort the underlying request (used by cancelGroup / cancelAll). */
  abort: () => void;
  /**
   * This job is the designated half-open probe: once admitted it MUST run, so
   * the pre-start gate is skipped for it.
   */
  probe?: boolean;
  /** Executes the actual request; the scheduler gates when it starts and resumes. */
  execute: (control: JobControl) => Promise<T>;
}

export interface StartCheckMeta {
  id: number;
  key: string;
  method: HttpMethod;
  url: string;
  priority: Priority;
}

type Phase = "queued" | "parked" | "running" | "done";

interface Job {
  id: number;
  phase: Phase;
  key: string;
  method: HttpMethod;
  url: string;
  host: string;
  group?: string;
  priority: Priority;
  signal: AbortSignal;
  abort: () => void;
  execute: (control: JobControl) => Promise<unknown>;
  hasStarted: boolean;
  cancelledByGroup: boolean;
  probe: boolean;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  parkSettle?: { resolve: () => void; reject: (error: unknown) => void };
  parkTimer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

/**
 * Deterministic request scheduler.
 *
 * Decides WHEN a request may touch the network:
 *   - weighted priority lanes (high/normal/low) with FIFO within a lane,
 *   - global + per-host concurrency, client-side rate limiting,
 *   - queue groups that can be paused, resumed, cancelled or re-prioritized,
 *   - backoff / Retry-After / rate-limit delays park a running job (slot freed).
 *
 * The scheduler does not know about caching, deduplication, or circuit
 * breakers — it only schedules executor callbacks.
 */
export class Scheduler {
  private readonly enabled: boolean;
  private readonly priorityEnabled: boolean;
  private readonly concurrency: number;
  private readonly hosts: Record<string, number>;
  private readonly rateLimit?: SchedulerRateLimitOptions;
  private readonly pattern: Priority[] = [];
  private patternCursor = 0;
  private readonly lanes: Record<Priority, Job[]> = { high: [], normal: [], low: [] };
  private readonly parked = new Map<number, Job>();
  private readonly jobs = new Map<number, Job>();
  private readonly pausedGroups = new Set<string>();
  private readonly rateHistory: number[] = [];
  private active = 0;
  private readonly hostActive = new Map<string, number>();
  private completed = 0;
  private rejectedCount = 0;
  private nextId = 1;
  private readonly getNow: () => number;
  private readonly beforeStart?: (meta: StartCheckMeta) => unknown | undefined;

  constructor(
    options: SchedulerOptions | undefined,
    private readonly events: EventEmitter<ClientEvents>,
    getNow: () => number = Date.now,
    beforeStart?: (meta: StartCheckMeta) => unknown | undefined,
  ) {
    this.enabled = options !== undefined && options.enabled !== false;
    this.priorityEnabled = options?.priority ?? false;
    this.concurrency = options?.concurrency ?? 8;
    this.hosts = options?.hosts ?? {};
    this.rateLimit = options?.rateLimit;
    this.getNow = getNow;
    this.beforeStart = beforeStart;
    // priority: false → a single `normal` lane (plain FIFO; request-level
    // priorities and `prioritize()` are inert). priority: true → weighted
    // round-robin across high/normal/low (4:2:1) so low-priority traffic is
    // never starved by a high-priority flood.
    const weights = this.priorityEnabled ? PRIORITY_WEIGHTS : { high: 0, normal: 1, low: 0 };
    for (const priority of PRIORITIES) {
      for (let i = 0; i < weights[priority]; i += 1) {
        this.pattern.push(priority);
      }
    }
  }

  /**
   * Queue a request for execution. The returned promise settles with the
   * executor's outcome once the scheduler admits the job (or earlier if the
   * job is cancelled / rejected while waiting).
   */
  submit<T>(input: SubmitInput<T>): Promise<T> {
    let job!: Job;
    const promise = new Promise<T>((resolve, reject) => {
      job = {
        id: this.nextId,
        phase: "done",
        key: input.key,
        method: input.method,
        url: input.url,
        host: input.host,
        group: input.group,
        priority: this.priorityEnabled ? input.priority : "normal",
        signal: input.signal,
        abort: input.abort,
        execute: input.execute as (control: JobControl) => Promise<unknown>,
        hasStarted: false,
        cancelledByGroup: false,
        probe: input.probe ?? false,
        resolve: (value) => resolve(value as T),
        reject,
      };
    });
    this.nextId += 1;

    this.jobs.set(job.id, job);
    const onAbort = (): void => this.handleAbort(job);
    job.onAbort = onAbort;
    if (job.signal.aborted) {
      this.handleAbort(job);
    } else {
      job.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (!this.enabled) {
      // Transparent mode: run immediately, exactly as a plain client would.
      // park() becomes the plain abortable backoff delay.
      const control: JobControl = { park: (ms) => delay(ms, job.signal) };
      const run = job.execute(control);
      run.then(
        (value) => {
          job.phase = "done";
          this.jobs.delete(job.id);
          this.completed += 1;
          job.resolve(value);
        },
        (error) => {
          job.phase = "done";
          this.jobs.delete(job.id);
          this.completed += 1;
          job.reject(error);
        },
      );
      return promise;
    }

    this.enqueue(job);
    this.dispatch();
    return promise;
  }

  stats(): SchedulerStats {
    return {
      active: this.active,
      queued: this.lanes.high.length + this.lanes.normal.length + this.lanes.low.length,
      delayed: this.parked.size,
      completed: this.completed,
      rejected: this.rejectedCount,
      lanes: {
        high: this.lanes.high.length,
        normal: this.lanes.normal.length,
        low: this.lanes.low.length,
      },
    };
  }

  pauseGroup(group: string): void {
    this.pausedGroups.add(group);
    this.events.emit("queue-paused", { group });
  }

  resumeGroup(group: string): void {
    this.pausedGroups.delete(group);
    this.events.emit("queue-resumed", { group });
    this.dispatch();
  }

  cancelGroup(group: string): void {
    for (const job of [...this.jobs.values()]) {
      if (job.group !== group) continue;
      this.emitRejected(job);
      if (job.phase === "running") {
        job.cancelledByGroup = true;
        job.abort();
      } else {
        this.finalizeCancelled(job);
      }
    }
  }

  cancelAll(): void {
    for (const job of [...this.jobs.values()]) {
      if (job.phase === "running") {
        job.cancelledByGroup = true;
        job.abort();
      } else {
        this.finalizeCancelled(job);
      }
    }
  }

  /** Re-prioritize queued requests matching a group name or request key. Returns the count changed. */
  prioritize(selector: string, priority: Priority): number {
    if (!this.priorityEnabled) return 0;
    let changed = 0;
    for (const job of [...this.jobs.values()]) {
      if (job.phase !== "queued") continue;
      if (job.key !== selector && job.group !== selector) continue;
      if (job.priority === priority) continue;
      const from = job.priority;
      this.removeFromLane(job);
      job.priority = priority;
      this.lanes[priority].unshift(job);
      changed += 1;
      this.events.emit("request-prioritized", {
        id: job.id,
        key: job.key,
        method: job.method,
        url: job.url,
        priority,
        from,
        to: priority,
      });
    }
    if (changed > 0) this.dispatch();
    return changed;
  }

  private enqueue(job: Job): void {
    const lane = this.lanes[job.priority];
    lane.push(job);
    job.phase = "queued";
    this.events.emit("request-queued", {
      id: job.id,
      key: job.key,
      method: job.method,
      url: job.url,
      priority: job.priority,
      position: lane.length,
    });
  }

  private dispatch(): void {
    for (;;) {
      if (this.active >= this.concurrency) return;
      const candidate = this.selectCandidate();
      if (!candidate) return;
      if (this.rateLimit && this.isRateLimited()) {
        this.parkForRateLimit(candidate);
        return;
      }
      this.admit(candidate);
    }
  }

  /** Weighted round-robin selection; FIFO within a lane (per host). */
  private selectCandidate(): Job | undefined {
    const n = this.pattern.length;
    for (let step = 0; step < n; step += 1) {
      const lane = this.pattern[(this.patternCursor + step) % n] as Priority;
      const queue = this.lanes[lane];
      for (const job of queue) {
        if (job.group && this.pausedGroups.has(job.group)) continue;
        // A host-saturated job keeps its lane position but must not block
        // traffic for other hosts — leapfrog it until its host frees up.
        if (this.hostSaturated(job.host)) continue;
        return job;
      }
    }
    return undefined;
  }

  private admit(job: Job): void {
    this.removeFromLane(job);
    this.patternCursor = (this.patternCursor + 1) % Math.max(1, this.pattern.length);

    if (!job.hasStarted && !job.probe) {
      const rejectError = this.beforeStart?.(this.base(job));
      if (rejectError) {
        job.phase = "done";
        this.jobs.delete(job.id);
        this.rejectedCount += 1;
        job.reject(rejectError);
        return;
      }
    }

    job.phase = "running";
    this.active += 1;
    this.hostActive.set(job.host, (this.hostActive.get(job.host) ?? 0) + 1);
    this.rateHistory.push(this.getNow());
    this.events.emit("request-dequeued", this.base(job));
    this.events.emit("request-started", this.base(job));

    if (job.hasStarted) {
      const settle = job.parkSettle;
      job.parkSettle = undefined;
      settle?.resolve();
      return;
    }
    job.hasStarted = true;
    const control: JobControl = {
      park: (ms, reason) => this.park(job, ms, reason),
    };
    job.execute(control).then(
      (value) => this.finish(job, value, undefined),
      (error) => this.finish(job, undefined, error),
    );
  }

  private park(job: Job, ms: number, reason: ParkReason): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (job.phase !== "running") {
        reject(new CancelledError());
        return;
      }
      this.releaseSlot(job);
      job.phase = "parked";
      this.parked.set(job.id, job);
      job.parkSettle = { resolve, reject };
      this.events.emit("request-delayed", {
        ...this.base(job),
        reason,
        delay: ms,
      });
      job.parkTimer = setTimeout(() => this.resume(job), ms);
      this.dispatch();
    });
  }

  private parkForRateLimit(job: Job): void {
    this.removeFromLane(job);
    job.phase = "parked";
    this.parked.set(job.id, job);
    const now = this.getNow();
    const delayMs = Math.max(0, (this.rateHistory[0] ?? now) + this.rateLimit!.interval - now);
    this.events.emit("request-delayed", { ...this.base(job), reason: "rate-limit", delay: delayMs });
    job.parkTimer = setTimeout(() => this.resume(job), delayMs);
  }

  private resume(job: Job): void {
    if (job.phase !== "parked") return;
    this.parked.delete(job.id);
    this.enqueue(job);
    this.events.emit("request-scheduled", this.base(job));
    this.dispatch();
  }

  private finish(job: Job, value: unknown, error: unknown): void {
    if (job.phase === "done") return;
    job.phase = "done";
    this.releaseSlot(job);
    this.jobs.delete(job.id);
    if (error !== undefined) {
      if (job.cancelledByGroup) {
        this.rejectedCount += 1;
      } else {
        this.completed += 1;
      }
      job.reject(error);
    } else {
      this.completed += 1;
      job.resolve(value);
    }
    this.dispatch();
  }

  private releaseSlot(job: Job): void {
    this.active = Math.max(0, this.active - 1);
    const current = this.hostActive.get(job.host) ?? 0;
    if (current <= 1) this.hostActive.delete(job.host);
    else this.hostActive.set(job.host, current - 1);
  }

  private handleAbort(job: Job): void {
    if (job.phase === "done" || job.phase === "running") return;
    this.finalizeCancelled(job);
  }

  private finalizeCancelled(job: Job): void {
    if (job.phase === "done") return;
    if (job.phase === "queued") this.removeFromLane(job);
    else if (job.phase === "parked") {
      this.parked.delete(job.id);
      if (job.parkTimer) clearTimeout(job.parkTimer);
    }
    job.phase = "done";
    this.jobs.delete(job.id);
    this.rejectedCount += 1;
    const error = new CancelledError();
    job.parkSettle?.reject(error);
    job.parkSettle = undefined;
    job.reject(error);
  }

  private emitRejected(job: Job): void {
    this.events.emit("request-rejected", {
      ...this.base(job),
      reason: "cancelled",
    });
  }

  private removeFromLane(job: Job): void {
    const queue = this.lanes[job.priority];
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
  }

  private base(job: Job): { id: number; key: string; method: HttpMethod; url: string; priority: Priority } {
    return { id: job.id, key: job.key, method: job.method, url: job.url, priority: job.priority };
  }

  private hostSaturated(host: string): boolean {
    const limit = this.hosts[host] ?? this.concurrency;
    return (this.hostActive.get(host) ?? 0) >= limit;
  }

  private isRateLimited(): boolean {
    const now = this.getNow();
    while (this.rateHistory.length > 0 && now - (this.rateHistory[0] ?? now) >= this.rateLimit!.interval) {
      this.rateHistory.shift();
    }
    return this.rateHistory.length >= this.rateLimit!.requests;
  }
}