---
id: DATA_ANALYSIS
name: Data Analysis & Visualization（數據分析與視覺化）
enabled: true
triggers:
  - "User wants to analyze, visualize, or derive insights from structured or semi-structured data — comparing metrics across time/groups, computing statistics, or generating charts from CSV, SQL, spreadsheets, or JSON"
  - "User asks about BI reports, dashboards, notebook analysis, or data tools: pandas, matplotlib, Excel, Google Sheets, BigQuery, Metabase, Grafana"
  - "User's question benefits from decision-oriented analysis methodology: metric contracts, robustness checks, or uncertainty quantification"
examples:
  - "幫我分析一下這個 CSV 的銷售趨勢，畫個圖"
  - "這兩個月的 API latency 差多少？有統計顯著嗎？"
  - "跑一下 BigQuery 看這個 cohort 的 retention"
  - "A/B test 的 conversion rate，哪一組贏了？"
  - "這個 funnel drop 最嚴重的是哪一層？"
---

Detected "data analysis" intent. The user wants to analyze, visualize, or derive insights from structured data to support a decision.

## Guidelines

- Start from the decision, not the dataset: clarify what question this analysis answers.
- Define the metric contract before computing: entity, grain, numerator, denominator, time window, filters.
- Separate extraction, transformation, and interpretation — do not hide assumptions inside queries or code.
- Quantify uncertainty: ranges, confidence intervals, not just point estimates.
- If sample size is weak or data quality is poor, say so instead of producing false confidence.
- Choose visuals to answer a specific question (trend, comparison, distribution, relationship), not for decoration.
- Reformulate vague requests into a concrete analytical question before touching data.
- Run queries or scripts, capture output, then interpret — do not narrate every step.
- Lead with the insight, not the methodology.
- State limitations and recommend what would strengthen the conclusion.

## Skills & Tools

- Full data analysis methodology, metric contracts, and decision-oriented output:
  skill: data-analysis

- Run Python data scripts with dependencies (pandas, matplotlib, etc.):
  exec({ command: "uv run --with pandas --with matplotlib python3 <script>" })

- Query a database and capture structured output:
  exec({ command: "<sql_client> --query \"<SQL>\"" })

- Read a CSV, JSON, or spreadsheet file before analyzing:
  read({ path: "<file>" })

- Chart selection guidance and visual anti-patterns:
  read({ path: "<data-analysis-skill-dir>/chart-selection.md" })

- Decision-brief formatting for stakeholder-facing output:
  read({ path: "<data-analysis-skill-dir>/decision-briefs.md" })

## Response Strategy

- Reformulate the request into a concrete analytical question.
- Define the metric contract (entity, grain, numerator, denominator, time window).
- Run queries or scripts to extract and transform data.
- Interpret results with uncertainty quantification.
- Lead with the insight, state limitations, recommend next steps.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5
formulate  define      extract      interpret    present
question   contract    & transform  & quantify   insight
```

### Step 1 — Formulate the Question
- Reformulate vague requests into a concrete analytical question.
- Clarify what decision this analysis supports.

### Step 2 — Define Metric Contract
- Specify: entity, grain, numerator, denominator, time window, filters.
- Separate extraction, transformation, and interpretation concerns.

### Step 3 — Extract & Transform
- Read data files (CSV, JSON, spreadsheets) or run queries.
- Execute Python scripts with `uv run --with` for dependencies.
- Capture structured output for analysis.

### Step 4 — Interpret & Quantify Uncertainty
- Compute statistics, comparisons, or trends.
- Add confidence intervals or ranges — not just point estimates.
- Flag weak sample sizes or poor data quality.

### Step 5 — Present Insight
- Lead with the key finding, not the methodology.
- State limitations clearly.
- Recommend what would strengthen the conclusion.
- Choose visuals that answer the specific question (trend, comparison, distribution, relationship).
