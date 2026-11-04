import type {
  FavoriteRecord,
  FavoriteStore,
} from '../../application/favorites';
import type { PreviewCache } from '../../application/previewCache';
import type { PreviewImage, PreviewResult } from '../../domain/preview';
import { normalizeMagnet } from '../../domain/magnet';
import { sanitizePreviewResult } from './indexedDbPreviewCache';

const DB_NAME = 'magnet-favorites';
const DB_VERSION = 1;
const HASH = /^[A-F0-9]{40}$/;
const IMAGE_ID = /^[0-9]{1,2}$/;
const MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function sanitizeFavoriteSnapshot(value: unknown): PreviewResult | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.screenshots) || input.screenshots.length > 8)
    return null;
  const ids = input.screenshots.map((image) =>
    image && typeof image === 'object'
      ? (image as Record<string, unknown>).id
      : undefined,
  );
  if (
    ids.some((id) => typeof id !== 'string' || !IMAGE_ID.test(id)) ||
    new Set(ids).size !== ids.length
  )
    return null;
  const metadata = sanitizePreviewResult({ ...input, screenshots: [] });
  if (!metadata) return null;
  return {
    ...metadata,
    screenshots: ids.map((id) => ({ id: id as string })),
  };
}

function isFutureRecord(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Number.isSafeInteger((value as Record<string, unknown>).schemaVersion) &&
    ((value as Record<string, unknown>).schemaVersion as number) > 1
  );
}

function deleteUnownedAssets(
  assets: IDBObjectStore,
  infoHash: string,
  retainedIds: readonly string[],
) {
  const request = assets.getAllKeys();
  request.onsuccess = () => {
    for (const key of request.result) {
      if (
        typeof key === 'string' &&
        key.startsWith(infoHash + ':') &&
        !retainedIds.includes(key.slice(infoHash.length + 1))
      )
        assets.delete(key);
    }
  };
}

function validFavorite(value: unknown): FavoriteRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    !HASH.test(String(record.infoHash)) ||
    typeof record.magnet !== 'string'
  )
    return null;
  const magnet = normalizeMagnet(record.magnet);
  if (
    !magnet ||
    magnet.infoHash !== record.infoHash ||
    magnet.canonicalMagnet.length > 8192
  )
    return null;
  const snapshot =
    record.snapshot === null ? null : sanitizeFavoriteSnapshot(record.snapshot);
  if (snapshot === null && record.snapshot !== null) return null;
  if (snapshot && snapshot.infoHash !== magnet.infoHash) return null;
  if (
    !Array.isArray(record.assetIds) ||
    record.assetIds.length > 8 ||
    record.assetIds.some(
      (id) => typeof id !== 'string' || !IMAGE_ID.test(id),
    ) ||
    new Set(record.assetIds).size !== record.assetIds.length ||
    (snapshot === null && record.assetIds.length > 0) ||
    record.assetIds.some(
      (id) => !snapshot?.screenshots.some((image) => image.id === id),
    ) ||
    !Number.isSafeInteger(record.missingImageCount) ||
    (record.missingImageCount as number) < 0 ||
    !Number.isSafeInteger(record.createdAt) ||
    (record.createdAt as number) < 0 ||
    !Number.isSafeInteger(record.updatedAt) ||
    (record.updatedAt as number) < 0
  )
    return null;
  return {
    schemaVersion: 1,
    infoHash: magnet.infoHash,
    magnet: magnet.canonicalMagnet,
    snapshot,
    assetIds: record.assetIds as string[],
    missingImageCount: record.missingImageCount as number,
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
  };
}

export class IndexedDbFavorites implements FavoriteStore {
  private database: Promise<IDBDatabase> | undefined;

