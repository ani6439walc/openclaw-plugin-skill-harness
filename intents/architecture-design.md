---
id: ARCHITECTURE_DESIGN
name: Architecture Design & Diagramming（架構設計與圖表）
enabled: true
triggers:
  - "User wants to design, diagram, or visualize system architecture: services, components, data flows, network topology, deployment layout"
  - "User asks to draw or generate diagrams: architecture diagram, C4 model, UML, flowchart, sequence diagram, topology map, CI/CD pipeline"
  - "User is discussing architectural decisions: service boundaries, integration patterns, trade-offs, component decomposition"
  - "User wants to document or communicate system structure visually to stakeholders or teammates"
  - "User mentions diagram types or tools: architecture diagram, 架構圖, C4, UML, flowchart, topology, system design"
examples:
  - "幫我畫 microservice 架構圖"
  - "GCP 雲端架構幫我畫成圖"
  - "CI/CD pipeline diagram"
  - "這三個服務要怎麼切比較好？"
  - "data pipeline 從 ingest 到 storage 圖解"
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

## Response Strategy

- Lead with a brief textual summary of the architecture before generating the diagram.
- Generate the diagram, then review: are all components connected correctly? any missing flows?
- Offer to iterate — diagrams usually need 1-2 rounds of refinement.

- Create polished dark-themed architecture diagrams (HTML+SVG, self-contained):
  skill: architecture-diagram
- Build interactive visual canvases, mind maps, or component relationship graphs:
  skill: json-canvas
- Upload generated diagram to Folio for sharing with stakeholders:
  skill: folio
- Inspect codebase structure for existing architectural context before designing:
  skill: cx
- Look up existing architectural decisions, ADRs, or system notes:
  wiki_search({ query: "<component_or_concern_keywords>" })
- Search for architectural patterns, best practices, or reference implementations:
  web_search({ query: "<pattern_or_tool keywords>" })
