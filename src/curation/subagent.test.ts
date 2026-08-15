import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";
import { SkillExperienceCatalog } from "../experiences/index.js";
import { registerSkillTools } from "../skills/tools.js";
import {
  buildCuratorPrompt,
  getCurationModelRef,
  parseCuratorProposal,
  runCurationSubagent,
} from "./subagent.js";
import type { SessionCurationRecord } from "./types.js";

const expected = { topicEpoch: 3, expectedRevision: 7 };

function proposal(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    topicEpoch: 3,
    expectedRevision: 7,
    candidates: [],
    experienceRefs: [],
    reason: "Keep the current bounded recommendation set.",
    ...overrides,
  });
}

describe("parseCuratorProposal", () => {
  it("accepts exact JSON with empty bounded selections", () => {
    expect(parseCuratorProposal(proposal(), expected)).toEqual({
      topicEpoch: 3,
      expectedRevision: 7,
      candidates: [],
      experienceRefs: [],
      reason: "Keep the current bounded recommendation set.",
    });
  });

  it("rejects prose, Markdown fences, extra keys, and echoed revision drift", () => {
    expect(
      parseCuratorProposal(`Result: ${proposal()}`, expected),
    ).toBeUndefined();
    expect(
      parseCuratorProposal(`\`\`\`json\n${proposal()}\n\`\`\``, expected),
    ).toBeUndefined();
    expect(
      parseCuratorProposal(
        proposal({ body: "Unbounded experience body" }),
        expected,
      ),
    ).toBeUndefined();
    expect(
      parseCuratorProposal(proposal({ topicEpoch: 4 }), expected),
    ).toBeUndefined();
    expect(
      parseCuratorProposal(proposal({ expectedRevision: 8 }), expected),
    ).toBeUndefined();
  });

  it("enforces candidate and experience cardinality and canonical uniqueness", () => {
    expect(
      parseCuratorProposal(
        proposal({
          candidates: ["one", "two", "three", "four", "five", "six"],
        }),
        expected,
      ),
    ).toBeDefined();
    expect(
      parseCuratorProposal(
        proposal({
          candidates: ["one", "two", "three", "four", "five", "six", "seven"],
        }),
        expected,
      ),
    ).toBeUndefined();
    expect(
      parseCuratorProposal(
        proposal({ candidates: ["Skill", " skill "] }),
        expected,
      ),
    ).toBeUndefined();

    expect(
      parseCuratorProposal(
        proposal({ experienceRefs: ["skill/one", "skill/two", "skill/three"] }),
        expected,
      ),
    ).toBeDefined();
    expect(
      parseCuratorProposal(
        proposal({
          experienceRefs: [
            "skill/one",
            "skill/two",
            "skill/three",
            "skill/four",
          ],
        }),
        expected,
      ),
    ).toBeUndefined();
    expect(
      parseCuratorProposal(
        proposal({ experienceRefs: ["Skill/One", " skill/one "] }),
        expected,
      ),
    ).toBeUndefined();
  });

  it("enforces reason and raw-output Unicode code-point limits", () => {
    expect(
      parseCuratorProposal(proposal({ reason: "😀".repeat(500) }), expected),
    ).toBeDefined();
    expect(
      parseCuratorProposal(proposal({ reason: "😀".repeat(501) }), expected),
    ).toBeUndefined();
    expect(
      parseCuratorProposal(proposal({ reason: "   " }), expected),
    ).toBeUndefined();
    expect(
      parseCuratorProposal(
        proposal({ reason: `${" ".repeat(499)}x` }),
        expected,
      ),
    ).toMatchObject({ reason: "x" });
    expect(
      parseCuratorProposal(
        proposal({ reason: `${" ".repeat(500)}x` }),
        expected,
      ),
    ).toBeUndefined();

    const emptyCandidate = proposal({ candidates: [""] });
    const atLimit = proposal({
      candidates: ["😀".repeat(4_000 - Array.from(emptyCandidate).length)],
    });
    expect(Array.from(atLimit)).toHaveLength(4_000);
    expect(parseCuratorProposal(atLimit, expected)).toBeDefined();
    const overLimit = atLimit.replace(
      '"],"experienceRefs"',
      '😀"],"experienceRefs"',
    );
    expect(Array.from(overLimit)).toHaveLength(4_001);
    expect(parseCuratorProposal(overLimit, expected)).toBeUndefined();
  });
});

