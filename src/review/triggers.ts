export const REVIEW_TRIGGER = "relation-health-check";
export type ReviewTrigger = typeof REVIEW_TRIGGER;

export function isRelationReviewDue(
  skillTurnNumber: number,
  everyTurns: number,
): boolean {
  return skillTurnNumber > 0 && skillTurnNumber % everyTurns === 0;
}
