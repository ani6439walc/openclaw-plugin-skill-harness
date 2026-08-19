export interface CurationQueue {
  enqueue(key: string, task: () => Promise<void>): boolean;
  has(key: string): boolean;
}

export function createCurationQueue(): CurationQueue {
  const pendingKeys = new Set<string>();
  let tail = Promise.resolve();

  return {
    enqueue(key, task) {
      if (pendingKeys.has(key)) return false;
      pendingKeys.add(key);

      tail = tail
        .then(task)
        .catch(() => {})
        .finally(() => {
          pendingKeys.delete(key);
        });
      return true;
    },

    has(key) {
      return pendingKeys.has(key);
    },
  };
}
