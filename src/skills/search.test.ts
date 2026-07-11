import { describe, expect, it } from "vitest";
import type { AvailableSkill, RelatedSkillResult } from "./types.js";
import {
  buildSkillIntentReferenceMap,
  normalizeSearchText,
  searchSkillDocuments,
  type SkillIntentReference,
  type SkillSearchDocument,
} from "./search.js";

function document(
  name: string,
  options: {
    description?: string;
    domains?: string[];
    source?: AvailableSkill["source"];
    usageTurns?: number;
    relatedSkills?: RelatedSkillResult[];
    intentReferences?: SkillIntentReference[];
  } = {},
): SkillSearchDocument {
  return {
    skill: {
      name,
      location: `/skills/${name}/SKILL.md`,
      description: options.description ?? "",
      source: options.source ?? "managed",
      domains: options.domains ?? [],
    },
    usageTurns: options.usageTurns ?? 0,
    relatedSkills: options.relatedSkills ?? [],
    intentReferences: options.intentReferences ?? [],
  };
}

function intent(
  id: string,
  options: Partial<Omit<SkillIntentReference, "id">> = {},
): SkillIntentReference {
  return {
    id,
    domain: options.domain ?? "general",
    triggers: options.triggers ?? [],
    examples: options.examples ?? [],
    fastpathKeywords: options.fastpathKeywords ?? [],
  };
}

describe("normalizeSearchText", () => {
  it("normalizes Unicode width, case, and whitespace", () => {
    expect(normalizeSearchText("  ＲＥＡＣＴ   Form  ")).toBe("react form");
  });
});

describe("buildSkillIntentReferenceMap", () => {
  it("deduplicates one intent referenced by frontmatter and prompt body", () => {
    const references = buildSkillIntentReferenceMap([
      {
        id: "writer-workflow",
        definition: {
          triggers: ["agent workflow"],
          examples: [],
          domain: "writing",
          fastpath: { keywords: [] },
          skills: ["writer"],
          prompt: "Use skill: writer for workflow prose.",
        },
      },
    ]);

    expect(references.get("writer")).toHaveLength(1);
    expect(references.get("writer")?.[0]?.id).toBe("writer-workflow");
  });
});

