import { describe, it, expect } from "vitest";
import {
  buildIntentInstructionPrompt,
  buildIntentionPrompt,
  buildTopicSwitchPrompt,
  parseIntentionResult,
  parseTopicSwitchResult,
  buildPromptPrefix,
} from "./prompt.js";
import type {
  IntentCatalogEntry,
  IntentionResult,
  ResolvedIntentionHintPluginConfig,
  RecentTurn,
} from "./types.js";
import { FALLBACK_INTENT, FALLBACK_INTENT_ID } from "./constants.js";

describe("buildIntentionPrompt", () => {
  const mockIntents: IntentCatalogEntry[] = [
    {
      id: "coding",
      definition: {
        triggers: ["write code", "implement", "create function"],
        examples: [
          "Write a function to sort an array",
          "Implement a login system",
        ],
        prompt: "You are helping with coding tasks.",
      },
    },
    {
      id: "debugging",
      definition: {
        triggers: ["fix bug", "error", "not working"],
        examples: ["My code throws an error", "Fix this bug"],
        prompt: "You are helping debug issues.",
      },
    },
  ];

  it("should include intent catalog in prompt", () => {
    const result = buildIntentionPrompt({
      intents: mockIntents,
      latest: "hello",
    });

    expect(result).toContain('<intent id="coding">');
    expect(result).toContain('<intent id="debugging">');
    expect(result).not.toContain("name=");
    expect(result).toContain("triggers:");
    expect(result).toContain("- write code");
    expect(result).toContain("examples:");
    expect(result).toContain("- Write a function to sort an array");
  });

  it("should include every loaded intent because disabled frontmatter is removed", () => {
    const intents: IntentCatalogEntry[] = [
      ...mockIntents,
      {
        id: "formerly-disabled",
        definition: {
          triggers: ["test"],
          examples: [],
          prompt: "This should appear.",
        },
      },
    ];
    const result = buildIntentionPrompt({
      intents,
      latest: "hello",
    });

    expect(result).toContain('<intent id="formerly-disabled">');
    expect(result).toContain("- test");
  });

  it("should always include fallback intent", () => {
    const result = buildIntentionPrompt({
      intents: [],
      latest: "hello",
    });

    expect(result).toContain(FALLBACK_INTENT_ID);
    expect(result).toContain('<intent id="other">');
  });

  it("should include conversation history when provided", () => {
    const conversation: RecentTurn[] = [
      {
        role: "user",
        text: "Hello there",
        historicalIntent: {
          intent: "coding",
        },
      },
      { role: "assistant", text: "Hi! How can I help?" },
    ];

    const result = buildIntentionPrompt({
      intents: mockIntents,
      latest: "I need help with code",
      conversation,
    });

    // Check for Markdown format
    expect(result).toContain("# Conversation context");
    expect(result).toContain("## Recent history");
    expect(result).toContain("- **user**: Hello there");
    expect(result).toContain("> *intent: coding*");
    expect(result).toContain("- **assistant**: Hi! How can I help?");
  });
  it("should include latest message in input section", () => {
    const result = buildIntentionPrompt({
      intents: mockIntents,
      latest: "I need help with code",
    });

    expect(result).toContain("## Latest message:");
    expect(result).toContain("I need help with code");
    expect(result).not.toContain("<latest>");
  });

  it("should not include a previous intent result section", () => {
    const result = buildIntentionPrompt({
      intents: mockIntents,
      latest: "動手",
    });

    expect(result).not.toContain("<previous_intent_result>");
    expect(result).not.toContain("previousIntentResult");
    expect(result).not.toContain("Previous Intent Continuity");
  });

  it("should work with empty conversation", () => {
    const result = buildIntentionPrompt({
      intents: mockIntents,
      latest: "test message",
    });

    expect(result).not.toContain("## Conversation context");
    expect(result).not.toContain("### Recent history");
    expect(result).toContain("## Latest message:");
    expect(result).toContain("test message");
  });

  it("should include classification rules and output format", () => {
    const result = buildIntentionPrompt({
      intents: mockIntents,
      latest: "hello",
    });

    expect(result).toContain("<classification_rules>");
    expect(result).toContain("<output_format>");
    expect(result).toContain('"intent":');
    expect(result).toContain('"reason":');
    expect(result).toContain('"keywords":');
    expect(result).toContain('"confidence":');
    expect(result).toContain('"complexity":');
    expect(result).toContain("historical_intent");
    expect(result).toContain("Topic switch");
    expect(result).toContain("historical topic");
  });
});

