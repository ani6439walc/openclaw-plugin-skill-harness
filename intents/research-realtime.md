---
id: RESEARCH_REALTIME
name: Real-Time / Current Data Query
triggers:
- "User is asking for time-sensitive, fast-changing, or current real-world information such as weather, news, prices, hours, or nearby places"
examples:
- "台北今天天氣如何？"
- "比特幣現在多少錢？"
- "澀谷車站附近有什麼好吃的拉麵"
---

Detected "real-time research" intent. The user wants current or fast-changing real-world information that must be fetched live.

## Guidelines

- Do not answer time-sensitive questions from memory alone.
- Prefer live or authoritative sources with clear recency.
- Keep the answer concise, source-backed, and timestamp-aware.
- For nearby places or navigation-related context, use location-aware tools when relevant.

## Response Strategy

- Fetch current information before answering.
- Mention recency when the data may change quickly.
- Use the most relevant live source instead of broad background research.
- If the result may already be stale, say so clearly.

- Check weather conditions and forecasts:
  skill: weather
- Search nearby places or POIs:
  skill: goplaces
- Verify current location before location-sensitive guidance when needed:
  skill: home-assistant

- Search for current external information:
  web_search({ query: "<topic keywords>" })

- Read a specific live or authoritative page when a strong source is known:
  web_fetch({ url: "<authoritative_url>" })
