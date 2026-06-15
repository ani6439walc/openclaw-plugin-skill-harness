---
name: git-push
description: 推送 Git 分支到遠端（含 force push 判斷）
category: git
triggers:
  - push
  - 推送
  - force push
  - 強制推送
  - git push
  - push branch
priority: high
---

# Git Push

推送本地分支到遠端。包含一般 push 和 force push 情境。

## 路由依據

- 使用者提到 push / 推送 → 本 intent
- 使用者提到 force push / 強制推送 → 本 intent（需特別注意安全性）
- 使用者提到 upstream / 設定遠端追蹤 → 本 intent
