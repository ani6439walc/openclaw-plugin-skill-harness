---
id: DATA_ANALYSIS
name: Data Analysis & Visualization（數據分析與視覺化）
enabled: true
triggers:
  - "User wants to analyze, visualize, or derive insights from structured or semi-structured data — not just look up a single value"
  - "User asks about SQL queries, spreadsheets, dashboards, BI reports, notebook analysis, or chart generation from data"
  - "User wants to compare metrics across time periods, groups, segments, cohorts, or experiments (before/after, A/B, funnel, retention)"
  - "User asks for statistical interpretation: significance, correlation, trends, anomalies, distributions, or regression"
  - "User mentions data tools or formats: CSV, JSON data, pandas, matplotlib, Excel, Google Sheets, SQL, BigQuery, Metabase, Grafana"
  - "User's question would benefit from the data-analysis methodology: metric contracts, decision-oriented analysis, robustness checks, or uncertainty quantification"
examples:
  - "幫我分析一下這個 CSV 的銷售趨勢，畫個圖"
  - "這兩個月的 API latency 差多少？有統計顯著嗎？"
  - "跑一下 BigQuery 看這個 cohort 的 retention"
  - "這份 Excel 報表的數據幫我整理成視覺化圖表"
  - "幫我看看這段 pandas code 的分析邏輯對不對"
  - "A/B test 的 conversion rate，哪一組贏了？"
  - "這個 funnel drop 最嚴重的是哪一層？"
  - "幫我從這個 JSON 匯出一個 summary 圖"
---

Detected "data analysis" intent. The user wants to analyze, visualize, or derive insights from structured data to support a decision.

## Guidelines

- Start from the decision, not the dataset: clarify what question this analysis answers.
- Define the metric contract before computing: entity, grain, numerator, denominator, time window, filters.
- Separate extraction, transformation, and interpretation — don't hide assumptions inside queries or code.
- Quantify uncertainty: ranges, confidence intervals, not just point estimates.
- If sample size is weak or data quality is poor, say so instead of producing false confidence.
- Choose visuals to answer a specific question (trend, comparison, distribution, relationship), not for decoration.

## Response Strategy

- Reformulate vague requests into a concrete analytical question before touching data.
- Run queries or scripts, capture output, then interpret — don't narrate every step.
- Lead with the insight, not the methodology.
- State limitations and recommend what would strengthen the conclusion.

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
- For live dashboard data requiring browser login, route instead:
  (delegate to id=browser via BROWSER_AUTOMATION)
