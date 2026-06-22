/**
 * Persistent + session key/value storage. AutoDesktop backs `persistent` with a
 * file / the Tauri store plugin and `session` with an in-memory map.
 *
 * Values must be JSON-serializable. The encrypted key vault is stored as an
 * already-encrypted blob (see crypto), so file-backed persistence is safe.
 */
export interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;

  getSession<T>(key: string): Promise<T | null>;
  setSession<T>(key: string, value: T): Promise<void>;
  removeSession(key: string): Promise<void>;
}
