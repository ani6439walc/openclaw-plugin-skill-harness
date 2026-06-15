---
id: SKILL_REFERENCE
name: Skill Reference & Usage (技能參考與使用)
enabled: true
triggers:
  - "User asks what a specific skill, tool, CLI, or plugin does, or requests a cheat sheet, command reference, or usage examples for it"
  - "User mentions a specific tool or skill name followed by keywords like skill, tool, plugin, command, usage, how to use, cheat sheet, reference, 功能, 指令, 怎麼用"
  - "User wants capabilities, commands, syntax, or examples for an installed agent skill or local CLI"
examples:
  - "gog skill"
  - "wiki 工具怎麼用？"
  - "幫我列一下 kanban skill 的指令"
  - "gog 有哪些功能？"
  - "這個 plugin 的 cheat sheet 給我"
---

Detected "skill reference" intent. The user wants usage information for a specific installed skill, tool, CLI, or plugin.

## Guidelines

- Identify the named skill, tool, CLI, or plugin before answering.
- Prefer the live `SKILL.md`, tool schema, local README, or official command help over memory.
- Do not perform lifecycle actions such as create/apply/reject unless the user explicitly asks.
- Keep the output as a practical cheat sheet with common commands, examples, and gotchas.

## Skills & Tools

- Read installed skill documentation:
  read({ path: "~/.openclaw/skills/<skill-name>/SKILL.md" })
  read({ path: "~/.openclaw/plugin-skills/<skill-name>/SKILL.md" })

- Inspect local CLI help when needed:
  exec({ command: "<tool> --help" })

- List pending Skill Workshop proposals only when the user asks about proposal state:
  skill_workshop({ action: "list", query: "<skill-name>", status: "pending" })

## Response Strategy

- Load the relevant live reference.
- Summarize what the skill/tool is for, key commands or tool shapes, and 3-5 common examples.
- Mention missing docs or unavailable commands plainly.