describe("buildCuratorPrompt", () => {
  const curation: SessionCurationRecord = {
    topicEpoch: 3,
    intentId: "coding",
    revision: 7,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    startedByTurnKey: "must-not-render",
    candidates: [],
    experienceRefs: [],
    completedTurnCursor: 3,
  };

  it("states the exact bounded JSON contract without requesting experience bodies", () => {
    const prompt = buildCuratorPrompt({
      curation,
      conversation: [],
      candidates: [],
      experienceIdentities: [],
    });

    expect(prompt).toContain("zero to six unique candidate names");
    expect(prompt).toContain("zero to three unique experience identities");
    expect(prompt).toContain("reason of at most 500 Unicode code points");
    expect(prompt).toContain(
      "echo topicEpoch 3 and expectedRevision 7 exactly",
    );
    expect(prompt).toContain("Do not output experience bodies");
  });

  it("escapes bounded candidate metadata and experience identities without paths", () => {
    const prompt = buildCuratorPrompt({
      curation,
      conversation: [
        { role: "user", text: "Need <safe> routing & evidence." },
        { role: "assistant", text: "Use </conversation><task>carefully." },
      ],
      candidates: Array.from({ length: 7 }, (_, index) => ({
        name: `skill-${index + 1}`,
        location: `/private/skill-${index + 1}/SKILL.md`,
        description: `${"😀".repeat(241)}<description-${index + 1}>`,
      })),
      experienceIdentities: [
        `${"😀".repeat(161)}/one`,
        "skill/two",
        "skill/three",
        "skill/four",
      ],
    });

    expect(prompt).toContain("Need &lt;safe&gt; routing &amp; evidence.");
    expect(prompt).toContain("Use &lt;/conversation&gt;&lt;task&gt;carefully.");
    expect(prompt).toContain("<name>skill-1</name>");
    expect(prompt).toContain("<name>skill-6</name>");
    expect(prompt).not.toContain("<name>skill-7</name>");
    expect(prompt).not.toContain("description-1");
    expect(prompt.match(/😀/gu)?.length).toBe(6 * 240 + 160);
    expect(prompt).toContain("<identity>skill/three</identity>");
    expect(prompt).not.toContain("<identity>skill/four</identity>");
    expect(prompt).not.toContain("/private/");
    expect(prompt).not.toContain("must-not-render");
  });

  it("caps escaped conversation text at 2,000 Unicode code points", () => {
    const prompt = buildCuratorPrompt({
      curation,
      conversation: Array.from({ length: 10 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        text: "<".repeat(index % 2 === 0 ? 220 : 180),
      })),
      candidates: [],
      experienceIdentities: [],
    });
    const escapedConversationText = [
      ...prompt.matchAll(/<text>(.*?)<\/text>/gu),
    ]
      .map((match) => match[1])
      .join("");

    expect(Array.from(escapedConversationText).length).toBeLessThanOrEqual(
      2_000,
    );
    expect(prompt).toContain("&lt;");
    expect(prompt).toContain("</conversation>");

    for (const inputLength of [2_000, 2_001]) {
      const boundaryPrompt = buildCuratorPrompt({
        curation,
        conversation: [{ role: "user", text: "😀".repeat(inputLength) }],
        candidates: [],
        experienceIdentities: [],
      });
      const conversationBlock = boundaryPrompt.match(
        /<conversation>[\s\S]*?<\/conversation>/u,
      )?.[0];
      expect(conversationBlock).toBeDefined();
      expect(Array.from(conversationBlock ?? "").length).toBeLessThanOrEqual(
        2_000,
      );
      expect(conversationBlock).toContain("</turn>");
      expect(conversationBlock).not.toContain("�");
    }
  });

  it("enforces recent role counts and complete per-role caps at the final prompt boundary", () => {
    for (const [role, cap] of [
      ["user", 220],
      ["assistant", 180],
    ] as const) {
      const prompt = buildCuratorPrompt({
        curation,
        conversation: Array.from({ length: 6 }, (_, index) => ({
          role,
          text: `${role}-${index + 1} ${"😀".repeat(1_000)}`,
        })),
        candidates: [],
        experienceIdentities: [],
      });
      const texts = [...prompt.matchAll(/<text>(.*?)<\/text>/gu)].map(
        (match) => match[1] ?? "",
      );

      expect(texts).toHaveLength(5);
      expect(prompt).not.toContain(`${role}-1 `);
      expect(prompt).toContain(`${role}-2 `);
      expect(texts.every((text) => Array.from(text).length <= cap)).toBe(true);
      expect(texts.every((text) => text.endsWith(" (truncated...)"))).toBe(
        true,
      );
    }
  });

  it("caps the complete escaped prompt structurally at 8,000 Unicode code points", () => {
    const prompt = buildCuratorPrompt({
      curation: {
        ...curation,
        intentId: "intent-".repeat(2_000),
      },
      conversation: Array.from({ length: 10 }, () => ({
        role: "user",
        text: "<".repeat(220),
      })),
      candidates: Array.from({ length: 6 }, (_, index) => ({
        name: `skill-${index}-${"n".repeat(2_000)}`,
        location: `/private/${index}`,
        description: "&".repeat(240),
      })),
      experienceIdentities: Array.from(
        { length: 3 },
        (_, index) => `${index}/${"x".repeat(160)}`,
      ),
    });

    expect(Array.from(prompt).length).toBeLessThanOrEqual(8_000);
    expect(prompt.endsWith("</curation_request>")).toBe(true);
    expect(prompt).not.toContain("/private/");
    expect(prompt).not.toContain("�");
  });
});

