#!/usr/bin/env bash
# tick-extension.sh — sourced fragment for coordinator tick.sh.
#
# Exports jak_pipeline_jira_tick_pass() function.
# Does NOT execute on source — no side effects when sourced.
#
# Usage in downstream tick.sh (added by install.sh):
#   . scripts/jak-pipeline/jira/tick-extension.sh
#   jak_pipeline_jira_tick_pass

_TICK_EXT_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

jak_pipeline_jira_tick_pass() {
  local _downstream_root="${DOWNSTREAM_ROOT:-$(pwd)}"
  local _jira_env="${JIRA_ENV_FILE:-${_downstream_root}/.claude/jira/.env}"
  local _retry_queue="${JIRA_RETRY_QUEUE:-${_downstream_root}/agents/_jira-retry.json}"
  local _drift_file="${JIRA_DRIFT_FILE:-${_downstream_root}/agents/_jira-drift.json}"
  local _tick_log="${JAK_TICK_LOG:-${_downstream_root}/agents/_tick-log.md}"
  local _now_epoch
  _now_epoch=$(date +%s 2>/dev/null || echo "0")

  # (a) Drift reconciliation pass
  _DRIFT_FILE="$_drift_file" \
  _TICK_LOG="$_tick_log" \
  _RETRY_QUEUE="$_retry_queue" \
  _NOW_EPOCH="$_now_epoch" \
  _TRANSITION_SCRIPT="${_TICK_EXT_SCRIPT_DIR}/transition.sh" \
  JIRA_ENV_FILE="$_jira_env" \
  DOWNSTREAM_ROOT="$_downstream_root" \
    _jak_jira_drift_pass || true

  # (b) Drain retry queue
  JIRA_ENV_FILE="$_jira_env" \
  JIRA_RETRY_QUEUE="$_retry_queue" \
  DOWNSTREAM_ROOT="$_downstream_root" \
    bash "${_TICK_EXT_SCRIPT_DIR}/drain-retry-queue.sh" 2>/dev/null || true
}

# Drift reconciliation Python script — written to a temp file and executed.
_JAK_DRIFT_PY='
import sys, json, os, re, subprocess, datetime, urllib.request, base64

pr_json_path = os.environ.get("_PR_JSON_FILE", "")
try:
    with open(pr_json_path) as f:
        pr_list = json.load(f)
except Exception:
    pr_list = []

drift_data_str = os.environ.get("_DRIFT_DATA", "{}")
try:
    drift_data = json.loads(drift_data_str)
except Exception:
    drift_data = {}

drift_file = os.environ.get("_DRIFT_FILE", "")
tick_log = os.environ.get("_TICK_LOG", "")
jira_base = os.environ.get("JIRA_BASE_URL", "")
jira_email = os.environ.get("JIRA_EMAIL", "")
jira_token = os.environ.get("JIRA_API_TOKEN", "")
retry_queue = os.environ.get("JIRA_RETRY_QUEUE", "")
transition_script = os.environ.get("_TRANSITION_SCRIPT", "")
downstream_root = os.environ.get("DOWNSTREAM_ROOT", "")
now_epoch = int(os.environ.get("_NOW_EPOCH", "0"))

auth = base64.b64encode(f"{jira_email}:{jira_token}".encode()).decode()
headers = {"Authorization": f"Basic {auth}", "Content-Type": "application/json"}

FORWARD_ORDER = [
    "Idea", "Backlog", "Planning", "Plan Review", "Ready to Dev",
    "In Development", "PR Review", "Merge Queue", "UAT", "Done"
]

def state_index(s):
    try: return FORWARD_ORDER.index(s)
    except ValueError: return -1

# Project key shape — Atlassian-compliant: uppercase letter followed by
# uppercase letters or digits (NO underscores; Atlassian rejects them in
# project keys). Aligned across check-plan.sh step 5.5 +
# lib.sh:extract_ticket_from_branch per issue #67.
BRANCH_RE = re.compile(r"^(?:plan|feat|fix|chore|design|docs|test)/([A-Z][A-Z0-9]*-\d+)-")

def expected_state(pr):
    if pr.get("merged") or pr.get("state") == "MERGED":
        return "Done"
    if pr.get("state") == "CLOSED":
        return "Done"
    if pr.get("state") == "OPEN":
        return "In Development"
    return None

def get_jira_state(ticket):
    try:
        url = f"{jira_base}/rest/api/3/issue/{ticket}"
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
            return data["fields"]["status"]["name"]
    except Exception:
        return None

def append_tick_log(msg):
    if tick_log:
        os.makedirs(os.path.dirname(tick_log) or ".", exist_ok=True)
        with open(tick_log, "a") as f:
            ts = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
            f.write(f"- {ts} JIRA_DRIFT: {msg}\n")

def post_pr_comment(pr_number, body):
    try:
        subprocess.run(
            ["gh", "pr", "comment", str(pr_number), "--body", body],
            capture_output=True, timeout=15
        )
    except Exception:
        pass
    print(body, flush=True)

new_drift = {}

