import type {
  CachePolicy,
  CacheStats,
  PreviewCache,
} from '../../application/previewCache';
import { defaultCachePolicy } from '../../application/previewCache';
import type { PreviewResult } from '../../domain/preview';

const DB_NAME = 'magnet-preview-cache';
const DB_VERSION = 1;
const RECORD_VERSION = 1;
const HASH_PATTERN = /^[A-F0-9]{40}$/;
const ASSET_KEY_PATTERN = /^([A-F0-9]{40}):([0-9]{1,2})$/;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_ASSETS_PER_PREVIEW = 8;
const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

interface CacheRecord {
  schemaVersion: 1;
  infoHash: string;
  result: PreviewResult;
  createdAt: number;
  lastAccessedAt: number;
  metadataBytes: number;
  assetBytes: Record<string, number>;
  storedBytes: number;
}

interface AssetRecord {
  schemaVersion: 1;
  key: string;
  blob: Blob;
}

function validPolicy(value: unknown): value is CachePolicy {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  return (
    input.schemaVersion === 1 &&
    (input.ttlMs === null ||
      (Number.isSafeInteger(input.ttlMs) &&
        (input.ttlMs as number) >= 60_000)) &&
    (input.capBytes === null ||
      (Number.isSafeInteger(input.capBytes) && (input.capBytes as number) >= 0))
  );
}

function isFutureSchema(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Number.isSafeInteger((value as Record<string, unknown>).schemaVersion) &&
    ((value as Record<string, unknown>).schemaVersion as number) >
      RECORD_VERSION
  );
}

function validAssetBlob(value: unknown, key: string, expectedBytes?: number) {
  if (!value || typeof value !== 'object') return null;
  const asset = value as Partial<AssetRecord>;
  if (
    asset.schemaVersion !== RECORD_VERSION ||
    asset.key !== key ||
    !(asset.blob instanceof Blob) ||
    !IMAGE_TYPES.has(asset.blob.type) ||
    asset.blob.size < 1 ||
    asset.blob.size > MAX_IMAGE_BYTES ||
    (expectedBytes !== undefined && asset.blob.size !== expectedBytes)
  )
    return null;
  return asset.blob;
}

function deleteAssetsForHash(assets: IDBObjectStore, infoHash: string) {
  const request = assets.getAllKeys();
  request.onsuccess = () => {
    for (const key of request.result) {
      if (
        typeof key === 'string' &&
        ASSET_KEY_PATTERN.test(key) &&
        key.startsWith(infoHash + ':')
      )
        assets.delete(key);
    }
  };
}

export function sanitizePreviewResult(value: unknown): PreviewResult | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (!HASH_PATTERN.test(String(input.infoHash))) return null;
  const infoHash = input.infoHash as string;
  if (!Array.isArray(input.screenshots)) return null;
  const seenImageIds = new Set<string>();
  const screenshots = input.screenshots.slice(0, 24).flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const image = item as Record<string, unknown>;
    if (typeof image.sourceUrl !== 'string') return [];
    try {
      const url = new URL(image.sourceUrl);
      if (
        url.origin !== 'https://whatslink.info' ||
        url.username ||
        url.password
      )
        return [];
      const id =
        typeof image.id === 'string' && /^[0-9]{1,2}$/.test(image.id)
          ? image.id
          : String(index);
      if (seenImageIds.has(id)) return [];
      seenImageIds.add(id);
      return [{ id, sourceUrl: url.href }];
    } catch {
      return [];
    }
  });
  const files = Array.isArray(input.files)
    ? input.files.slice(0, 1000).flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const file = item as Record<string, unknown>;
        if (typeof file.path !== 'string') return [];
        return [
          {
            path: file.path.slice(0, 500),
            bytes:
              Number.isSafeInteger(file.bytes) && (file.bytes as number) >= 0
                ? (file.bytes as number)
                : undefined,
          },
        ];
      })
    : undefined;
  return {
    infoHash,
    magnet: 'magnet:?xt=urn:btih:' + infoHash,
    name:
      typeof input.name === 'string'
        ? input.name.trim().slice(0, 500) || undefined
        : undefined,
    totalBytes:
      Number.isSafeInteger(input.totalBytes) &&
      (input.totalBytes as number) >= 0
        ? (input.totalBytes as number)
        : undefined,
    fileCount:
      Number.isSafeInteger(input.fileCount) && (input.fileCount as number) >= 0
        ? (input.fileCount as number)
        : undefined,
    files,
    screenshots,
    providerId: 'whatslink',
    fetchedAt:
      Number.isSafeInteger(input.fetchedAt) && (input.fetchedAt as number) >= 0
        ? (input.fetchedAt as number)
        : 0,
  };
}

