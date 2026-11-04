import type { NormalizedMagnet } from '../domain/magnet';
import type {
  PreviewManager,
  PreviewResult,
  PreviewState,
} from '../domain/preview';
import { RequestCoordinator } from './requestCoordinator';
import type { PreviewCache } from './previewCache';

export class ProductionPreviewManager implements PreviewManager {
  private readonly inFlight = new Map<string, Promise<PreviewResult>>();
  private readonly pendingPersistence = new Map<string, Promise<void>>();
  private readonly states = new Map<string, PreviewState>();
  private readonly listeners = new Map<
    string,
    Set<(state: PreviewState) => void>
  >();

  constructor(
    private readonly coordinator: RequestCoordinator,
    private readonly cache?: PreviewCache,
    private readonly persistAssets?: (result: PreviewResult) => Promise<void>,
  ) {}

  getState(infoHash: string): PreviewState {
    return this.states.get(infoHash) ?? { phase: 'idle' };
  }

  subscribe(
    infoHash: string,
    listener: (state: PreviewState) => void,
  ): () => void {
    const listeners = this.listeners.get(infoHash) ?? new Set();
    listeners.add(listener);
    this.listeners.set(infoHash, listeners);
    listener(this.getState(infoHash));
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(infoHash);
    };
  }

  getPreview(magnet: NormalizedMagnet): Promise<PreviewResult> {
    const existing = this.inFlight.get(magnet.infoHash);
    if (existing) return existing;
    const promise = this.resolve(magnet).finally(() =>
      this.inFlight.delete(magnet.infoHash),
    );
    this.inFlight.set(magnet.infoHash, promise);
    return promise;
  }

  getMany(magnets: readonly NormalizedMagnet[]): Promise<PreviewResult[]> {
    return Promise.all(magnets.map((magnet) => this.getPreview(magnet)));
  }

  async waitForPersistence(infoHash: string): Promise<void> {
    await this.pendingPersistence.get(infoHash);
  }

  private setState(infoHash: string, state: PreviewState): void {
    this.states.set(infoHash, state);
    for (const listener of this.listeners.get(infoHash) ?? []) listener(state);
  }

  private async resolve(magnet: NormalizedMagnet): Promise<PreviewResult> {
    const pendingWrite = this.pendingPersistence.get(magnet.infoHash);
    if (pendingWrite) await pendingWrite;
    if (this.cache) {
      try {
        const cached = await this.cache.get(magnet.infoHash);
        if (cached) {
          this.setReadyState(cached);
          return cached;
        }
      } catch {
        // A broken cache must not block an otherwise available preview.
      }
    }
    const result = await this.coordinator.request(magnet.infoHash, (state) =>
      this.setState(magnet.infoHash, state),
    );
    this.setReadyState(result);
    this.schedulePersistence(result);
    return result;
  }

  private schedulePersistence(result: PreviewResult): void {
    if (!this.cache) return;
    const task = (async () => {
      try {
        const stored = await this.cache!.put(result);
        if (stored && this.persistAssets) await this.persistAssets(result);
      } catch {
        // The result remains usable when durable persistence fails.
      }
    })();
    this.pendingPersistence.set(result.infoHash, task);
    void task.then(() => {
      if (this.pendingPersistence.get(result.infoHash) === task)
        this.pendingPersistence.delete(result.infoHash);
    });
  }

  private setReadyState(result: PreviewResult): void {
    this.setState(result.infoHash, {
      phase:
        result.screenshots.length > 0 &&
        (!result.name || result.totalBytes === undefined)
          ? 'partial_success'
          : 'success',
    });
  }
}