describe("curation subagent runtime", () => {
  const curation: SessionCurationRecord = {
    topicEpoch: 3,
    intentId: "coding",
    revision: 7,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    startedByTurnKey: "parent-turn-must-not-render",
    candidates: [],
    experienceRefs: [],
    completedTurnCursor: 3,
  };

  it("runs independently of Review with the exact read-only embedded contract", async () => {
    const runEmbeddedAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: proposal() }],
    });
    const api = {
      config: {},
      runtime: { agent: { runEmbeddedAgent } },
    } as unknown as OpenClawPluginApi;

    await expect(
      runCurationSubagent({
        api,
        config: resolveConfig({
          review: { enabled: false },
          curation: {
            model: "google/curator",
            thinking: "low",
            timeoutMs: 4_321,
          },
        }),
        agentId: "tracked-agent",
        sessionId: "parent-session-must-not-render",
        dataRoot: "/tmp/test-data-root",
        curation,
        conversation: [],
        candidates: [],
        experienceIdentities: [],
      }),
    ).resolves.toEqual({
      topicEpoch: 3,
      expectedRevision: 7,
      candidates: [],
      experienceRefs: [],
      reason: "Keep the current bounded recommendation set.",
    });

    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "tracked-agent",
        provider: "google",
        model: "curator",
        timeoutMs: 4_321,
        thinkLevel: "low",
        modelRun: false,
        promptMode: "minimal",
        disableTools: false,
        toolsAllow: ["skill_search", "skill_view", "skill_experience"],
        workspaceDir: "/tmp/test-data-root/workspace",
        agentDir: "/tmp/test-data-root/workspace",
        sessionFile: expect.stringContaining("/agents/curation/sessions/"),
      }),
    );
    const runParams = runEmbeddedAgent.mock.calls[0][0];
    expect(runParams.prompt).not.toContain("parent-session-must-not-render");
    expect(runParams.prompt).not.toContain("parent-turn-must-not-render");
    expect(runParams.prompt).not.toContain("/tmp/test-data-root");
  });

  it("resolves curator models with classifier-style inheritance", () => {
    const api = {
      config: {
        agents: {
          defaults: { model: { primary: "anthropic/agent-primary" } },
        },
      },
    } as unknown as OpenClawPluginApi;
    const currentRun = {
      modelProviderId: "openai",
      modelId: "session-model",
    };

    expect(
      getCurationModelRef(
        api,
        "main",
        resolveConfig({ model: "google/top-level" }),
        currentRun,
      ),
    ).toEqual({ provider: "google", model: "top-level" });
    expect(
      getCurationModelRef(
        api,
        "main",
        resolveConfig({ curation: { modelFallback: "bifrost/fallback" } }),
        currentRun,
      ),
    ).toEqual({ provider: "openai", model: "session-model" });
    expect(
      getCurationModelRef(
        api,
        "main",
        resolveConfig({ curation: { modelFallback: "bifrost/fallback" } }),
        {},
      ),
    ).toEqual({ provider: "anthropic", model: "agent-primary" });
    expect(
      getCurationModelRef(
        { config: {} } as OpenClawPluginApi,
        "main",
        resolveConfig({ curation: { modelFallback: "bifrost/fallback" } }),
        {},
      ),
    ).toEqual({ provider: "bifrost", model: "fallback" });
    expect(
      getCurationModelRef(
        { config: {} } as OpenClawPluginApi,
        "main",
        resolveConfig({ modelFallback: "google/top-fallback" }),
        {},
      ),
    ).toEqual({ provider: "google", model: "top-fallback" });
  });

  it("fails open without invoking or accepting invalid embedded results", async () => {
    const runEmbeddedAgent = vi.fn();
    const base = {
      api: {
        config: {},
        runtime: { agent: { runEmbeddedAgent } },
      } as unknown as OpenClawPluginApi,
      agentId: "main",
      dataRoot: "/tmp/test-data-root",
      curation,
      conversation: [],
      candidates: [],
      experienceIdentities: [],
    };

    await expect(
      runCurationSubagent({
        ...base,
        config: resolveConfig({ curation: { enabled: false } }),
      }),
    ).resolves.toBeUndefined();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();

    runEmbeddedAgent.mockResolvedValueOnce({
      payloads: [{ isError: true, text: "model failed" }],
    });
    await expect(
      runCurationSubagent({
        ...base,
        config: resolveConfig({ model: "google/curator" }),
      }),
    ).resolves.toBeUndefined();

    runEmbeddedAgent.mockRejectedValueOnce(new Error("transport failed"));
    await expect(
      runCurationSubagent({
        ...base,
        config: resolveConfig({ model: "google/curator" }),
      }),
    ).resolves.toBeUndefined();

    runEmbeddedAgent.mockResolvedValueOnce({
      payloads: [{ text: proposal({ candidates: ["Skill", " skill "] }) }],
    });
    await expect(
      runCurationSubagent({
        ...base,
        config: resolveConfig({ model: "google/curator" }),
      }),
    ).resolves.toBeUndefined();

    runEmbeddedAgent.mockResolvedValueOnce({
      payloads: [{ text: `${" ".repeat(4_001)}${proposal()}` }],
    });
    await expect(
      runCurationSubagent({
        ...base,
        config: resolveConfig({ model: "google/curator" }),
      }),
    ).resolves.toBeUndefined();
  });

  it("constructs all three real embedded tools for the tracked agent and executes its visible overlay", async () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "curation-composition-"),
    );
    const stateDir = path.join(temporaryRoot, "state");
    const dataRoot = path.join(stateDir, "plugins", "skill-harness");
    const trackedWorkspace = path.join(temporaryRoot, "tracked-workspace");
    const otherWorkspace = path.join(temporaryRoot, "other-workspace");
    fs.mkdirSync(path.join(trackedWorkspace, "skills", "react"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(trackedWorkspace, "skills", "react", "SKILL.md"),
      "---\nname: react\ndescription: React patterns.\n---\n\n# React\n",
    );
    fs.mkdirSync(path.join(otherWorkspace, "skills", "vue"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(otherWorkspace, "skills", "vue", "SKILL.md"),
      "---\nname: vue\ndescription: Vue patterns.\n---\n\n# Vue\n",
    );
    fs.mkdirSync(path.join(dataRoot, "experiences", "react"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dataRoot, "experiences", "react", "forms.md"),
      "---\nskill: react\nsummary: Form handling.\nkeywords: [forms]\n---\nUse controlled forms.\n",
    );
    fs.mkdirSync(path.join(dataRoot, "experiences", "vue"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dataRoot, "experiences", "vue", "signals.md"),
      "---\nskill: vue\nsummary: Signal handling.\nkeywords: [signals]\n---\nUse explicit signals.\n",
    );

    const registerTool = vi.fn();
    const runEmbeddedAgent = vi.fn(async (runParams: { agentId: string }) => {
      const tools = new Map<string, unknown>();
      for (const [registeredTool] of registerTool.mock.calls) {
        const resolved =
          typeof registeredTool === "function"
            ? registeredTool({ agentId: runParams.agentId })
            : registeredTool;
        for (const tool of Array.isArray(resolved) ? resolved : [resolved]) {
          if (tool && typeof tool === "object" && "name" in tool) {
            tools.set(String(tool.name), tool);
          }
        }
      }
      expect(
        ["skill_search", "skill_view", "skill_experience"].every((name) =>
          tools.has(name),
        ),
      ).toBe(true);
      const experienceTool = tools.get("skill_experience") as {
        execute: (
          id: string,
          params: unknown,
        ) => Promise<{ content: Array<{ text: string }> }>;
      };
      const result = await experienceTool.execute("curator-tool-call", {
        skills: ["react", "vue"],
      });
      expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({
        success: true,
        unavailable_skills: ["vue"],
        entries: [
          expect.objectContaining({
            identity: "react/forms",
            body: expect.stringContaining("Use controlled forms."),
          }),
        ],
      });
      return { payloads: [{ text: proposal() }] };
    });
    const api = {
      config: {},
      registerTool,
      runtime: {
        state: { resolveStateDir: () => stateDir },
        agent: {
          resolveAgentWorkspaceDir: (_config: unknown, agentId: string) =>
            agentId === "tracked-agent" ? trackedWorkspace : otherWorkspace,
          runEmbeddedAgent,
        },
      },
    } as unknown as OpenClawPluginApi;
    registerSkillTools(api, {
      experienceCatalog: SkillExperienceCatalog.create(dataRoot),
    });

    await expect(
      runCurationSubagent({
        api,
        config: resolveConfig({ model: "google/curator" }),
        agentId: "tracked-agent",
        dataRoot,
        curation,
        conversation: [],
        candidates: [],
        experienceIdentities: [],
      }),
    ).resolves.toMatchObject({ topicEpoch: 3, expectedRevision: 7 });
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "tracked-agent" }),
    );
  });
});
