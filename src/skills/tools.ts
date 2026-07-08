import { Type } from "typebox";
import type { OpenClawPluginApi } from "../../api.js";
import { listAvailableSkills } from "./indexer.js";
import { readAvailableSkill } from "./files.js";

function jsonToolResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    details: undefined,
  };
}

function optionalStringParam(params: unknown, key: string): string | undefined {
  if (!params || typeof params !== "object") return;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function requiredStringParam(params: unknown, key: string): string {
  return optionalStringParam(params, key) ?? "";
}

function defaultAgentId(): string {
  return "main";
}

export function registerSkillTools(api: OpenClawPluginApi): void {
  api.registerTool({
    name: "skill_list",
    label: "List Skills",
    description:
      "List OpenClaw skills visible to the current agent. Returns metadata only; use skill_view to read full SKILL.md content or linked support files.",
    parameters: Type.Object({
      category: Type.Optional(
        Type.String({
          description:
            "Optional best-effort category/source filter, such as workspace, bundled, plugin, references, or a first-level skill folder.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const skills = await listAvailableSkills({
        api,
        agentId: defaultAgentId(),
        category: optionalStringParam(params, "category"),
      });
      return jsonToolResult({
        success: true,
        count: skills.length,
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          source: skill.source,
          category: skill.category,
          path: skill.location,
        })),
      });
    },
  });

  api.registerTool({
    name: "skill_view",
    label: "View Skill",
    description:
      "Read a visible OpenClaw skill's SKILL.md content, or read one of its linked support files under references, templates, scripts, assets, or examples.",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name to read." }),
      file_path: Type.Optional(
        Type.String({
          description:
            "Optional support file path under references/, templates/, scripts/, assets/, or examples/.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      return jsonToolResult(
        await readAvailableSkill({
          api,
          agentId: defaultAgentId(),
          name: requiredStringParam(params, "name"),
          filePath: optionalStringParam(params, "file_path"),
        }),
      );
    },
  });
}
