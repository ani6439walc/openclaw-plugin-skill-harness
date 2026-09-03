export type WeightedRrfListItem = {
  id: string;
};

export type WeightedRrfResult = {
  id: string;
  score: number;
};

export function weightedReciprocalRankFusion(params: {
  lists: readonly (readonly WeightedRrfListItem[])[];
  weights?: readonly number[];
  k?: number;
}): WeightedRrfResult[] {
  const k = params.k ?? 60;
  const scores = new Map<string, number>();

  for (let listIdx = 0; listIdx < params.lists.length; listIdx += 1) {
    const list = params.lists[listIdx];
    if (!list || list.length === 0) continue;
    const weight = params.weights?.[listIdx] ?? 1;
    for (let rank = 0; rank < list.length; rank += 1) {
      const item = list[rank];
      if (!item) continue;
      const contribution = weight / (k + rank + 1);
      scores.set(item.id, (scores.get(item.id) ?? 0) + contribution);
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.id.localeCompare(right.id);
    });
}