function validRecord(value: unknown): CacheRecord | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const result = sanitizePreviewResult(input.result);
  if (
    input.schemaVersion !== RECORD_VERSION ||
    !result ||
    input.infoHash !== result.infoHash ||
    !Number.isSafeInteger(input.createdAt) ||
    !Number.isSafeInteger(input.lastAccessedAt) ||
    !Number.isSafeInteger(input.metadataBytes) ||
    !Number.isSafeInteger(input.storedBytes) ||
    (input.createdAt as number) < 0 ||
    (input.lastAccessedAt as number) < 0 ||
    (input.metadataBytes as number) < 0 ||
    (input.storedBytes as number) < 0 ||
    !input.assetBytes ||
    typeof input.assetBytes !== 'object' ||
    Array.isArray(input.assetBytes)
  )
    return null;
  const assetBytes = input.assetBytes as Record<string, unknown>;
  const screenshotIds = new Set(result.screenshots.map((image) => image.id));
  if (
    Object.entries(assetBytes).some(
      ([id, bytes]) =>
        !/^[0-9]{1,2}$/.test(id) ||
        !screenshotIds.has(id) ||
        !Number.isSafeInteger(bytes) ||
        (bytes as number) < 1 ||
        (bytes as number) > MAX_IMAGE_BYTES,
    ) ||
    Object.keys(assetBytes).length > MAX_ASSETS_PER_PREVIEW
  )
    return null;
  const total = Object.values(assetBytes).reduce<number>(
    (sum, bytes) => sum + (bytes as number),
    input.metadataBytes as number,
  );
  const actualMetadataBytes = new TextEncoder().encode(
    JSON.stringify(result),
  ).length;
  if (
    !Number.isSafeInteger(total) ||
    total !== input.storedBytes ||
    actualMetadataBytes !== input.metadataBytes ||
    (input.lastAccessedAt as number) < (input.createdAt as number)
  )
    return null;
  return {
    schemaVersion: 1,
    infoHash: result.infoHash,
    result,
    createdAt: input.createdAt as number,
    lastAccessedAt: input.lastAccessedAt as number,
    metadataBytes: input.metadataBytes as number,
    assetBytes: assetBytes as Record<string, number>,
    storedBytes: input.storedBytes as number,
  };
}

function isExpired(record: CacheRecord, ttlMs: number | null, now: number) {
  return ttlMs !== null && now - record.lastAccessedAt >= ttlMs;
}

function removeRecord(
  previews: IDBObjectStore,
  assets: IDBObjectStore,
  record: CacheRecord,
) {
  previews.delete(record.infoHash);
  for (const id of Object.keys(record.assetBytes))
    assets.delete(record.infoHash + ':' + id);
}

function materialize(record: CacheRecord): PreviewResult {
  return {
    ...record.result,
    // Cache hits only expose screenshots backed by a local Blob. This avoids
    // turning a metadata hit into an unannounced remote image request.
    screenshots: record.result.screenshots.flatMap((image) =>
      record.assetBytes[image.id] === undefined
        ? []
        : [
            {
              ...image,
              cachedAssetKey: record.infoHash + ':' + image.id,
            },
          ],
    ),
  };
}

