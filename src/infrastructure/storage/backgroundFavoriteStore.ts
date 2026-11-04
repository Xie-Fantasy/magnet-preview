import type {
  FavoriteRecord,
  FavoriteStore,
} from '../../application/favorites';
import { FavoriteSaveFailure } from '../../application/favorites';
import type { PreviewResult } from '../../domain/preview';
import { normalizeMagnet } from '../../domain/magnet';
import { IndexedDbFavorites } from './indexedDbFavorites';

export class BackgroundFavoriteStore implements FavoriteStore {
  constructor(private readonly local: IndexedDbFavorites) {}

  async save(
    magnet: string,
    snapshot?: PreviewResult,
  ): Promise<FavoriteRecord> {
    const normalized = normalizeMagnet(magnet);
    if (!normalized) throw new FavoriteSaveFailure('failed');
    let response: unknown;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'save-favorite',
        magnet: normalized.canonicalMagnet,
        snapshot,
      });
    } catch {
      throw new FavoriteSaveFailure('failed');
    }
    const result = response as {
      kind?: string;
      reason?: string;
      record?: FavoriteRecord;
    } | null;
    if (result?.kind !== 'saved')
      throw new FavoriteSaveFailure(
        result?.reason === 'quota' ? 'quota' : 'failed',
      );
    const saved = result.record;
    if (
      !saved ||
      saved.schemaVersion !== 1 ||
      saved.infoHash !== normalized.infoHash ||
      !Number.isSafeInteger(saved.missingImageCount)
    )
      throw new FavoriteSaveFailure('failed');
    return saved;
  }

  get(infoHash: string) {
    return this.local.get(infoHash);
  }

  list() {
    return this.local.list();
  }

  remove(infoHash: string) {
    return this.local.remove(infoHash);
  }

  getAsset(infoHash: string, imageId: string) {
    return this.local.getAsset(infoHash, imageId);
  }
}
