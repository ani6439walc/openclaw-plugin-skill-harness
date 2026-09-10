import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OpenClawPluginApi } from "../api.js";
import { createPlugin } from "./plugin.js";

interface InvokeOptions {
  readonly apiConfig?: Record<string, unknown>;
  readonly pluginConfig?: Record<string, unknown>;
  readonly runtimeConfig?: Record<string, unknown>;
}

describe("createPlugin working-set prompt integration", () => {
  let stateDir: string;
  let originalConfigPath: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-working-set-"));
    originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  });

  afterEach(() => {
    if (originalConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function writeSkill(name: string): void {
    const skillDir = path.join(stateDir, "skills", name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${name}\ndescription: Fixture skill.\n---\n`,
      "utf8",
    );
  }

  function writeOpenClawConfig(value: unknown): void {
    const configPath = path.join(stateDir, "isolated-openclaw.json");
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    fs.writeFileSync(configPath, JSON.stringify(value), "utf8");
  }

  async function invoke(options: InvokeOptions = {}): Promise<string> {
    const on = vi.fn();
    const api = {
      config: options.apiConfig ?? {},
      pluginConfig: options.pluginConfig ?? {},
      runtime: {
        agent: {
          resolveAgentWorkspaceDir: () => path.join(stateDir, "workspace"),
        },
        config: { current: () => options.runtimeConfig ?? {} },
        state: { resolveStateDir: () => stateDir },
      },
      on,
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    } as unknown as OpenClawPluginApi;
    createPlugin(api).register(api);
    const registration = on.mock.calls.find(
      ([eventName]) => eventName === "before_prompt_build",
    );
    const handler = registration?.[1];
    if (typeof handler !== "function") {
      throw new TypeError("before_prompt_build handler was not registered");
    }
    const result = await handler(
      {
        prompt: "inspect configured context",
        messages: [{ role: "user", content: "inspect configured context" }],
      },
      {
        trigger: "user",
        agentId: "main",
        sessionId: "static-config-session",
        sessionKey: "agent:main:static-config-session",
      },
    );
    return result?.appendSystemContext ?? "";
  }

  it("ignores persisted working-set skills when every SDK projection omits the field", async () => {
    writeSkill("static-known");
    writeOpenClawConfig({
      agents: {
        defaults: { skills: ["native-default-must-not-load"] },
        entries: { main: { skills: ["native-main-must-not-load"] } },
      },
      plugins: {
        entries: {
          "skill-harness": {
            config: {
              workingSetSkills: { agents: { main: ["static-known"] } },
            },
          },
        },
      },
    });

    const context = await invoke({
      pluginConfig: { scope: { agents: ["main"] } },
    });

    expect(context).not.toContain("<working_set_skills>");
    expect(context).not.toContain('<skill name="static-known">');
    expect(context).not.toContain("native-default-must-not-load");
    expect(context).not.toContain("native-main-must-not-load");
  });

  it("injects registration working-set skills when live plugin config is partial", async () => {
    writeSkill("static-known");
    const context = await invoke({
      apiConfig: {
        plugins: {
          entries: {
            "skill-harness": {
              config: {
                workingSetSkills: {
                  agents: { main: ["static-known"] },
                },
              },
            },
          },
        },
      },
      pluginConfig: { scope: { agents: ["other"] } },
      runtimeConfig: {
        plugins: {
          entries: {
            "skill-harness": { config: { scope: { agents: ["other"] } } },
          },
        },
      },
    });

    expect(context).toContain("### Working set skills");
    expect(context).toContain("<working_set_skills>");
    expect(context).toContain('<skill name="static-known">');
    expect(context).not.toContain("<available_skills>");
  });

  it("injects a working-set skill resolved from live runtime skill roots", async () => {
    const extraSkillsDir = path.join(stateDir, "runtime-extra-skills");
    const skillDir = path.join(extraSkillsDir, "runtime-root-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: runtime-root-skill\ndescription: Runtime root fixture.\n---\n",
      "utf8",
    );

    const context = await invoke({
      runtimeConfig: {
        agents: { defaults: { skills: [] }, entries: { main: { skills: [] } } },
        skills: { load: { extraDirs: [extraSkillsDir] } },
        plugins: {
          entries: {
            "skill-harness": {
              config: {
                workingSetSkills: {
                  agents: { main: ["runtime-root-skill"] },
                },
              },
            },
          },
        },
      },
    });

    expect(context).toContain("### Working set skills");
    expect(context).toContain("<working_set_skills>");
    expect(context).toContain('<skill name="runtime-root-skill">');
    expect(context).not.toContain("<available_skills>");
  });

  it("filters a nonexistent working-set skill from live runtime skill roots", async () => {
    const context = await invoke({
      runtimeConfig: {
        agents: { defaults: { skills: [] }, entries: { main: { skills: [] } } },
        skills: { load: { extraDirs: [path.join(stateDir, "missing-root")] } },
        plugins: {
          entries: {
            "skill-harness": {
              config: {
                workingSetSkills: {
                  agents: { main: ["nonexistent-working-set-skill"] },
                },
              },
            },
          },
        },
      },
    });

    expect(context).not.toContain("### Working set skills");
    expect(context).not.toContain("<working_set_skills>");
    expect(context).not.toContain('<skill name="');
  });

  it("keeps live SDK working-set precedence over registration config", async () => {
    writeSkill("registration-skill");
    writeSkill("runtime-skill");
    const context = await invoke({
      apiConfig: {
        plugins: {
          entries: {
            "skill-harness": {
              config: {
                workingSetSkills: {
                  agents: { main: ["registration-skill"] },
                },
              },
            },
          },
        },
      },
      runtimeConfig: {
        plugins: {
          entries: {
            "skill-harness": {
              config: {
                workingSetSkills: { agents: { main: ["runtime-skill"] } },
              },
            },
          },
        },
      },
    });

    expect(context).toContain('<skill name="runtime-skill">');
    expect(context).not.toContain("registration-skill");
  });

  it.each([
    ["missing", undefined],
    ["malformed", "{ malformed"],
  ])(
    "injects live SDK working-set skills when the configured path is %s",
    async (_case, contents) => {
      const configPath = path.join(stateDir, "isolated-openclaw.json");
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      if (contents !== undefined) {
        fs.writeFileSync(configPath, contents, "utf8");
      }
      writeSkill("runtime-skill");

      const context = await invoke({
        runtimeConfig: {
          plugins: {
            entries: {
              "skill-harness": {
                config: {
                  workingSetSkills: { agents: { main: ["runtime-skill"] } },
                },
              },
            },
          },
        },
      });

      expect(context).toContain("<working_set_skills>");
      expect(context).toContain('<skill name="runtime-skill">');
    },
  );

  it("suppresses workspace skills when workingSetSkills.includeWorkspaceSkills is false", async () => {
    const workspaceSkillDir = path.join(
      stateDir,
      "workspace",
      "skills",
      "workspace-skill",
    );
    fs.mkdirSync(workspaceSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceSkillDir, "SKILL.md"),
      "---\nname: workspace-skill\ndescription: Workspace fixture.\n---\n",
      "utf8",
    );

    const contextWithAutoLoad = await invoke();
    expect(contextWithAutoLoad).toContain('<skill name="workspace-skill">');

    const contextWithoutAutoLoad = await invoke({
      runtimeConfig: {
        plugins: {
          entries: {
            "skill-harness": {
              config: {
                workingSetSkills: { includeWorkspaceSkills: false },
              },
            },
          },
        },
      },
    });
    expect(contextWithoutAutoLoad).not.toContain("workspace-skill");
  });

  it("suppresses agent workshop skills when workingSetSkills.includeWorkshopSkills is false", async () => {
    const workshopSkillDir = path.join(
      stateDir,
      "agents",
      "main",
      "agent",
      "workshop-skills",
      "agent-workshop-skill",
    );
    fs.mkdirSync(workshopSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(workshopSkillDir, "SKILL.md"),
      "---\nname: agent-workshop-skill\ndescription: Workshop fixture.\n---\n",
      "utf8",
    );

    const contextWithAutoLoad = await invoke();
    expect(contextWithAutoLoad).toContain(
      '<skill name="agent-workshop-skill">',
    );

    const contextWithoutAutoLoad = await invoke({
      runtimeConfig: {
        plugins: {
          entries: {
            "skill-harness": {
              config: {
                workingSetSkills: { includeWorkshopSkills: false },
              },
            },
          },
        },
      },
    });
    expect(contextWithoutAutoLoad).not.toContain("agent-workshop-skill");
  });
});