describe("searchSkillDocuments", () => {
  it("rejects whitespace-only search criteria", () => {
    expect(
      searchSkillDocuments([document("react")], {
        query: "   ",
        domains: [" "],
        keywords: ["", "  "],
      }),
    ).toEqual({
      success: false,
      error: "query or at least one filter is required",
    });
  });

  it("keeps a Chinese phrase and splits only on explicit whitespace", () => {
    const result = searchSkillDocuments(
      [
        document("chinese-form", {
          description: "建立 React 表單與表單驗證流程",
        }),
      ],
      { query: "建立 React 表單" },
    );

    expect(result).toMatchObject({
      success: true,
      skills: [
        {
          name: "chinese-form",
          score: 40,
          matched_fields: ["description"],
        },
      ],
    });
  });

  it("deduplicates query and keyword tokens while stacking phrase and token fields", () => {
    const result = searchSkillDocuments(
      [document("builder-form", { description: "React form patterns" })],
      {
        query: "React React form",
        keywords: ["react", "FORM"],
      },
    );

    expect(result).toMatchObject({
      success: true,
      skills: [
        {
          name: "builder-form",
          score: 55,
          matched_fields: ["name", "description"],
        },
      ],
    });
  });

  it("uses only the highest exact, prefix, or token skill-name score", () => {
    const exact = searchSkillDocuments([document("react")], { query: "react" });
    const prefix = searchSkillDocuments([document("react-forms")], {
      query: "react",
    });
    const token = searchSkillDocuments([document("forms-react")], {
      query: "react",
    });

    expect(exact).toMatchObject({ skills: [{ score: 100 }] });
    expect(prefix).toMatchObject({ skills: [{ score: 70 }] });
    expect(token).toMatchObject({ skills: [{ score: 45 }] });
  });

  it("uses domains as a case-insensitive OR filter without filter points", () => {
    const result = searchSkillDocuments(
      [
        document("react", { domains: ["Frontend"] }),
        document("vitest", { domains: ["testing"] }),
        document("postgres", { domains: ["database"] }),
      ],
      { domains: ["FRONTEND", "Testing"] },
    );

    expect(result).toMatchObject({
      success: true,
      total: 2,
      skills: [
        { name: "react", score: 0 },
        { name: "vitest", score: 0 },
      ],
    });
  });

  it("applies the source filter before returning candidates", () => {
    const result = searchSkillDocuments(
      [
        document("workspace-skill", { source: "workspace" }),
        document("managed-skill", { source: "managed" }),
      ],
      { source: "workspace" },
    );

    expect(result).toMatchObject({
      success: true,
      total: 1,
      skills: [{ name: "workspace-skill", source: "workspace" }],
    });
  });

  it("awards domain points once when query or keywords match a derived domain", () => {
    const result = searchSkillDocuments(
      [document("react", { domains: ["frontend", "react"] })],
      { query: "frontend", keywords: ["FRONTEND", "react"] },
    );

    expect(result).toMatchObject({
      skills: [
        {
          name: "react",
          score: 135,
          matched_fields: ["name", "domains"],
        },
      ],
    });
  });

  it("caps each intent field at three contributing intents", () => {
    const intentReferences = ["delta", "alpha", "charlie", "bravo"].map((id) =>
      intent(id, {
        triggers: ["agent workflow", "agent workflow"],
        examples: ["agent workflow"],
        fastpathKeywords: ["workflow"],
      }),
    );

    const result = searchSkillDocuments(
      [document("writer", { intentReferences })],
      { query: "agent workflow" },
    );

    expect(result).toMatchObject({
      skills: [
        {
          name: "writer",
          score: 210,
          matched_fields: [
            "intent.triggers",
            "intent.examples",
            "intent.fastpath_keywords",
          ],
          matched_intents: [
            { id: "alpha" },
            { id: "bravo" },
            { id: "charlie" },
          ],
        },
      ],
    });
  });

  it("searches visible related skill names once but not relation reasons", () => {
    const relatedSkills: RelatedSkillResult[] = [
      {
        name: "react",
        reason: "forms and components",
        direction: "current-to-related",
      },
      {
        name: "react-router",
        reason: "navigation",
        direction: "current-to-related",
      },
    ];

    expect(
      searchSkillDocuments([document("nextjs", { relatedSkills })], {
        query: "react",
      }),
    ).toMatchObject({
      skills: [
        {
          name: "nextjs",
          score: 15,
          matched_fields: ["related_skills"],
        },
      ],
    });
    expect(
      searchSkillDocuments([document("nextjs", { relatedSkills })], {
        query: "navigation",
      }),
    ).toMatchObject({ success: true, total: 0, skills: [] });
  });

  it("uses capped logarithmic usage boost only after a lexical match", () => {
    const matching = searchSkillDocuments(
      [document("react", { usageTurns: 1_024 })],
      { query: "react" },
    );
    const notMatching = searchSkillDocuments(
      [document("popular", { usageTurns: 1_024 })],
      { query: "react" },
    );

    expect(matching).toMatchObject({ skills: [{ score: 110 }] });
    expect(notMatching).toMatchObject({ success: true, total: 0, skills: [] });
  });

  it("sorts by score, source precedence, usage turns, and name", () => {
    const result = searchSkillDocuments(
      [
        document("zeta", {
          description: "searchable",
          source: "managed",
          usageTurns: 4,
        }),
        document("bundled", {
          description: "searchable",
          source: "bundled",
          usageTurns: 4,
        }),
        document("alpha", {
          description: "searchable",
          source: "managed",
          usageTurns: 4,
        }),
        document("popular", {
          description: "searchable",
          source: "managed",
          usageTurns: 5,
        }),
      ],
      { query: "searchable" },
    );

    expect(result).toMatchObject({
      skills: [
        { name: "popular" },
        { name: "alpha" },
        { name: "zeta" },
        { name: "bundled" },
      ],
    });
  });

  it("paginates after ranking and conditionally returns next_offset", () => {
    const documents = [
      document("alpha"),
      document("bravo"),
      document("charlie"),
    ];
    const firstPage = searchSkillDocuments(documents, {
      source: "managed",
      limit: 2,
    });
    const secondPage = searchSkillDocuments(documents, {
      source: "managed",
      offset: 2,
      limit: 2,
    });

    expect(firstPage).toMatchObject({
      success: true,
      total: 3,
      count: 2,
      offset: 0,
      limit: 2,
      has_more: true,
      next_offset: 2,
      skills: [{ name: "alpha" }, { name: "bravo" }],
    });
    expect(secondPage).toMatchObject({
      success: true,
      total: 3,
      count: 1,
      offset: 2,
      limit: 2,
      has_more: false,
      skills: [{ name: "charlie" }],
    });
    expect(secondPage).not.toHaveProperty("next_offset");
  });

  it("defaults to 20 results and caps the requested limit at 100", () => {
    const documents = Array.from({ length: 105 }, (_, index) =>
      document(`skill-${String(index).padStart(3, "0")}`),
    );

    const defaultPage = searchSkillDocuments(documents, { source: "managed" });
    const maximumPage = searchSkillDocuments(documents, {
      source: "managed",
      limit: 1_000,
    });

    expect(defaultPage).toMatchObject({
      total: 105,
      count: 20,
      limit: 20,
      has_more: true,
      next_offset: 20,
    });
    expect(maximumPage).toMatchObject({
      total: 105,
      count: 100,
      limit: 100,
      has_more: true,
      next_offset: 100,
    });
  });
});