  constructor(
    private readonly cache: Pick<PreviewCache, 'getAsset'>,
    private readonly now: () => number = Date.now,
    private readonly acquireMissing?: (
      image: PreviewImage,
    ) => Promise<Blob | null>,
  ) {}

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('favorites'))
          db.createObjectStore('favorites', { keyPath: 'infoHash' });
        if (!db.objectStoreNames.contains('assets'))
          db.createObjectStore('assets');
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) return db.close();
        db.onversionchange = () => {
          db.close();
          this.database = undefined;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error('Favorites database is blocked'));
      };
    }).catch((error: unknown) => {
      this.database = undefined;
      throw error;
    });
    return this.database;
  }

  private async transaction<T>(
    mode: IDBTransactionMode,
    start: (tx: IDBTransaction, set: (value: T) => void) => void,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      let result!: T;
      const tx = db.transaction(['favorites', 'assets'], mode);
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(tx.error ?? new Error('Favorites transaction failed'));
      try {
        start(tx, (value) => {
          result = value;
        });
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }

  get(infoHash: string): Promise<FavoriteRecord | null> {
    if (!HASH.test(infoHash)) return Promise.resolve(null);
    return this.transaction('readwrite', (tx, set) => {
      const request = tx.objectStore('favorites').get(infoHash);
      request.onsuccess = () => {
        if (isFutureRecord(request.result)) return tx.abort();
        const record = validFavorite(request.result);
        if (request.result && !record && !isFutureRecord(request.result)) {
          tx.objectStore('favorites').delete(infoHash);
          deleteUnownedAssets(tx.objectStore('assets'), infoHash, []);
        }
        if (
          record &&
          JSON.stringify(request.result.snapshot) !==
            JSON.stringify(record.snapshot)
        )
          tx.objectStore('favorites').put(record);
        set(record);
      };
    });
  }

  list(): Promise<FavoriteRecord[]> {
    return this.transaction('readwrite', (tx, set) => {
      const request = tx.objectStore('favorites').getAll();
      request.onsuccess = () => {
        if ((request.result as unknown[]).some(isFutureRecord))
          return tx.abort();
        const records = (request.result as unknown[]).flatMap((raw) => {
          const record = validFavorite(raw);
          if (!record) {
            if (raw && typeof raw === 'object' && !isFutureRecord(raw)) {
              const hash = (raw as Record<string, unknown>).infoHash;
              if (typeof hash === 'string' && HASH.test(hash)) {
                tx.objectStore('favorites').delete(hash);
                deleteUnownedAssets(tx.objectStore('assets'), hash, []);
              }
            }
            return [];
          }
          if (
            JSON.stringify((raw as FavoriteRecord).snapshot) !==
            JSON.stringify(record.snapshot)
          )
            tx.objectStore('favorites').put(record);
          return [record];
        });
        set(
          records.sort(
            (a, b) =>
              b.updatedAt - a.updatedAt || a.infoHash.localeCompare(b.infoHash),
          ),
        );
      };
    });
  }

  async save(
    magnetUrl: string,
    preview?: PreviewResult,
  ): Promise<FavoriteRecord> {
    const magnet = normalizeMagnet(magnetUrl);
    if (!magnet || magnet.canonicalMagnet.length > 8192)
      throw new Error('Invalid favorite Magnet');
    const normalized =
      preview === undefined ? undefined : sanitizePreviewResult(preview);
    if (
      preview !== undefined &&
      (!normalized || normalized.infoHash !== magnet.infoHash)
    )
      throw new Error('Invalid favorite preview');
    const existing = await this.get(magnet.infoHash);
    const snapshot = normalized
      ? sanitizeFavoriteSnapshot(normalized)
      : (existing?.snapshot ?? null);
    const images = (normalized?.screenshots ?? snapshot?.screenshots ?? [])
      .filter((image) => IMAGE_ID.test(image.id))
      .slice(0, 8);
    const copied = new Map<string, Blob>();
    const retained = new Set<string>();
    for (const image of images) {
      if (existing?.assetIds.includes(image.id)) {
        try {
          if (await this.getAsset(magnet.infoHash, image.id)) {
            retained.add(image.id);
            continue;
          }
        } catch {
          /* A failed read still allows a fresh bounded copy attempt. */
        }
      }
      let blob: Blob | null = null;
      try {
        blob = await this.cache.getAsset(magnet.infoHash + ':' + image.id);
      } catch {
        /* A cache read failure does not block the approved image path. */
      }
      if (!blob && this.acquireMissing && image.sourceUrl) {
        try {
          blob = await this.acquireMissing(image);
        } catch {
          /* Metadata can still be saved with an explicit missing image. */
        }
      }
      if (
        blob &&
        MIME.has(blob.type) &&
        blob.size > 0 &&
        blob.size <= MAX_IMAGE_BYTES
      )
        copied.set(image.id, blob);
    }
    const assetIds = images
      .map((image) => image.id)
      .filter((id) => copied.has(id) || retained.has(id));
    const now = this.now();
    const record: FavoriteRecord = {
      schemaVersion: 1,
      infoHash: magnet.infoHash,
      magnet: magnet.canonicalMagnet,
      snapshot,
      assetIds,
      missingImageCount: Math.max(0, images.length - assetIds.length),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.transaction<void>('readwrite', (tx) => {
      const assets = tx.objectStore('assets');
      deleteUnownedAssets(assets, magnet.infoHash, assetIds);
      for (const [id, blob] of copied)
        assets.put(blob, magnet.infoHash + ':' + id);
      tx.objectStore('favorites').put(record);
    });
    return record;
  }

  async remove(infoHash: string): Promise<void> {
    if (!HASH.test(infoHash)) return;
    await this.transaction<void>('readwrite', (tx) => {
      const favorites = tx.objectStore('favorites');
      const assets = tx.objectStore('assets');
      const request = favorites.get(infoHash);
      request.onsuccess = () => {
        if (isFutureRecord(request.result)) return tx.abort();
        deleteUnownedAssets(assets, infoHash, []);
        favorites.delete(infoHash);
      };
    });
  }

  async getAsset(infoHash: string, imageId: string): Promise<Blob | null> {
    if (!HASH.test(infoHash) || !IMAGE_ID.test(imageId)) return null;
    return this.transaction('readonly', (tx, set) => {
      const request = tx.objectStore('assets').get(infoHash + ':' + imageId);
      request.onsuccess = () => {
        const blob = request.result;
        set(
          blob instanceof Blob &&
            MIME.has(blob.type) &&
            blob.size > 0 &&
            blob.size <= MAX_IMAGE_BYTES
            ? blob
            : null,
        );
      };
    });
  }
}
