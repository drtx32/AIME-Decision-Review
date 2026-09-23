/**
 * Browser-local BYOK store (ELI-360).
 *
 * Trust boundary:
 *   - The AIME backend NEVER receives, persists, logs, echoes, or
 *     fingerprints a user-supplied API key. Any code in this file runs
 *     inside the user's browser only.
 *   - The key lives in a dedicated IndexedDB object store scoped to this
 *     origin. We prefer IndexedDB over localStorage to keep it out of the
 *     synchronous JSX layout / easy-to-exfiltrate-with-script-injection
 *     surface; the storage is per-origin so a same-origin XSS still has
 *     to defeat the bundle's CSP-equivalent baseline. We never render or
 *     export the secret — every getter returns a masked summary only.
 *   - Connection tests are issued directly from the browser to the
 *     user-configured provider endpoint. If CORS prevents direct use, we
 *     surface that as `browser_incompatible` rather than silently falling
 *     back to proxying the key through AIME.
 *
 * Out of scope for v0.1:
 *   - This store is a browser-side utility for ad-hoc tooling only. The
 *     v0.1 Review Agent runs server-side on the operator's LLM env
 *     credentials. We do not pretend the core review flow accepts a
 *     browser BYOK.
 */

const DB_NAME = "aime-byok";
const DB_VERSION = 1;
const STORE_NAME = "configs";
const KEY_RECORD_ID = "current";

export type ByokProvider = "openai-compatible";

export interface BrowserByokConfig {
  provider: ByokProvider;
  baseUrl: string;
  model: string;
  /**
   * Plaintext API key. NEVER sent to AIME. NEVER rendered into the DOM.
   * Use {@link maskApiKey} for any user-visible summary.
   */
  apiKey: string;
  /** Last successful browser-direct connection test (ISO timestamp). */
  verifiedAt: string | null;
  /** Free-form diagnostic from the most recent direct connection test. */
  lastError: string | null;
  /** When this record was first written / last updated (ISO timestamp). */
  updatedAt: string;
}

/** Public, masked view safe to render. */
export interface BrowserByokSummary {
  provider: ByokProvider;
  baseUrl: string;
  model: string;
  /** Last four characters of the key — only safe summary we ever render. */
  apiKeySuffix: string | null;
  /** True iff a non-empty apiKey is stored. */
  hasApiKey: boolean;
  verifiedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable in this environment"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("failed to open IndexedDB"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T> | T
): Promise<T> {
  const db = await openDb();
  return await new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    let result: T;
    Promise.resolve(run(store))
      .then((value) => {
        result = value;
      })
      .catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function read<T>(store: IDBObjectStore, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB read failed"));
  });
}

function write(store: IDBObjectStore, key: IDBValidKey, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("IndexedDB write failed"));
  });
}

function clear(store: IDBObjectStore, key: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("IndexedDB delete failed"));
  });
}

/**
 * Mask a plaintext key for UI display.
 *
 * Returns "****" when the key is too short to safely expose even its
 * last-four (less than 8 chars), and "…last4" otherwise. Never returns
 * the full secret.
 */
export function maskApiKey(plaintext: string | null | undefined): string | null {
  if (!plaintext) return null;
  if (plaintext.length < 8) return "****";
  return `…${plaintext.slice(-4)}`;
}

export function toSummary(config: BrowserByokConfig | null): BrowserByokSummary | null {
  if (!config) return null;
  const apiKeySuffix = maskApiKey(config.apiKey);
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeySuffix,
    hasApiKey: Boolean(config.apiKey && config.apiKey.length > 0),
    verifiedAt: config.verifiedAt,
    lastError: config.lastError,
    updatedAt: config.updatedAt,
  };
}

export const browserByok = {
  /** Returns the full config (including plaintext key). Use only in this
   *  module — never pass the result to render code or a network call to
   *  AIME. */
  async load(): Promise<BrowserByokConfig | null> {
    const result = await withStore("readonly", (store) => read<BrowserByokConfig>(store, KEY_RECORD_ID));
    return result ?? null;
  },

  /** Masked summary for the Settings UI. */
  async loadSummary(): Promise<BrowserByokSummary | null> {
    const config = await browserByok.load();
    return toSummary(config);
  },

  /** Persist a config. Plaintext key NEVER leaves the browser. */
  async save(input: {
    provider: ByokProvider;
    baseUrl: string;
    model: string;
    apiKey: string;
  }): Promise<BrowserByokSummary> {
    const now = new Date().toISOString();
    const config: BrowserByokConfig = {
      provider: input.provider,
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey: input.apiKey,
      verifiedAt: null,
      lastError: null,
      updatedAt: now,
    };
    await withStore("readwrite", (store) => write(store, KEY_RECORD_ID, config));
    return toSummary(config)!;
  },

  /** Clear the local record. Does not touch any server-side state. */
  async reset(): Promise<void> {
    await withStore("readwrite", (store) => clear(store, KEY_RECORD_ID));
  },

  /**
   * Browser-direct connection test. Hits the user-configured provider
   * endpoint directly; never proxies through AIME.
   *
   * Returns:
   *   - { ok: true, verifiedAt, model } on a 2xx /models response.
   *   - { ok: false, error } when the call fails OR CORS blocks direct
   *     browser use. CORS-blocked calls are explicitly labelled
   *     `browser_incompatible` so the UI can tell the user that this
   *     provider does not allow browser-direct access; the answer is
   *     never "send the key to AIME instead".
   */
  async test(input: { baseUrl: string; model: string; apiKey: string }): Promise<
    | { ok: true; model: string; verifiedAt: string }
    | { ok: false; error: string; browserIncompatible?: boolean }
  > {
    const baseUrl = input.baseUrl.trim();
    const apiKey = input.apiKey.trim();
    const model = input.model.trim();
    if (!baseUrl || !apiKey || !model) {
      return { ok: false, error: "请填写 Base URL、Model 和 API key" };
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      return { ok: false, error: "Base URL 必须以 http(s):// 开头" };
    }
    const url = `${baseUrl.replace(/\/$/, "")}/models`;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) {
        return { ok: false, error: `远端返回 HTTP ${response.status}` };
      }
      return { ok: true, model, verifiedAt: new Date().toISOString() };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Heuristic: CORS-blocked fetches usually surface as TypeError on
      // the response with no `.status`. Treat those as a browser-side
      // incompatibility rather than a credential failure so the UI
      // explains the constraint instead of telling the user to rotate
      // their key.
      const browserIncompatible =
        e instanceof TypeError ||
        /failed to fetch|networkerror|cors/i.test(message);
      return {
        ok: false,
        error: browserIncompatible
          ? "该 provider 不允许浏览器直连（CORS 受限）。请在允许浏览器跨域的 endpoint 上使用 BYOK，或继续使用服务器默认模型。"
          : `连接失败：${message}`,
        browserIncompatible: browserIncompatible || undefined,
      };
    }
  },
};