// Local audio storage in IndexedDB (extension origin). Only the popup/options page and the
// service worker can reach this database; the page-context script never touches it.

export interface StoredClip {
  id: string;
  name: string;
  /** Normalised mono 16-bit PCM WAV (see clipProcessor). */
  wav: ArrayBuffer;
  lengthSec: number;
  createdAt: number;
}

const DB_NAME = 'meetentry';
const STORE = 'clips';
const CURRENT_KEY = 'current';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

/** Only one clip is kept for now (multiple profiles are a planned enhancement). */
export async function saveClip(clip: StoredClip): Promise<void> {
  await withStore('readwrite', (s) => s.put(clip, CURRENT_KEY));
}

export async function getClip(): Promise<StoredClip | null> {
  const clip = await withStore<StoredClip | undefined>('readonly', (s) => s.get(CURRENT_KEY));
  return clip ?? null;
}

export async function deleteClip(): Promise<void> {
  await withStore('readwrite', (s) => s.delete(CURRENT_KEY));
}