for pr in pr_list:
    branch = pr.get("headRefName", "")
    m = BRANCH_RE.match(branch)
    if not m:
        continue
    ticket = m.group(1)

    exp_state = expected_state(pr)
    if exp_state is None:
        continue

    actual_state = get_jira_state(ticket)
    if actual_state is None:
        continue

    if actual_state == exp_state:
        continue

    exp_idx = state_index(exp_state)
    act_idx = state_index(actual_state)

    if act_idx > exp_idx and act_idx >= 0 and exp_idx >= 0:
        _prn = pr["number"]
        append_tick_log(f"AHEAD ticket={ticket} jira={actual_state} github_expected={exp_state} pr={_prn}")
        comment_body = f"[JAK-PIPELINE JIRA AHEAD] Ticket {ticket} is at *{actual_state}* in Jira but GitHub PR state indicates *{exp_state}*. No auto-correction."
        post_pr_comment(_prn, comment_body)
        continue

    first_seen = drift_data.get(ticket)
    if first_seen is None:
        new_drift[ticket] = datetime.datetime.utcnow().isoformat() + "Z"
        append_tick_log(f"first-observed ticket={ticket} jira={actual_state} expected={exp_state}")
        continue

    try:
        first_seen_epoch = int(datetime.datetime.fromisoformat(first_seen.replace("Z","+00:00")).timestamp())
    except Exception:
        first_seen_epoch = 0

    age_seconds = now_epoch - first_seen_epoch
    if age_seconds < 600:
        new_drift[ticket] = first_seen
        continue

    _prn = pr["number"]
    append_tick_log(f"correcting ticket={ticket} from={actual_state} to={exp_state} age={age_seconds}s pr={_prn}")

    if act_idx < 0 or exp_idx < 0:
        new_drift[ticket] = first_seen
        continue

    walk = FORWARD_ORDER[act_idx:exp_idx+1]
    comment_body = f"[JAK-PIPELINE DRIFT CORRECTION] Ticket {ticket} drifting {age_seconds//60}min. Expected *{exp_state}*, actual *{actual_state}*. Forwarding via {len(walk)-1} step(s)."
    post_pr_comment(pr["number"], comment_body)

    success = True
    for i in range(len(walk) - 1):
        to_s = walk[i + 1]
        project_key = ticket.split("-")[0]
        env = {**os.environ}
        env["JIRA_RETRY_QUEUE"] = retry_queue
        env["DOWNSTREAM_ROOT"] = downstream_root
        result = subprocess.run(
            ["bash", transition_script,
             "--project", project_key,
             "--ticket", ticket,
             "--to", to_s,
             "--reason", "drift-correction"],
            capture_output=True, text=True, env=env, timeout=60
        )
        append_tick_log(f"walk-step ticket={ticket} to={to_s} exit={result.returncode}")
        if "transitioned:" not in result.stdout and "already at target" not in result.stdout:
            success = False

    if not success:
        new_drift[ticket] = first_seen

print(json.dumps(new_drift))
'

_jak_jira_drift_pass() {
  local drift_file="${_DRIFT_FILE:-}"
  local tick_log="${_TICK_LOG:-}"
  local retry_queue="${_RETRY_QUEUE:-}"
  local now_epoch="${_NOW_EPOCH:-0}"
  local transition_script="${_TRANSITION_SCRIPT:-}"
  local jira_env="${JIRA_ENV_FILE:-}"

  # Load Jira credentials from env file
  if [[ -n "$jira_env" ]] && [[ -f "$jira_env" ]]; then
    set +u
    while IFS='=' read -r key value; do
      [[ "$key" =~ ^#.*$ ]] && continue
      [[ -z "$key" ]] && continue
      if [[ -z "${!key:-}" ]]; then export "$key"="$value"; fi
    done < "$jira_env"
    set -u
  fi

  local jira_base="${JIRA_BASE_URL:-}"
  if [[ -z "$jira_base" ]]; then
    return 0
  fi

  # Read open + recently-merged PRs into a temp file
  local pr_tmp
  pr_tmp=$(mktemp /tmp/jak-prs-XXXXXX.json)
  gh pr list --state all --limit 20 \
    --json number,headRefName,state,merged \
    2>/dev/null > "$pr_tmp" || echo '[]' > "$pr_tmp"

  # Load drift state
  local drift_data="{}"
  if [[ -n "$drift_file" ]] && [[ -f "$drift_file" ]]; then
    drift_data=$(cat "$drift_file" 2>/dev/null || echo "{}")
  fi

  # Write the python script to a temp file
  local py_tmp
  py_tmp=$(mktemp /tmp/jak-drift-XXXXXX.py)
  echo "$_JAK_DRIFT_PY" > "$py_tmp"

  # Run python drift reconciliation
  local updated_drift
  updated_drift=$(
    _PR_JSON_FILE="$pr_tmp" \
    _DRIFT_DATA="$drift_data" \
    _DRIFT_FILE="$drift_file" \
    _TICK_LOG="$tick_log" \
    _NOW_EPOCH="$now_epoch" \
    _TRANSITION_SCRIPT="$transition_script" \
    JIRA_RETRY_QUEUE="$retry_queue" \
    DOWNSTREAM_ROOT="${DOWNSTREAM_ROOT:-}" \
      python3 "$py_tmp" 2>/dev/null || echo "{}"
  )
  rm -f "$pr_tmp" "$py_tmp"

  # Echo non-JSON output lines (drift/AHEAD messages) to stdout so callers can see them.
  # Last line is the JSON object; everything before it is diagnostic output.
  local line_count
  line_count=$(echo "$updated_drift" | wc -l | tr -d ' ')
  if [[ "$line_count" -gt 1 ]]; then
    echo "$updated_drift" | head -n $(( line_count - 1 ))
  fi

  # Write updated drift file (last line is the JSON)
  local drift_json
  drift_json=$(echo "$updated_drift" | tail -1)
  if [[ -n "$drift_file" ]] && echo "$drift_json" | python3 -c "import sys,json; json.loads(sys.stdin.read())" 2>/dev/null; then
    mkdir -p "$(dirname "$drift_file")"
    echo "$drift_json" > "$drift_file"
  fi
}

export -f jak_pipeline_jira_tick_pass 2>/dev/null || true
export -f _jak_jira_drift_pass 2>/dev/null || true
