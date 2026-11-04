import type { PreviewProvider } from './previewProvider';
import type { PreviewResult, PreviewState } from '../domain/preview';
import { PreviewFailure } from '../domain/previewFailure';

interface Job {
  infoHash: string;
  attempt: number;
  readyAt: number;
  resolve: (result: PreviewResult) => void;
  reject: (failure: PreviewFailure) => void;
  onState: (state: PreviewState) => void;
}

export interface RequestPolicy {
  concurrency: number;
  spacingMs: number;
  timeoutMs: number;
  retryDelayMs: number;
  maxAttempts: number;
  transientThreshold: number;
  cooldownMs: number;
  rateLimitCooldownMs: number;
}

export const defaultRequestPolicy: RequestPolicy = {
  concurrency: 3,
  spacingMs: 300,
  timeoutMs: 8000,
  retryDelayMs: 500,
  maxAttempts: 2,
  transientThreshold: 3,
  cooldownMs: 30_000,
  rateLimitCooldownMs: 30 * 60_000,
};

export class RequestCoordinator {
  private readonly queue: Job[] = [];
  private active = 0;
  private nextStartAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private openUntil = 0;
  private circuitGeneration = 0;
  private transientFailures = 0;
  private probeActive = false;

  constructor(
    private readonly provider: PreviewProvider,
    private readonly policy: RequestPolicy = defaultRequestPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  request(
    infoHash: string,
    onState: (state: PreviewState) => void,
  ): Promise<PreviewResult> {
    if (this.openUntil > this.now()) {
      const failure = this.circuitFailure();
      onState({
        phase: 'unavailable',
        technicalDetails: {
          category: failure.category,
          retryAfterMs: failure.retryAfterMs,
        },
      });
      return Promise.reject(failure);
    }
    return new Promise<PreviewResult>((resolve, reject) => {
      this.queue.push({
        infoHash,
        attempt: 0,
        readyAt: this.now(),
        resolve,
        reject,
        onState,
      });
      onState({ phase: 'queued' });
      this.pump();
    });
  }

  private circuitFailure(): PreviewFailure {
    return new PreviewFailure(
      'circuit_open',
      false,
      Math.max(0, this.openUntil - this.now()),
    );
  }

  private openCircuit(duration: number): void {
    this.circuitGeneration += 1;
    this.openUntil = this.now() + duration;
    this.probeActive = false;
    this.failQueue(this.circuitFailure());
  }

  private failQueue(failure: PreviewFailure): void {
    for (const job of this.queue.splice(0)) this.fail(job, failure);
  }

  private fail(job: Job, failure: PreviewFailure): void {
    job.onState({
      phase: 'unavailable',
      technicalDetails: {
        category: failure.category,
        retryAfterMs: failure.retryAfterMs,
      },
    });
    job.reject(failure);
  }

  private arm(delay: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.pump();
      },
      Math.max(0, delay),
    );
  }

  private pump(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.queue.length === 0) return;
    if (this.openUntil > this.now()) {
      this.failQueue(this.circuitFailure());
      return;
    }
    const halfOpen = this.openUntil !== 0 && this.openUntil <= this.now();
    if (
      this.active >= this.policy.concurrency ||
      (halfOpen && this.probeActive)
    )
      return;
    const now = this.now();
    const index = this.queue.findIndex((job) => job.readyAt <= now);
    if (index === -1) {
      this.arm(Math.min(...this.queue.map((job) => job.readyAt)) - now);
      return;
    }
    if (now < this.nextStartAt) {
      this.arm(this.nextStartAt - now);
      return;
    }
    const job = this.queue.splice(index, 1)[0];
    if (!job) return;
    if (halfOpen) this.probeActive = true;
    this.active += 1;
    this.nextStartAt = now + this.policy.spacingMs;
    void this.run(job, halfOpen, this.circuitGeneration);
    if (this.queue.length > 0) this.arm(this.policy.spacingMs);
  }

  private async run(
    job: Job,
    probe: boolean,
    generation: number,
  ): Promise<void> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<PreviewResult>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new PreviewFailure('timeout', true));
      }, this.policy.timeoutMs);
    });
    job.attempt += 1;
    job.onState({ phase: 'requesting' });
    try {
      const result = await Promise.race([
        this.provider.fetchPreview(job.infoHash, controller.signal),
        deadline,
      ]);
      if (generation === this.circuitGeneration) {
        this.transientFailures = 0;
        if (probe) {
          this.openUntil = 0;
          this.probeActive = false;
        }
      }
      job.resolve(result);
    } catch (error) {
      const failure =
        error instanceof PreviewFailure
          ? error
          : new PreviewFailure('network', true);
      if (generation !== this.circuitGeneration) {
        this.fail(job, failure);
      } else if (failure.category === 'rate_limited') {
        this.openCircuit(
          failure.retryAfterMs ?? this.policy.rateLimitCooldownMs,
        );
        this.fail(job, failure);
      } else if (
        failure.category === 'authorization' ||
        failure.category === 'invalid_response'
      ) {
        this.openCircuit(this.policy.cooldownMs);
        this.fail(job, failure);
      } else if (
        failure.retryable &&
        job.attempt < this.policy.maxAttempts &&
        !probe
      ) {
        job.readyAt = this.now() + this.policy.retryDelayMs * job.attempt;
        this.queue.push(job);
        job.onState({
          phase: 'queued',
          technicalDetails: { category: failure.category },
        });
      } else {
        if (failure.retryable) this.transientFailures += 1;
        else this.transientFailures = 0;
        if (probe || this.transientFailures >= this.policy.transientThreshold)
          this.openCircuit(this.policy.cooldownMs);
        this.fail(job, failure);
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.active -= 1;
      this.pump();
    }
  }
}
