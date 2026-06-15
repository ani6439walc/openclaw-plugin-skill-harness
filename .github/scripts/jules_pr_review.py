#!/usr/bin/env python3
import json
import os
import time
import urllib.error
import urllib.request

JULES_API = "https://jules.googleapis.com/v1alpha"
GITHUB_API = "https://api.github.com"

FINAL_STATES = {"COMPLETED", "FAILED", "PAUSED", "AWAITING_USER_FEEDBACK", "AWAITING_PLAN_APPROVAL"}
MAX_DIFF_CHARS = 180_000
MAX_COMMENT_CHARS = 60_000
POLL_SECONDS = 10
MAX_POLLS = 150


def request(method, url, headers=None, body=None):
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers=headers or {},
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            content_type = resp.headers.get("content-type", "")
            text = raw.decode("utf-8", errors="replace")
            if "application/json" in content_type:
                return json.loads(text) if text else {}
            return text
    except urllib.error.HTTPError as exc:
        msg = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} failed: {exc.code} {msg}") from exc


def github_headers(accept="application/vnd.github+json"):
    return {
        "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
        "Accept": accept,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jules-pr-review-action",
    }


def jules_headers():
    return {
        "X-Goog-Api-Key": os.environ["JULES_API_KEY"],
        "Content-Type": "application/json",
        "User-Agent": "jules-pr-review-action",
    }


def get_pr_diff(owner, repo, pr_number):
    url = f"{GITHUB_API}/repos/{owner}/{repo}/pulls/{pr_number}"
    return request("GET", url, github_headers("application/vnd.github.v3.diff"))


def create_jules_session(owner, repo, diff_text):
    pr_number = os.environ["PR_NUMBER"]
    title = os.environ.get("PR_TITLE", "")
    base_ref = os.environ["BASE_REF"]
    head_sha = os.environ["HEAD_SHA"]
    pr_url = os.environ["PR_URL"]

    truncated = len(diff_text) > MAX_DIFF_CHARS
    diff_for_prompt = diff_text[:MAX_DIFF_CHARS]

    prompt = f"""You are reviewing a GitHub pull request.

Repository: {owner}/{repo}
PR: #{pr_number}
PR URL: {pr_url}
Title: {title}
Base branch: {base_ref}
Head SHA: {head_sha}

Task:
- Perform a code review of the PR diff below.
- Do not modify files.
- Do not create a pull request.
- Focus on correctness, security, regressions, tests, maintainability, and backwards compatibility.
- Return a Markdown review suitable for posting as a GitHub PR comment.
- Use these sections:
  1. Summary
  2. Blocking issues
  3. Non-blocking suggestions
  4. Tests / verification concerns
  5. Overall recommendation
- If there are no issues, say so clearly.
- If the diff is insufficient, state what context is missing.

Diff truncated: {truncated}

```diff
{diff_for_prompt}
```
"""

    payload = {
        "prompt": prompt,
        "title": f"Review PR #{pr_number}: {title}"[:120],
        "sourceContext": {
            "source": f"sources/github/{owner}/{repo}",
            "githubRepoContext": {
                "startingBranch": base_ref,
            },
        },
        "requirePlanApproval": False,
    }

    return request("POST", f"{JULES_API}/sessions", jules_headers(), payload)


def get_jules_session(session_name):
    return request("GET", f"{JULES_API}/{session_name}", jules_headers())


def get_jules_activities(session_name):
    return request("GET", f"{JULES_API}/{session_name}/activities", jules_headers())


def extract_review_from_activities(activities_response):
    activities = activities_response.get("activities", [])
    messages = []

    for activity in activities:
        agent = activity.get("agentMessaged") or {}
        text = agent.get("agentMessage")
        if text:
            messages.append(text.strip())

    if not messages:
        return "Jules finished, but no review message was found in session activities."

    return messages[-1]


def post_pr_comment(owner, repo, pr_number, body):
    marker = "<!-- jules-pr-review -->"
    body = body.strip()
    if len(body) > MAX_COMMENT_CHARS:
        body = body[:MAX_COMMENT_CHARS] + "\n\n_Review truncated because it exceeded GitHub comment size limits._"

    comment = f"""{marker}
## Jules PR Review

{body}

---
_Reviewed by Jules via GitHub Actions._
"""

    url = f"{GITHUB_API}/repos/{owner}/{repo}/issues/{pr_number}/comments"
    return request("POST", url, github_headers(), {"body": comment})


def fail_pr_comment(owner, repo, pr_number, message):
    body = f"""<!-- jules-pr-review -->
## Jules PR Review failed

{message}

---
_The Jules review workflow could not complete._
"""
    url = f"{GITHUB_API}/repos/{owner}/{repo}/issues/{pr_number}/comments"
    request("POST", url, github_headers(), {"body": body})


def main():
    owner, repo = os.environ["GITHUB_REPOSITORY"].split("/", 1)
    pr_number = os.environ["PR_NUMBER"]

    diff_text = get_pr_diff(owner, repo, pr_number)
    if not diff_text.strip():
        post_pr_comment(owner, repo, pr_number, "No diff was found for this pull request.")
        return

    session = create_jules_session(owner, repo, diff_text)
    session_name = session["name"]
    session_url = session.get("url", "")

    final_session = session
    for _ in range(MAX_POLLS):
        time.sleep(POLL_SECONDS)
        final_session = get_jules_session(session_name)
        state = final_session.get("state")
        if state in FINAL_STATES:
            break
    else:
        fail_pr_comment(owner, repo, pr_number, f"Timed out waiting for Jules session.\n\nSession: {session_url}")
        raise SystemExit(1)

    state = final_session.get("state")
    activities = get_jules_activities(session_name)

    if state != "COMPLETED":
        reason = json.dumps(final_session, indent=2, ensure_ascii=False)
        fail_pr_comment(
            owner,
            repo,
            pr_number,
            f"Jules session ended with state `{state}`.\n\nSession: {session_url}\n\n```json\n{reason[:4000]}\n```",
        )
        raise SystemExit(1)

    review = extract_review_from_activities(activities)
    if session_url:
        review += f"\n\nJules session: {session_url}"

    post_pr_comment(owner, repo, pr_number, review)


if __name__ == "__main__":
    main()
