import { Type } from "typebox";
import type { OpenClawPluginApi } from "../../api.js";
import { listAvailableSkills } from "./indexer.js";
import { readAvailableSkill } from "./files.js";
import { manageSkill } from "./manage.js";

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

function booleanParam(params: unknown, key: string): boolean {
  if (!params || typeof params !== "object") return false;
  return (params as Record<string, unknown>)[key] === true;
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

  api.registerTool({
    name: "skill_manage",
    label: "Manage Skills",
    description:
      "Create, edit, patch, delete, and manage support files for OpenClaw skills. This is a required write-capable tool; validate names and paths before mutating skill files.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("patch"),
        Type.Literal("edit"),
        Type.Literal("delete"),
        Type.Literal("write_file"),
        Type.Literal("remove_file"),
      ]),
      name: Type.String({
        description:
          "Skill name. Use lowercase letters, numbers, dots, underscores, and hyphens; max 64 characters.",
      }),
      content: Type.Optional(
        Type.String({
          description:
            "Full SKILL.md content with YAML frontmatter. Required for create/edit.",
        }),
      ),
      old_string: Type.Optional(
        Type.String({
          description:
            "Text to find for patch. Must be unique unless replace_all is true.",
        }),
      ),
      new_string: Type.Optional(
        Type.String({
          description:
            "Replacement text for patch. Can be an empty string to delete matched text.",
        }),
      ),
      replace_all: Type.Optional(
        Type.Boolean({
          description:
            "For patch: replace every occurrence instead of one unique match.",
        }),
      ),
      category: Type.Optional(
        Type.String({
          description:
            "Optional single-directory category for create. Creates stateDir/skills/<category>/<name>.",
        }),
      ),
      file_path: Type.Optional(
        Type.String({
          description:
            "Support file path for patch/write_file/remove_file. Must be under references/, templates/, scripts/, assets/, or examples/.",
        }),
      ),
      file_content: Type.Optional(
        Type.String({ description: "Content for write_file." }),
      ),
      absorbed_into: Type.Optional(
        Type.String({
          description:
            "For delete: umbrella skill name when merged, or empty string when deleting with no forwarding target.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      return jsonToolResult(
        await manageSkill({
          api,
          agentId: defaultAgentId(),
          action: requiredStringParam(params, "action"),
          name: requiredStringParam(params, "name"),
          content: optionalStringParam(params, "content"),
          oldString: optionalStringParam(params, "old_string"),
          newString: optionalStringParam(params, "new_string"),
          replaceAll: booleanParam(params, "replace_all"),
          category: optionalStringParam(params, "category"),
          filePath: optionalStringParam(params, "file_path"),
          fileContent: optionalStringParam(params, "file_content"),
          absorbedInto: optionalStringParam(params, "absorbed_into"),
        }),
      );
    },
  });
}