describe("buildTopicSwitchPrompt", () => {
  it("builds a compact topic continuity prompt from historical metadata", () => {
    const prompt = buildTopicSwitchPrompt({
      latest: "繼續實作 topic checker",
      history: [
        {
          input: "規劃 topic checker",
          intent: "coding",
          keywords: ["topic", "checker"],
          topic: "topic / checker",
          complexity: "medium",
        },
      ],
    });

    expect(prompt).toContain("topic continuity checker");
    expect(prompt).toContain(
      "Another model is preparing the final user-facing answer",
    );
    expect(prompt).toContain(
      "Your job is to decide whether the user's latest message continues",
    );
    expect(prompt).toContain("intent: coding");
    expect(prompt).toContain("keywords: topic, checker");
    expect(prompt).toContain("## Latest message:");
    expect(prompt).toContain("繼續實作 topic checker");
  });
});

describe("parseTopicSwitchResult", () => {
  it("normalizes keywords and computes topic", () => {
    const result = parseTopicSwitchResult(
      JSON.stringify({
        keywords: [" Topic ", "Checker", "topic", "Flow"],
        topicChanged: false,
        topicChangeReason: "same_topic",
        complexity: "medium",
      }),
    );

    expect(result).toEqual({
      keywords: ["topic", "checker", "flow"],
      topic: "topic / checker / flow",
      topicChanged: false,
      topicChangeReason: "same_topic",
      complexity: "medium",
    });
  });

  it("accepts fenced JSON and rejects invalid reasons", () => {
    expect(
      parseTopicSwitchResult(
        '```json\n{"keywords":["deploy"],"topicChanged":true,"topicChangeReason":"transition_marker","complexity":"high"}\n```',
      ),
    ).toMatchObject({
      keywords: ["deploy"],
      topic: "deploy",
      topicChanged: true,
      topicChangeReason: "transition_marker",
      complexity: "high",
    });

    expect(
      parseTopicSwitchResult(
        JSON.stringify({
          keywords: ["deploy"],
          topicChanged: true,
          topicChangeReason: "initial",
          complexity: "medium",
        }),
      ),
    ).toBeUndefined();

    expect(
      parseTopicSwitchResult(
        JSON.stringify({
          keywords: ["deploy"],
          topicChanged: true,
          topicChangeReason: "transition_marker",
          complexity: "huge",
        }),
      ),
    ).toBeUndefined();
  });
});

describe("buildIntentInstructionPrompt", () => {
  it("includes the matched intent body, latest message, and instruction requirements", () => {
    const prompt = buildIntentInstructionPrompt({
      latest: "繼續實作同題續聊",
      result: {
        intent: "coding",
        reason: "User wants implementation",
        keywords: ["topic", "continuation"],
        topic: "topic / continuation",
        intentChange: false,
        confidence: 0.9,
        complexity: "medium",
      },
      intentBody:
        "## Concrete Workflow\n\n- Use test-driven-development.\n\n## Tools\n\n- apply_patch",
      complexityContext:
        "<complexity_context>Use a balanced flow.</complexity_context>",
      conversation: [
        {
          role: "user",
          text: "先做 topic checker",
          historicalIntent: {
            intent: "coding",
            topic: "topic / checker",
            keywords: ["topic", "checker"],
          },
        },
        { role: "assistant", text: "我會先接流程" },
      ],
    });

    expect(prompt).toContain("instruction writer");
    expect(prompt).toContain(
      "Another model is preparing the final user-facing answer",
    );
    expect(prompt).toContain(
      "Your job is to read the matched intent Markdown and latest user message",
    );
    expect(prompt).toContain("workflow");
    expect(prompt).toContain("skills and tools");
    expect(prompt).toContain("intent: coding");
    expect(prompt).toContain("intentChange: false");
    expect(prompt).toContain(
      "<complexity_context>Use a balanced flow.</complexity_context>",
    );
    expect(prompt).toContain("# Conversation context");
    expect(prompt).toContain("- **user**: 先做 topic checker");
    expect(prompt).toContain(
      "> *intent: coding; topic: topic / checker; keywords: topic, checker*",
    );
    expect(prompt).toContain("- **assistant**: 我會先接流程");
    expect(prompt).toContain("Use test-driven-development");
    expect(prompt).toContain("apply_patch");
    expect(prompt).toContain("繼續實作同題續聊");
  });
});

