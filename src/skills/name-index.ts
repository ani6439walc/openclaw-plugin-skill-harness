import { canonicalIdentity } from "../normalize.js";
import type { AvailableSkill } from "./types.js";

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "to",
  "for",
  "in",
  "on",
  "at",
  "by",
  "of",
  "and",
  "or",
  "not",
  "with",
  "using",
  "use",
  "help",
  "me",
  "my",
  "please",
  "can",
  "how",
  "do",
  "i",
  "it",
  "this",
  "that",
  "from",
  "about",
]);

export type NameMatchOptions = {
  maxEditDistance: number;
  minJaccardScore: number;
  genericTokens: readonly string[];
};

export type SkillNameCandidate = {
  skillName: string;
  score: number;
  source: "name-match";
};

type IndexedSkill = { skill: AvailableSkill; tokens: string[] };

export function extractEnglishSegments(text: string): string {
  return text
    .replace(/[^A-Za-z0-9_\-\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeNameText(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(/[\s_-]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => Array.from(token).length >= 3 && !STOP_WORDS.has(token))
    .filter((token) => !seen.has(token) && (seen.add(token), true));
}

function letters(value: string): string {
  return value.replace(/[^a-z]/giu, "").toLowerCase();
}

function boundedLevenshtein(
  left: string,
  right: string,
  limit: number,
): number | undefined {
  if (Math.abs(left.length - right.length) > limit) return;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let minimum = row;
    for (let column = 1; column <= right.length; column += 1) {
      const value = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      current.push(value);
      minimum = Math.min(minimum, value);
    }
    if (minimum > limit) return;
    previous = current;
  }
  return previous[right.length]! <= limit ? previous[right.length] : undefined;
}

export function buildSkillNameIndex(
  skills: readonly AvailableSkill[],
): readonly IndexedSkill[] {
  return skills.flatMap((skill) => {
    const tokens = tokenizeNameText(skill.name);
    return tokens.length ? [{ skill, tokens }] : [];
  });
}

export function matchSkillNames(params: {
  index: readonly IndexedSkill[];
  input: string;
  options: NameMatchOptions;
}): SkillNameCandidate[] {
  const inputTokens = tokenizeNameText(extractEnglishSegments(params.input));
  if (!inputTokens.length) return [];
  if (
    inputTokens.length === 1 &&
    new Set(
      params.options.genericTokens.map((token) => token.trim().toLowerCase()),
    ).has(inputTokens[0]!)
  )
    return [];

  return params.index.flatMap(({ skill, tokens }) => {
    const available = new Set(tokens);
    const matched = new Set<string>();
    for (const inputToken of inputTokens) {
      if (available.has(inputToken)) {
        available.delete(inputToken);
        matched.add(inputToken);
        continue;
      }
      const options = [...available].flatMap((nameToken) => {
        const distance = boundedLevenshtein(
          letters(inputToken),
          letters(nameToken),
          params.options.maxEditDistance,
        );
        return distance === undefined ? [] : [{ nameToken, distance }];
      });
      const minimum = Math.min(...options.map((option) => option.distance));
      const closest = options.filter((option) => option.distance === minimum);
      if (closest.length === 1) {
        available.delete(closest[0]!.nameToken);
        matched.add(closest[0]!.nameToken);
      }
    }
    const score =
      matched.size / (inputTokens.length + tokens.length - matched.size);
    const rounded = Math.round(score * 1_000) / 1_000;
    return rounded >= Math.round(params.options.minJaccardScore * 1_000) / 1_000
      ? [{ skillName: skill.name, score, source: "name-match" as const }]
      : [];
  });
}

export function matchAvailableSkillNames(params: {
  skills: readonly AvailableSkill[];
  input: string;
  options: NameMatchOptions;
}): SkillNameCandidate[] {
  return matchSkillNames({
    ...params,
    index: buildSkillNameIndex(params.skills),
  });
}

export function canonicalSkillName(value: string): string | undefined {
  return canonicalIdentity(value);
}
