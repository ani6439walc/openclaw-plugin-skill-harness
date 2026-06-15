#!/usr/bin/env python3
import json
import os
import sys
import time
import urllib.error
import urllib.request

JULES_API = "https://jules.googleapis.com/v1alpha"
GITHUB_API = "https://api.github.com"

# States where Jules has produced a review we can extract
REVIEWABLE_STATES = {
    "COMPLETED",
    "AWAITING_USER_FEEDBACK",
    "AWAITING_PLAN_APPROVAL",
    "PAUSED",
}
FINAL_STATES = REVIEWABLE_STATES | {"FAILED"}
MAX_DIFF_CHARS = 180_000
MAX_COMMENT_CHARS = 60_000
POLL_SECONDS = 15
MAX_POLLS = 100  # 25 minutes total


def log(msg):
    print(f"[jules-review] {msg}", flush=True)


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

    prompt = f"""You are reviewing a GitHub pull request. IMPORTANT: This is a review-only task. Do NOT create any plan. Do NOT attempt to modify files. Simply analyze the diff and output your review directly as your response.

Repository: {owner}/{repo}
PR: #{pr_number}
PR URL: {pr_url}
Title: {title}
Base branch: {base_ref}
Head SHA: {head_sha}

Task:
- Perform a code review of the PR diff below.
- Do NOT modify files or create a plan.
- Do NOT create a pull request.
- Output your review directly as your final message.
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


REVIEW_MARKER = "<!-- jules-pr-review -->"


def extract_review_from_activities(activities_response):
    activities = activities_response.get("activities", [])
    messages = []

    for activity in activities:
        agent = activity.get("agentMessaged") or {}
        text = agent.get("agentMessage")
        if text:
            messages.append(text.strip())

    if not messages:
        return None

    return messages[-1]


def has_complete_review(activities_response):
    """Check if activities contain a complete review (has the marker or key sections)."""
    activities = activities_response.get("activities", [])

    for activity in activities:
        agent = activity.get("agentMessaged") or {}
        text = agent.get("agentMessage") or ""

        # Check for review marker
        if REVIEW_MARKER in text:
            return True

        # Check for key review sections (heuristic)
        has_summary = "## summary" in text.lower() or "### summary" in text.lower()
        has_blocking = "blocking" in text.lower() or "## issues" in text.lower()
        has_recommendation = "recommendation" in text.lower() or "## verdict" in text.lower()

        # If it has at least summary + one other section, likely complete
        if has_summary and (has_blocking or has_recommendation):
            return True

    return False


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

    log(f"Fetching diff for PR #{pr_number}...")
    diff_text = get_pr_diff(owner, repo, pr_number)
    if not diff_text.strip():
        log("No diff found, posting comment and exiting.")
        post_pr_comment(owner, repo, pr_number, "No diff was found for this pull request.")
        return

    log(f"Diff size: {len(diff_text)} chars, creating Jules session...")
    session = create_jules_session(owner, repo, diff_text)
    session_name = session["name"]
    session_url = session.get("url", "")
    initial_state = session.get("state", "UNKNOWN")

    log(f"Session created: {session_name}")
    log(f"State: {initial_state}")
    if session_url:
        log(f"URL: {session_url}")

    final_session = session
    state = session.get("state", "UNKNOWN")
    early_exit = False
    for poll_num in range(1, MAX_POLLS + 1):
        time.sleep(POLL_SECONDS)
        final_session = get_jules_session(session_name)
        state = final_session.get("state", "UNKNOWN")

        if poll_num % 4 == 1 or state in FINAL_STATES:
            log(f"Poll {poll_num}/{MAX_POLLS}: state={state}")

        if state in FINAL_STATES:
            log(f"Session reached final state: {state}")
            break

        # Early exit: if IN_PROGRESS and review already complete, don't wait
        if state == "IN_PROGRESS":
            try:
                activities = get_jules_activities(session_name)
                if has_complete_review(activities):
                    log("Review detected in activities during IN_PROGRESS — exiting early")
                    early_exit = True
                    break
            except Exception as e:
                log(f"Could not check activities: {e}")

    if not early_exit and state not in FINAL_STATES:
        log(f"Timed out after {MAX_POLLS * POLL_SECONDS}s")
        fail_pr_comment(owner, repo, pr_number, f"Timed out waiting for Jules session after {MAX_POLLS * POLL_SECONDS // 60} minutes.\n\nLast state: `{final_session.get('state')}`\n\nSession: {session_url}")
        raise SystemExit(1)

    state = final_session.get("state")
    log(f"Fetching activities for session...")
    activities = get_jules_activities(session_name)
    activity_count = len(activities.get("activities", []))
    log(f"Found {activity_count} activities")

    if not early_exit and state not in REVIEWABLE_STATES:
        reason = json.dumps(final_session, indent=2, ensure_ascii=False)
        fail_pr_comment(
            owner,
            repo,
            pr_number,
            f"Jules session ended with non-reviewable state `{state}`.\n\nSession: {session_url}\n\n```json\n{reason[:4000]}\n```",
        )
        raise SystemExit(1)

    review = extract_review_from_activities(activities)
    if review is None:
        review = "Jules completed, but no review message was found in session activities."
    
    if session_url:
        review += f"\n\nJules session: {session_url}"

    log(f"Posting review comment ({len(review)} chars)...")
    post_pr_comment(owner, repo, pr_number, review)
    log("Done!")


if __name__ == "__main__":
    main()