describe("parseIntentionResult", () => {
  it("should parse valid intention result", () => {
    const raw = JSON.stringify({
      intent: "coding",
      reason: "User wants to write code",
      keywords: [" Sort ", "Array", "sort"],
      confidence: 0.85,
      complexity: "medium",
    });

    const result = parseIntentionResult(raw, ["coding", "debugging", "other"]);

    expect(result).toBeDefined();
    expect(result!.intent).toBe("coding");
    expect(result!.reason).toBe("User wants to write code");
    expect(result!.keywords).toEqual(["sort", "array"]);
    expect(result!.topic).toBe("sort / array");
    expect(result!.topicChanged).toBe(false);
    expect(result!.topicChangeReason).toBe("initial");
    expect(result!.confidence).toBe(0.85);
    expect(result!.complexity).toBe("medium");
  });

  it("merges topic switch metadata into parsed intention results", () => {
    const result = parseIntentionResult(
      JSON.stringify({
        intent: "coding",
        reason: "User continues implementation",
        confidence: 0.85,
      }),
      ["coding", "other"],
      {
        keywords: ["topic", "checker", "implementation"],
        topic: "topic / checker / implementation",
        topicChanged: false,
        topicChangeReason: "same_topic",
        complexity: "high",
      },
    );

    expect(result).toMatchObject({
      keywords: ["topic", "checker", "implementation"],
      topic: "topic / checker / implementation",
      topicChanged: false,
      topicChangeReason: "same_topic",
      complexity: "high",
    });
  });

  it("should store pure id when a matching id is wrapped with display text", () => {
    const raw = JSON.stringify({
      intent: "memory-lookup (Memory Lookup)",
      reason: "User asked to recall previous conversation topic",
      confidence: 0.9,
      complexity: "medium",
    });

    const result = parseIntentionResult(raw, [
      "memory-lookup",
      "coding",
      FALLBACK_INTENT_ID,
    ]);

    expect(result).toBeDefined();
    expect(result!.intent).toBe("memory-lookup");
    expect(result!.reason).toBe(
      "User asked to recall previous conversation topic",
    );
    expect(result!.confidence).toBe(0.9);
    expect(result!.complexity).toBe("medium");
  });

  it("should parse with suggestion when confidence is low", () => {
    const raw = JSON.stringify({
      intent: "other",
      reason: "Unable to confidently classify",
      confidence: 0.45,
      complexity: "low",
      suggestion: "Please clarify what you need help with",
    });

    const result = parseIntentionResult(raw, ["coding", "debugging", "other"]);

    expect(result).toBeDefined();
    expect(result!.intent).toBe("other");
    expect(result!.suggestion).toBe("Please clarify what you need help with");
  });

  it("should handle case-insensitive intent matching", () => {
    const raw = JSON.stringify({
      intent: "CODING",
      reason: "User wants code",
      confidence: 0.8,
      complexity: "medium",
    });

    const result = parseIntentionResult(raw, ["coding", "other"]);

    expect(result).toBeDefined();
    expect(result!.intent).toBe("coding");
  });

  it("should return undefined for incomplete results", () => {
    const raw = JSON.stringify({
      intent: "coding",
      reason: "User wants code",
    });

    const result = parseIntentionResult(raw, ["coding", "other"]);

    expect(result).toBeUndefined();
  });

  it("should fallback to valid intent when intent not in list", () => {
    const raw = JSON.stringify({
      intent: "unknown-intent",
      reason: "Some reason",
      confidence: 0.8,
      complexity: "medium",
    });

    const result = parseIntentionResult(raw, ["coding", "other"]);

    expect(result).toBeDefined();
    expect(result!.intent).toBe("other");
  });

  it("should handle confidence as integer", () => {
    const raw = JSON.stringify({
      intent: "coding",
      reason: "User wants code",
      confidence: 1,
      complexity: "low",
    });

    const result = parseIntentionResult(raw, ["coding"]);

    expect(result).toBeDefined();
    expect(result!.confidence).toBe(1);
  });

  it("should ignore invalid confidence values", () => {
    const raw = JSON.stringify({
      intent: "coding",
      reason: "User wants code",
      confidence: "invalid",
      complexity: "low",
    });

    const result = parseIntentionResult(raw, ["coding"]);

    expect(result).toBeUndefined();
  });

  it("should ignore out-of-range confidence values", () => {
    const raw = JSON.stringify({
      intent: "coding",
      reason: "User wants code",
      confidence: 1.5,
      complexity: "low",
    });

    const result = parseIntentionResult(raw, ["coding"]);

    expect(result).toBeUndefined();
  });

  it("should handle empty suggestion", () => {
    const raw = JSON.stringify({
      intent: "coding",
      reason: "User wants code",
      confidence: 0.8,
      complexity: "low",
      suggestion: "",
    });

    const result = parseIntentionResult(raw, ["coding"]);

    expect(result).toBeDefined();
    expect(result!.suggestion).toBeUndefined();
  });

  it("should parse JSON wrapped in ```json code block", () => {
    const raw =
      '```json\n{"intent": "coding", "reason": "test", "confidence": 0.9, "complexity": "medium"}\n```';
    const result = parseIntentionResult(raw, ["coding"]);
    expect(result).toBeDefined();
    expect(result!.intent).toBe("coding");
  });

  it("should parse JSON wrapped in ``` without json tag", () => {
    const raw =
      '```\n{"intent": "coding", "reason": "test", "confidence": 0.9, "complexity": "low"}\n```';
    const result = parseIntentionResult(raw, ["coding"]);
    expect(result).toBeDefined();
  });

  it("should return undefined for malformed JSON", () => {
    const raw = "{bad json here";
    const result = parseIntentionResult(raw, ["coding"]);
    expect(result).toBeUndefined();
  });

  it("should return undefined for empty string", () => {
    const result = parseIntentionResult("", ["coding"]);
    expect(result).toBeUndefined();
  });

  it("should return undefined when required fields missing", () => {
    const raw = JSON.stringify({ intent: "coding", reason: "test" });
    const result = parseIntentionResult(raw, ["coding"]);
    expect(result).toBeUndefined();
  });

  it("should return undefined for invalid complexity", () => {
    const raw = JSON.stringify({
      intent: "coding",
      reason: "test",
      confidence: 0.9,
      complexity: "invalid",
    });
    const result = parseIntentionResult(raw, ["coding"]);
    expect(result).toBeUndefined();
  });

  it("should handle optional suggestion only when present", () => {
    const raw = JSON.stringify({
      intent: "coding",
      reason: "test",
      confidence: 0.5,
      complexity: "high",
      suggestion: "Consider breaking into smaller tasks",
    });
    const result = parseIntentionResult(raw, ["coding"]);
    expect(result).toBeDefined();
    expect(result!.suggestion).toBe("Consider breaking into smaller tasks");
  });

  it("should NOT have suggestion when not in JSON", () => {
    const raw = JSON.stringify({
      intent: "coding",
      reason: "test",
      confidence: 0.9,
      complexity: "low",
    });
    const result = parseIntentionResult(raw, ["coding"]);
    expect(result).toBeDefined();
    expect(result!.suggestion).toBeUndefined();
  });
});

