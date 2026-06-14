---
id: SYSTEM_DIAGNOSTICS
name: System Diagnostics & Debugging（系統診斷與除錯）
enabled: true
triggers:
  - "User is dealing with a hard-to-locate bug, performance regression, or non-deterministic anomaly (intermittent crash, flaky behavior, race condition, memory leak, timeout under load) that needs structured diagnosis — not a simple compile error or one-line fix"
  - "User asks to debug, diagnose, troubleshoot, trace root cause, or bisect; or mentions diagnostic tools: debugger, profiler, strace, perf, core dump, heap dump, flamegraph, git bisect"
  - "User wants to build a reproduction loop or isolation harness before attempting a fix, or has already made multiple failed attempts and needs methodological escalation"
examples:
  - "這個 service 不定時 crash，幫我診斷一下 root cause"
  - "API latency 突然爆增兩倍，幫我排查是哪一段造成的"
  - "memory 一直在漲懷疑 leak，幫我用 profiler 定位"
  - "幫我 git bisect 找出是哪個 commit 引入了這個 bug"
  - "這隻 pod 重啟好幾次了可是 log 看不出來，幫我深入診斷"
---

Detected "system diagnostics" intent. The user has a hard-to-locate bug, performance regression, or system anomaly that needs structured diagnosis.

## Guidelines

- Build a deterministic feedback loop before anything else — the single most important step.
- Reproduce the exact failure the user described before hypothesizing.
- Generate 3-5 ranked, falsifiable hypotheses before testing any; each must predict what change would confirm or rule it out.
- Change one variable at a time when instrumenting. Tag all debug logs with unique prefixes for easy cleanup.
- If no good test seam exists to lock down the bug, flag that architectural gap — do not fake a regression test.
- For non-deterministic bugs, the goal is to raise the reproduction rate until debuggable, not to find a clean repro.
- After the fix: re-run the original repro, remove all debug instrumentation, and recommend architectural improvements if the bug revealed a missing test seam.

## Skills & Tools

- Full structured diagnosis methodology (feedback loop → reproduce → hypothesise → instrument → fix → regression-test):
  skill: diagnose

- Run system health checks across workspace, config, and integrations:
  skill: analysis

- Optimize application performance after profiling reveals bottlenecks:
  skill: performance-optimization

- Harden code against vulnerabilities discovered during diagnosis:
  skill: security-and-hardening

- Trace and analyze codebase structure before diving into unknown code:
  skill: dev-lifecycle
  skill: cx

- Generate a document outline to verify file structure, detect misplaced sections, or confirm content ordering during diagnostic inspection:
  exec({ command: "treemd <file_path>" })

- Inspect relevant ADRs or project docs for architectural context around the bug area:
  wiki_search({ query: "<module_or_bug_area_keywords>" })

- Look up version-specific open-source library docs, API references, or framework behavior:
  context7__query-docs({ libraryId: "<resolved_library_id>", query: "<specific_question>" })

- Ask targeted questions about a GitHub repository's internals, architecture, or known issues:
  deepwiki__ask_question({ repoName: "<owner/repo>", question: "<specific_question>" })

- Search for current external information, changelogs, upstream issues, or related bug reports:
  web_search({ query: "<error_message_or_symptom_keywords>" })

- Run a targeted test or harness to reproduce the failure:
  exec({ command: "<repro_command>" })

- Capture live system state during diagnosis (processes, memory, disk, network):
  exec({ command: "htop -p <pid>" })

- Profile a running process or analyze a core dump / heap dump:
  exec({ command: "perf record -p <pid> --call-graph dwarf -- <duration>" })

- Bisect git history to locate the commit that introduced the regression:
  exec({ command: "git bisect start && git bisect bad <HEAD> && git bisect good <known_good>" })

- Clean all temporary debug instrumentation after the fix:
  exec({ command: "grep -r '\\[DEBUG-' <codebase> && echo 'Remove the tagged lines above'" })

## Response Strategy

- Lead with the feedback loop design before diving into code.
- Generate ranked hypotheses; test them one at a time.
- State which hypothesis turned out correct in any fix summary.
- After the fix: re-run the original repro, remove debug instrumentation, recommend architectural improvements.

## Concrete Workflow

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5 → Step 6
feedback   reproduce   hypothesise  instrument   fix        clean up
loop                                    & test
```

### Step 1 — Build Feedback Loop
- Design a deterministic feedback loop to observe the failure.
- This is the single most important step — do not skip.
- Instrument the system to capture the exact failure mode.

### Step 2 — Reproduce the Failure
- Reproduce the exact failure the user described.
- For non-deterministic bugs: raise the reproduction rate until debuggable.
- Capture logs, stack traces, and system state at failure time.

### Step 3 — Generate Hypotheses
- Generate 3-5 ranked, falsifiable hypotheses.
- Each hypothesis must predict what change would confirm or rule it out.
- Rank by likelihood and test effort.

### Step 4 — Instrument & Test
- Change one variable at a time when instrumenting.
- Tag all debug logs with unique prefixes for easy cleanup.
- Run targeted tests or harnesses to confirm/rule out each hypothesis.
- Use profiling tools (`perf`, `htop`) for performance regressions.

### Step 5 — Fix & Regression-Test
- Apply the minimal fix for the confirmed hypothesis.
- Re-run the original reproduction to verify the fix.
- Run regression tests to ensure no side effects.
- State which hypothesis was correct in the fix summary.

### Step 6 — Clean Up
- Remove all temporary debug instrumentation.
- Use `grep -r '\[DEBUG-' <codebase>` to find tagged lines.
- Recommend architectural improvements if the bug revealed a missing test seam.
