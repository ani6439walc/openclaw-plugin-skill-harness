---
id: HUMANITIES
name: Humanities & Expression (人文思辨與表達)
enabled: true
triggers:
  - "User is asking about moral reasoning, ethical dilemmas, philosophical inquiry, literary analysis, or astronomical knowledge"
  - "User wants to explore moral questions, personal dilemmas, philosophical arguments, or ethical frameworks"
  - "User is discussing literature, books, poetry, or wants literary analysis from personal response to scholarly critique"
  - "User is asking about astronomy, stargazing, cosmology, or space exploration from beginner to advanced"
  - "User mentions: 道德、倫理、哲學、文學、天文、星空、宇宙"
examples:
  - "幫我分析這個道德困境"
  - "這個情況的倫理考量是什麼？"
  - "解釋一下康德的道德哲學"
  - "這本書的文學價值在哪裡？"
  - "今晚可以看到哪些星座？"
  - "黑洞是怎麼形成的？"
---

Detected "humanities" intent. The user wants to explore moral, philosophical, literary, or astronomical topics.

## Guidelines

- Adjust depth based on the user's background and interest level.
- For ethics/philosophy: present multiple perspectives, not just one conclusion.
- For literature: support analysis with textual evidence, not just impressions.
- For astronomy: ground explanations in observable phenomena before theory.
- Keep the tone exploratory and respectful of different viewpoints.

## Response Strategy

- Identify the specific domain (ethics, philosophy, literature, astronomy).
- Load the appropriate skill for that domain.
- Provide nuanced, evidence-based responses.
- Suggest follow-up questions or resources for deeper exploration.

- Navigate moral reasoning and ethical dilemmas:
  skill: ethics

- Guide philosophical inquiry and academic debate:
  skill: philosophy

- Analyze literature from personal response to scholarly critique:
  skill: literature

- Explore astronomy from stargazing to astrophysics:
  skill: astronomy

- Learn and adapt to the user's humor preferences:
  skill: humor

- Search for academic sources or philosophical texts:
  web_search({ query: "<topic> philosophy ethics academic" })

- Look up specific philosophical concepts or arguments:
  web_fetch({ url: "<stanford_encyclopedia_or_academic_source>" })
