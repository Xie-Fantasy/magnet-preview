import type { NormalizedMagnet } from '../domain/magnet';
import type {
  PreviewManager,
  PreviewResult,
  PreviewState,
} from '../domain/preview';

export type FakePreviewScenario =
  | { type: 'success'; result: Omit<PreviewResult, 'infoHash' | 'magnet'> }
  | { type: 'unavailable'; category: string };

export class FakePreviewManager implements PreviewManager {
  private readonly inFlight = new Map<string, Promise<PreviewResult>>();
  private readonly states = new Map<string, PreviewState>();
  constructor(
    private readonly scenarios: ReadonlyMap<string, FakePreviewScenario>,
  ) {}
  getState(infoHash: string): PreviewState {
    return this.states.get(infoHash) ?? { phase: 'idle' };
  }
  getPreview(magnet: NormalizedMagnet): Promise<PreviewResult> {
    const existing = this.inFlight.get(magnet.infoHash);
    if (existing) return existing;
    this.states.set(magnet.infoHash, { phase: 'queued' });
    const operation = Promise.resolve()
      .then(() => {
        this.states.set(magnet.infoHash, { phase: 'requesting' });
        const scenario = this.scenarios.get(magnet.infoHash);
        if (!scenario || scenario.type === 'unavailable') {
          const category =
            scenario?.type === 'unavailable'
              ? scenario.category
              : 'not_configured';
          this.states.set(magnet.infoHash, {
            phase: 'unavailable',
            technicalDetails: { category },
          });
          throw new Error(category);
        }
        const result = {
          ...scenario.result,
          infoHash: magnet.infoHash,
          magnet: magnet.canonicalMagnet,
        };
        this.states.set(magnet.infoHash, { phase: 'success' });
        return result;
      })
      .finally(() => this.inFlight.delete(magnet.infoHash));
    this.inFlight.set(magnet.infoHash, operation);
    return operation;
  }
  getMany(magnets: readonly NormalizedMagnet[]): Promise<PreviewResult[]> {
    return Promise.all(magnets.map((magnet) => this.getPreview(magnet)));
  }
}