export class IndexedDbPreviewCache implements PreviewCache {
  private database: Promise<IDBDatabase> | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('previews'))
          db.createObjectStore('previews', { keyPath: 'infoHash' });
        if (!db.objectStoreNames.contains('assets'))
          db.createObjectStore('assets', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('settings'))
          db.createObjectStore('settings');
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          this.database = undefined;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error('Cache database is blocked'));
      };
    }).catch((error: unknown) => {
      this.database = undefined;
      throw error;
    });
    return this.database;
  }

  private async transaction<T>(
    stores: string[],
    mode: IDBTransactionMode,
    start: (tx: IDBTransaction, setResult: (value: T) => void) => void,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      let result!: T;
      const tx = db.transaction(stores, mode);
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(tx.error ?? new Error('Cache transaction failed'));
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

  async getPolicy(): Promise<CachePolicy> {
    return this.transaction<CachePolicy>(
      ['settings'],
      'readonly',
      (tx, set) => {
        const request = tx.objectStore('settings').get('policy');
        request.onsuccess = () => {
          if (isFutureSchema(request.result)) {
            tx.abort();
            return;
          }
          set(
            validPolicy(request.result) ? request.result : defaultCachePolicy,
          );
        };
      },
    );
  }

  async setPolicy(policy: CachePolicy): Promise<void> {
    if (!validPolicy(policy)) throw new Error('Invalid cache policy');
    await this.transaction<void>(['settings'], 'readwrite', (tx) => {
      tx.objectStore('settings').put(policy, 'policy');
    });
    await this.prune();
  }

  async get(infoHash: string): Promise<PreviewResult | null> {
    if (!HASH_PATTERN.test(infoHash)) return null;
    const policy = await this.getPolicy();
    const now = this.now();
    return this.transaction<PreviewResult | null>(
      ['previews', 'assets'],
      'readwrite',
      (tx, set) => {
        const previews = tx.objectStore('previews');
        const assets = tx.objectStore('assets');
        const request = previews.get(infoHash);
        request.onsuccess = () => {
          const record = validRecord(request.result);
          if (!record) {
            if (!isFutureSchema(request.result)) {
              previews.delete(infoHash);
              deleteAssetsForHash(assets, infoHash);
            }
            return set(null);
          }
          if (isExpired(record, policy.ttlMs, now)) {
            removeRecord(previews, assets, record);
            deleteAssetsForHash(assets, infoHash);
            return set(null);
          }
          const assetIds = Object.keys(record.assetBytes);
          if (assetIds.length === 0) {
            record.lastAccessedAt = now;
            previews.put(record);
            set(materialize(record));
            return;
          }
          let remaining = assetIds.length;
          let broken = false;
          const finishAssetChecks = () => {
            remaining -= 1;
            if (remaining !== 0) return;
            if (broken) {
              removeRecord(previews, assets, record);
              deleteAssetsForHash(assets, infoHash);
              set(null);
            } else {
              record.lastAccessedAt = now;
              previews.put(record);
              set(materialize(record));
            }
          };
          for (const id of assetIds) {
            const key = infoHash + ':' + id;
            const assetRequest = assets.get(key);
            assetRequest.onsuccess = () => {
              if (
                !validAssetBlob(assetRequest.result, key, record.assetBytes[id])
              )
                broken = true;
              finishAssetChecks();
            };
            assetRequest.onerror = () => {
              broken = true;
              finishAssetChecks();
            };
          }
        };
      },
    );
  }

  async put(value: PreviewResult): Promise<boolean> {
    const result = sanitizePreviewResult(value);
    if (!result) return false;
    const policy = await this.getPolicy();
    await this.prune();
    const metadataBytes = new TextEncoder().encode(
      JSON.stringify(result),
    ).length;
    if (policy.capBytes !== null && metadataBytes > policy.capBytes)
      return false;
    const now = this.now();
    return this.transaction<boolean>(
      ['previews', 'assets'],
      'readwrite',
      (tx, set) => {
        const previews = tx.objectStore('previews');
        const assets = tx.objectStore('assets');
        const request = previews.getAll();
        request.onsuccess = () => {
          const records = (request.result as unknown[])
            .map(validRecord)
            .filter((item): item is CacheRecord => item !== null);
          let used = 0;
          const candidates: CacheRecord[] = [];
          for (const record of records) {
            if (
              record.infoHash === result.infoHash ||
              isExpired(record, policy.ttlMs, now)
            ) {
              removeRecord(previews, assets, record);
            } else {
              used += record.storedBytes;
              candidates.push(record);
            }
          }
          candidates.sort(
            (a, b) =>
              a.lastAccessedAt - b.lastAccessedAt ||
              a.infoHash.localeCompare(b.infoHash),
          );
          while (
            policy.capBytes !== null &&
            used + metadataBytes > policy.capBytes &&
            candidates.length > 0
          ) {
            const evicted = candidates.shift()!;
            removeRecord(previews, assets, evicted);
            used -= evicted.storedBytes;
          }
          const record: CacheRecord = {
            schemaVersion: 1,
            infoHash: result.infoHash,
            result,
            createdAt: now,
            lastAccessedAt: now,
            metadataBytes,
            assetBytes: {},
            storedBytes: metadataBytes,
          };
          previews.put(record);
          set(true);
        };
      },
    );
  }

  async getAsset(key: string): Promise<Blob | null> {
    if (!ASSET_KEY_PATTERN.test(key)) return null;
    const [, infoHash, imageId] = /^([A-F0-9]{40}):([0-9]{1,2})$/.exec(key)!;
    return this.transaction<Blob | null>(
      ['previews', 'assets'],
      'readwrite',
      (tx, set) => {
        const assets = tx.objectStore('assets');
        const previews = tx.objectStore('previews');
        const request = assets.get(key);
        request.onsuccess = () => {
          const blob = validAssetBlob(request.result, key);
          if (blob) return set(blob);
          assets.delete(key);
          const previewRequest = previews.get(infoHash!);
          previewRequest.onsuccess = () => {
            const record = validRecord(previewRequest.result);
            if (!record) {
              if (!isFutureSchema(previewRequest.result)) {
                previews.delete(infoHash!);
                deleteAssetsForHash(assets, infoHash!);
              }
              return set(null);
            }
            if (record.assetBytes[imageId!] !== undefined) {
              removeRecord(previews, assets, record);
              deleteAssetsForHash(assets, infoHash!);
            }
            set(null);
          };
        };
      },
    );
  }

  async putAsset(key: string, blob: Blob): Promise<boolean> {
    const match = ASSET_KEY_PATTERN.exec(key);
    if (
      !match ||
      !IMAGE_TYPES.has(blob.type) ||
      blob.size === 0 ||
      blob.size > MAX_IMAGE_BYTES
    )
      return false;
    const infoHash = match[1]!;
    const imageId = match[2]!;
    const policy = await this.getPolicy();
    await this.prune();
    const now = this.now();
    return this.transaction<boolean>(
      ['previews', 'assets'],
      'readwrite',
      (tx, set) => {
        const previews = tx.objectStore('previews');
        const assets = tx.objectStore('assets');
        const request = previews.getAll();
        request.onsuccess = () => {
          const records = (request.result as unknown[])
            .map(validRecord)
            .filter((item): item is CacheRecord => item !== null);
          const target = records.find((item) => item.infoHash === infoHash);
          if (
            !target ||
            isExpired(target, policy.ttlMs, now) ||
            !target.result.screenshots.some((image) => image.id === imageId)
          )
            return set(false);
          if (target.assetBytes[imageId] !== undefined) return set(true);
          if (Object.keys(target.assetBytes).length >= 8) return set(false);
          if (
            policy.capBytes !== null &&
            target.storedBytes + blob.size > policy.capBytes
          )
            return set(false);
          let used = 0;
          const candidates: CacheRecord[] = [];
          for (const record of records) {
            if (record.infoHash === infoHash) {
              used += record.storedBytes;
            } else if (isExpired(record, policy.ttlMs, now)) {
              removeRecord(previews, assets, record);
            } else {
              used += record.storedBytes;
              candidates.push(record);
            }
          }
          candidates.sort(
            (a, b) =>
              a.lastAccessedAt - b.lastAccessedAt ||
              a.infoHash.localeCompare(b.infoHash),
          );
          while (
            policy.capBytes !== null &&
            used + blob.size > policy.capBytes &&
            candidates.length > 0
          ) {
            const evicted = candidates.shift()!;
            removeRecord(previews, assets, evicted);
            used -= evicted.storedBytes;
          }
          target.assetBytes[imageId!] = blob.size;
          target.storedBytes += blob.size;
          previews.put(target);
          assets.put({ schemaVersion: 1, key, blob } satisfies AssetRecord);
          set(true);
        };
      },
    );
  }

  async stats(): Promise<CacheStats> {
    await this.prune();
    return this.transaction<CacheStats>(['previews'], 'readonly', (tx, set) => {
      const request = tx.objectStore('previews').getAll();
      request.onsuccess = () => {
        const records = (request.result as unknown[])
          .map(validRecord)
          .filter((item): item is CacheRecord => item !== null);
        set({
          previewCount: records.length,
          screenshotCount: records.reduce(
            (count, record) => count + Object.keys(record.assetBytes).length,
            0,
          ),
          usedBytes: records.reduce(
            (sum, record) => sum + record.storedBytes,
            0,
          ),
        });
      };
    });
  }

  async clearDisposable(): Promise<void> {
    await this.transaction<void>(['previews', 'assets'], 'readwrite', (tx) => {
      tx.objectStore('previews').clear();
      tx.objectStore('assets').clear();
    });
  }

  private async prune(): Promise<void> {
    const policy = await this.getPolicy();
    const now = this.now();
    await this.transaction<void>(['previews', 'assets'], 'readwrite', (tx) => {
      const previews = tx.objectStore('previews');
      const assets = tx.objectStore('assets');
      const previewRows = previews.getAll();
      const previewKeys = previews.getAllKeys();
      const assetRows = assets.getAll();
      const assetKeys = assets.getAllKeys();
      let remaining = 4;
      const repair = () => {
        remaining -= 1;
        if (remaining > 0) return;
        const allAssetRows = new Map<string, unknown>();
        assetKeys.result.forEach((key, index) => {
          if (typeof key === 'string')
            allAssetRows.set(key, assetRows.result[index]);
        });
        const retained: CacheRecord[] = [];
        const protectedFutureHashes = new Set<string>();
        for (let index = 0; index < previewRows.result.length; index += 1) {
          const key = previewKeys.result[index];
          const raw = previewRows.result[index] as unknown;
          if (isFutureSchema(raw)) {
            if (typeof key === 'string' && HASH_PATTERN.test(key))
              protectedFutureHashes.add(key);
            continue;
          }
          const record = validRecord(raw);
          if (
            !record ||
            typeof key !== 'string' ||
            !HASH_PATTERN.test(key) ||
            record.infoHash !== key
          ) {
            if (key !== undefined) previews.delete(key);
            if (typeof key === 'string' && HASH_PATTERN.test(key))
              deleteAssetsForHash(assets, key);
            continue;
          }
          if (isExpired(record, policy.ttlMs, now)) {
            removeRecord(previews, assets, record);
            deleteAssetsForHash(assets, record.infoHash);
            continue;
          }
          const brokenReference = Object.entries(record.assetBytes).some(
            ([id, bytes]) => {
              const key = record.infoHash + ':' + id;
              return !validAssetBlob(allAssetRows.get(key), key, bytes);
            },
          );
          if (brokenReference) {
            removeRecord(previews, assets, record);
            deleteAssetsForHash(assets, record.infoHash);
            continue;
          }
          retained.push(record);
        }
        const uniqueRecords = Array.from(
          new Map(retained.map((record) => [record.infoHash, record])).values(),
        );
        let used = uniqueRecords.reduce(
          (sum, record) => sum + record.storedBytes,
          0,
        );
        uniqueRecords.sort(
          (a, b) =>
            a.lastAccessedAt - b.lastAccessedAt ||
            a.infoHash.localeCompare(b.infoHash),
        );
        while (
          policy.capBytes !== null &&
          used > policy.capBytes &&
          uniqueRecords.length > 0
        ) {
          const evicted = uniqueRecords.shift()!;
          removeRecord(previews, assets, evicted);
          used -= evicted.storedBytes;
        }
        const keptAssetKeys = new Set<string>();
        for (const record of uniqueRecords)
          for (const id of Object.keys(record.assetBytes))
            keptAssetKeys.add(record.infoHash + ':' + id);
        for (const key of assetKeys.result) {
          if (typeof key !== 'string') continue;
          if (
            !ASSET_KEY_PATTERN.test(key) ||
            (!keptAssetKeys.has(key) &&
              !protectedFutureHashes.has(key.slice(0, 40)))
          ) {
            if (!isFutureSchema(allAssetRows.get(key))) assets.delete(key);
          }
        }
      };
      previewRows.onsuccess = repair;
      previewKeys.onsuccess = repair;
      assetRows.onsuccess = repair;
      assetKeys.onsuccess = repair;
    });
  }
}
