# Owner JQL filters (jak-pipeline)

Two saved Jira filters for daily board management. Paste the JQL into Jira's "Advanced search", save each as a named filter, and bookmark the resulting URL. Replace `YOUR_PROJECT` with your Jira project key (e.g. `SCRUM`).

---

## 1. Stale-work filter

Shows tickets that have been in any non-terminal state for more than 7 days — a proxy for work that is stuck, forgotten, or needs a nudge.

**JQL:**

```
project = "YOUR_PROJECT" AND status not in (Done, Cancelled) AND updated <= -7d ORDER BY updated ASC
```

**When to consult:** Daily standup, weekly review. Any ticket here for more than two weeks without a PR deserves a triage.

**Configure for your project:** Replace `YOUR_PROJECT` with your Jira project key. Optionally add `AND assignee is not EMPTY` to exclude icebox tickets.

---

## 2. Agent-claimed-work filter

Shows tickets currently being actively worked on by an agent (any ticket in "In Development", "PR Review", or "Merge Queue") sorted by the most recently updated first.

**JQL:**

```
project = "YOUR_PROJECT" AND status in ("In Development", "PR Review", "Merge Queue") ORDER BY updated DESC
```

**When to consult:** Any time you want to see what the pipeline is actively doing. Also the right filter to open when a dev-agent hasn't posted in a while — if a ticket has been in "In Development" for 30+ minutes with no PR opened, check the agent journal.

**Configure for your project:** Replace `YOUR_PROJECT` with your Jira project key. Add `AND assignee = currentUser()` to restrict to your own tickets if multiple people share the board.
