---
id: ARCHITECTURE_DESIGN
name: Architecture Design & Diagramming（架構設計與圖表）
enabled: true
triggers:
  - "User wants to design, diagram, or visualize system architecture and structural decisions — including services, data flows, network topology, service boundaries, integration patterns, or component decomposition"
  - "User asks to generate diagrams (architecture, C4, UML, flowchart, sequence, CI/CD pipeline, topology) or mentions diagram keywords: 架構圖, topology, system design"
  - "User wants to document or communicate system structure visually for stakeholders or team alignment"
examples:
  - "幫我畫 microservice 架構圖"
  - "CI/CD pipeline diagram"
  - "這三個服務要怎麼切比較好？"
  - "K8s cluster 拓撲圖"
  - "API gateway → backend → DB 的 flow 幫我畫出來"
  - "這個系統的架構圖幫我生成，我要拿去簡報"
---

Detected "architecture design" intent. The user wants to design, diagram, or visualize system architecture.

## Guidelines

- Clarify the scope and target audience before diagramming (internal doc vs stakeholder pitch).
- Keep diagrams focused: one diagram per concern unless tightly coupled.
- Use consistent conventions: direction (top-down vs left-right), naming, grouping.
- Label components clearly; avoid cryptic abbreviations without a legend.
- Prefer the `architecture-diagram` skill for polished output over ad-hoc ASCII art.
- Lead with a brief textual summary of the architecture before generating the diagram.
- After generating, review: are all components connected correctly? Any missing flows?
- Offer to iterate — diagrams usually need 1-2 rounds of refinement.

## Skills & Tools

- Create polished dark-themed architecture diagrams (HTML+SVG, self-contained):
  skill: architecture-diagram

- Design stable APIs and module boundaries:
  skill: api-and-interface-design

- Find deepening opportunities and refactoring targets:
  skill: improve-codebase-architecture

- Build interactive visual canvases, mind maps, or component relationship graphs:
  skill: json-canvas

- Upload generated diagram to Folio for sharing with stakeholders:
  skill: folio

- Inspect codebase structure for existing architectural context:
  skill: using-agent-skills
  skill: cx

- Look up existing architectural decisions, ADRs, or system notes:
  wiki_search({ query: "<component_or_concern_keywords>" })

- Search for architectural patterns, best practices, or reference implementations:
  web_search({ query: "<pattern_or_tool_keywords>" })

## Response Strategy

- Clarify scope and audience before starting.
- Inspect the codebase for existing architectural context.
- Search wiki for existing ADRs or system notes on the topic.
- Generate the architecture diagram using the `architecture-diagram` skill.
- Review the output for correctness and completeness.
- Deliver the diagram and offer iteration rounds.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5
clarify    inspect     search       generate     review
scope      codebase    wiki/refs    diagram      & iterate
```

### Step 1 — Clarify Scope
- Determine the target audience (internal team doc vs stakeholder pitch).
- Identify the primary concern to visualize (data flow, topology, sequence, etc.).
- Decide on diagram conventions (direction, naming).

### Step 2 — Inspect Codebase
- Use `cx` to understand existing codebase structure.
- Navigate with `using-agent-skills` to find applicable sub-skills for context.

### Step 3 — Search for Existing Docs
- Search wiki for existing ADRs or architecture notes.
- Search the web for relevant architectural patterns or best practices.

### Step 4 — Generate Diagram
- Use `architecture-diagram` skill to create a polished HTML+SVG diagram.
- Match the diagram type to the concern (C4, flowchart, sequence, topology).

### Step 5 — Review & Iterate
- Verify all components are connected correctly.
- Check for missing flows or unclear labels.
- Offer 1-2 refinement rounds if needed.
- Upload to Folio if sharing with stakeholders is required.