describe("buildPromptPrefix", () => {
  const mockIntents: IntentCatalogEntry[] = [
    {
      id: "coding",
      definition: {
        triggers: [],
        examples: [],
        prompt:
          "You are helping with coding tasks. Write clean, well-tested code.",
      },
    },
    {
      id: "debugging",
      definition: {
        triggers: [],
        examples: [],
        prompt: "You are helping debug issues. Be thorough in your analysis.",
      },
    },
    {
      id: "agent-dispatch",
      definition: {
        triggers: [],
        examples: [],
        prompt: "Agent dispatch and orchestration guidance.",
      },
    },
  ];

  const mockConfig: ResolvedIntentionHintPluginConfig = {
    agents: [],
    intentDeny: {},
    model: undefined,
    modelFallback: undefined,
    allowedChatTypes: [],
    allowedChatIds: [],
    deniedChatIds: [],
    queryMode: "recent",
    contextWindow: {
      user: { turns: 5, chars: 220 },
      assistant: { turns: 5, chars: 180 },
    },
    timeoutMs: 3000,
    complexityPrompts: {
      low: "LOW_COMPLEXITY_PROMPT",
      medium: "MEDIUM_COMPLEXITY_PROMPT",
      high: "HIGH_COMPLEXITY_PROMPT",
    },
  };

  it("should build prefix with intent prompt and complexity metadata only", () => {
    const result: IntentionResult = {
      intent: "coding",
      reason: "User wants to write code",
      confidence: 0.9,
      complexity: "medium",
    };

    const prefix = buildPromptPrefix(result, mockIntents, mockConfig);

    expect(prefix).toBeDefined();
    expect(prefix).toContain("reason: User wants to write code");
    expect(prefix).toContain("confidence: 0.9");
    expect(prefix).toContain("complexity: medium");
    expect(prefix).toContain("You are helping with coding tasks");
    expect(prefix).not.toContain("MEDIUM_COMPLEXITY_PROMPT");
    expect(prefix).not.toContain("<complexity_context>");
  });

  it("includes intent change metadata when present", () => {
    const result: IntentionResult = {
      intent: "coding",
      reason: "User continues the same topic",
      intentChange: false,
      confidence: 0.9,
      complexity: "medium",
    };

    const prefix = buildPromptPrefix(result, mockIntents, mockConfig);

    expect(prefix).toContain("intentChange: false");
  });

  it("includes topic metadata when present", () => {
    const result: IntentionResult = {
      intent: "coding",
      reason: "User wants code",
      keywords: ["topic", "flow"],
      topic: "topic / flow",
      topicChanged: true,
      topicChangeReason: "transition_marker",
      previousTopic: "docs",
      confidence: 0.9,
      complexity: "medium",
    };

    const prefix = buildPromptPrefix(result, mockIntents, mockConfig);

    expect(prefix).toContain("topic: topic / flow");
    expect(prefix).toContain("keywords: topic, flow");
    expect(prefix).toContain("topicChanged: true");
    expect(prefix).toContain("topicChangeReason: transition_marker");
    expect(prefix).toContain("previousTopic: docs");
  });

  it("uses generated instruction text when provided", () => {
    const result: IntentionResult = {
      intent: "coding",
      reason: "User wants code",
      confidence: 0.9,
      complexity: "medium",
    };

    const prefix = buildPromptPrefix(
      result,
      mockIntents,
      mockConfig,
      "Run tests first, then edit with apply_patch.",
    );

    expect(prefix).toContain("Run tests first, then edit with apply_patch.");
    expect(prefix).not.toContain("Write clean, well-tested code.");
  });

  it("should match filename intent ids when result includes display text", () => {
    const result: IntentionResult = {
      intent: "agent-dispatch (Agent Dispatch & Orchestration)",
      reason:
        "User is confirming/approving a prior proposal to organize a file",
      confidence: 0.75,
      complexity: "medium",
    };

    const prefix = buildPromptPrefix(result, mockIntents, mockConfig);

    expect(prefix).toContain("Agent dispatch and orchestration guidance.");
    expect(prefix).not.toContain(FALLBACK_INTENT.prompt);
  });

  it("should include suggestion when present", () => {
    const result: IntentionResult = {
      intent: "coding",
      reason: "User wants code",
      suggestion: "Consider breaking this into smaller tasks",
      confidence: 0.6,
      complexity: "high",
    };

    const prefix = buildPromptPrefix(result, mockIntents, mockConfig);

    expect(prefix).toContain(
      "suggestion: Consider breaking this into smaller tasks",
    );
  });

  it("should not append complexity prompt text", () => {
    const result: IntentionResult = {
      intent: "coding",
      reason: "Complex request",
      confidence: 0.8,
      complexity: "high",
    };

    const prefix = buildPromptPrefix(result, mockIntents, mockConfig);

    expect(prefix).toContain("complexity: high");
    expect(prefix).not.toContain("HIGH_COMPLEXITY_PROMPT");
  });

  it("should fallback to FALLBACK_INTENT when intent not found", () => {
    const result: IntentionResult = {
      intent: "unknown-intent",
      reason: "Unknown request",
      confidence: 0.5,
      complexity: "medium",
    };

    const prefix = buildPromptPrefix(result, mockIntents, mockConfig);

    expect(prefix).toContain(FALLBACK_INTENT.prompt);
  });

  it("should wrap content in intention_hint_plugin tags", () => {
    const result: IntentionResult = {
      intent: "coding",
      reason: "User wants code",
      confidence: 0.9,
      complexity: "medium",
    };

    const prefix = buildPromptPrefix(result, mockIntents, mockConfig);

    expect(prefix).toContain("<intention_hint_plugin>");
    expect(prefix).toContain("</intention_hint_plugin>");
  });

  it("should include untrusted context header", () => {
    const result: IntentionResult = {
      intent: "coding",
      reason: "User wants code",
      confidence: 0.9,
      complexity: "medium",
    };

    const prefix = buildPromptPrefix(result, mockIntents, mockConfig);

    expect(prefix).toContain("Untrusted context");
  });
});
