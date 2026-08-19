import path from "node:path";

/**
 * Generic singleton cache pattern for plugin-rooted services.
 * Normalizes the path, checks cache, creates if needed, optionally refreshes on retrieval.
 */
export function getOrCache<T>(
  cache: Map<string, T>,
  key: string,
  create: (normalizedKey: string) => T,
  onRetrieve?: (instance: T) => void,
): T {
  const normalizedKey = path.resolve(key);
  const existing = cache.get(normalizedKey);
  if (existing) {
    onRetrieve?.(existing);
    return existing;
  }
  const instance = create(normalizedKey);
  cache.set(normalizedKey, instance);
  try {
    onRetrieve?.(instance);
  } catch (error) {
    if (cache.get(normalizedKey) === instance) {
      cache.delete(normalizedKey);
    }
    throw error;
  }
  return instance;
}
