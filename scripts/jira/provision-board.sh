#!/usr/bin/env bash
set -euo pipefail

# provision-board.sh — idempotent Jira workflow provisioning for jak-pipeline.
#
# Usage:
#   provision-board.sh --project <KEY>
#
# Creates the canonical 12-status "jak-pipeline" workflow on a fresh
# company-managed (classic) Jira Cloud project, plus a "jak-pipeline scheme"
# workflow scheme, and binds the scheme to the project.
#
# Idempotent: if the project already has the jak-pipeline workflow scheme
# assigned with all 12 statuses present, exits 0 without mutations.
#
# Board column mapping remains a manual UI step — see the printed
# instructions at the end of a successful run. Atlassian no longer exposes
# REST endpoints to manage board columns on Cloud.
#
# Requires Jira product-admin permission on the Atlassian site.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/kanban-order.sh
source "${SCRIPT_DIR}/lib/kanban-order.sh"

PROJECT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --board)
      echo "WARN: --board is deprecated and ignored. jak-pipeline provisions workflow + statuses; board columns are a manual UI step." >&2
      shift 2
      ;;
    *) echo "ERROR: unknown flag $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PROJECT" ]]; then echo "ERROR: --project is required" >&2; exit 1; fi

# ─── Credentials ────────────────────────────────────────────────────────────
JIRA_ENV_FILE="${JIRA_ENV_FILE:-}"
if [[ -z "$JIRA_ENV_FILE" ]]; then
  DOWNSTREAM_ROOT="${DOWNSTREAM_ROOT:-}"
  if [[ -n "$DOWNSTREAM_ROOT" ]] && [[ -f "$DOWNSTREAM_ROOT/.claude/jira/.env" ]]; then
    JIRA_ENV_FILE="$DOWNSTREAM_ROOT/.claude/jira/.env"
  fi
fi

if [[ -n "$JIRA_ENV_FILE" ]] && [[ -f "$JIRA_ENV_FILE" ]]; then
  set +u
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^#.*$ ]] && continue
    [[ -z "$key" ]] && continue
    if [[ -z "${!key:-}" ]]; then export "$key"="$value"; fi
  done < "$JIRA_ENV_FILE"
  set -u
fi

JIRA_BASE_URL="${JIRA_BASE_URL:-}"
JIRA_EMAIL="${JIRA_EMAIL:-}"
JIRA_API_TOKEN="${JIRA_API_TOKEN:-}"

if [[ -z "$JIRA_BASE_URL" || -z "$JIRA_EMAIL" || -z "$JIRA_API_TOKEN" ]]; then
  echo "ERROR: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN must all be set (via env or JIRA_ENV_FILE)" >&2
  exit 1
fi

AUTH_HEADER="Authorization: Basic $(printf '%s:%s' "$JIRA_EMAIL" "$JIRA_API_TOKEN" | base64 -w0 2>/dev/null || printf '%s:%s' "$JIRA_EMAIL" "$JIRA_API_TOKEN" | base64 | tr -d '\n')"

# ─── HTTP helpers ───────────────────────────────────────────────────────────
# Each helper writes response body to stdout followed by a trailing
# "__HTTP__<code>" marker line. Callers parse with python.
CURL_TIMEOUT="${JIRA_CURL_TIMEOUT:-30}"

jira_get() {
  local path="$1"
  curl -sS -H "$AUTH_HEADER" -H "Accept: application/json" \
    --max-time "$CURL_TIMEOUT" \
    -w "\n__HTTP__%{http_code}\n" \
    "${JIRA_BASE_URL}${path}"
}

jira_post() {
  local path="$1"; local body="$2"
  curl -sS -X POST -H "$AUTH_HEADER" -H "Content-Type: application/json" \
    --max-time "$CURL_TIMEOUT" \
    -d "$body" \
    -w "\n__HTTP__%{http_code}\n" \
    "${JIRA_BASE_URL}${path}"
}

# ─── 1. Pre-flight: admin permission ────────────────────────────────────────
echo "Pre-flight: checking Jira admin permission..."
perms_raw=$(jira_get "/rest/api/3/mypermissions?permissions=ADMINISTER" 2>/dev/null || true)
admin_granted=$(echo "$perms_raw" | python3 -c "
import sys, json
buf = sys.stdin.read()
idx = buf.rfind('__HTTP__')
body = buf[:idx] if idx != -1 else buf
try:
    d = json.loads(body.strip())
    print(d.get('permissions', {}).get('ADMINISTER', {}).get('havePermission', False))
except Exception:
    print(False)
")

if [[ "$admin_granted" != "True" ]]; then
  echo "ERROR: Jira product-admin permission required to create workflows." >&2
  echo "       Confirm '$JIRA_EMAIL' has 'Administer Jira' permission at" >&2
  echo "       ${JIRA_BASE_URL}/jira/settings/products/jira-software-configuration" >&2
  exit 1
fi

# ─── 2. Resolve project ─────────────────────────────────────────────────────
echo "Pre-flight: resolving project '$PROJECT'..."
project_raw=$(jira_get "/rest/api/3/project/$PROJECT" 2>/dev/null || true)
project_info=$(echo "$project_raw" | python3 -c "
import sys, json
buf = sys.stdin.read()
idx = buf.rfind('__HTTP__')
body = buf[:idx] if idx != -1 else buf
code = buf[idx+len('__HTTP__'):].strip() if idx != -1 else '000'
try:
    d = json.loads(body.strip())
    print(f\"{code}|{d.get('id','')}|{d.get('style','')}|{d.get('simplified',False)}\")
except Exception:
    print(f'{code}|||')
")

IFS='|' read -r project_http PROJECT_ID PROJECT_STYLE PROJECT_SIMPLIFIED <<< "$project_info"

if [[ "$project_http" != "200" ]]; then
  echo "ERROR: project '$PROJECT' not found (HTTP $project_http)" >&2
  exit 1
fi

if [[ "$PROJECT_SIMPLIFIED" == "True" ]]; then
  echo "ERROR: '$PROJECT' is a team-managed (simplified) project." >&2
  echo "       jak-pipeline currently requires a company-managed (classic) project" >&2
  echo "       because the bulk-workflows API operates at the GLOBAL scope." >&2
  echo "       Open a new classic project and rerun this script." >&2
  exit 2
fi

echo "  project_id=$PROJECT_ID style=$PROJECT_STYLE"

# ─── 3. Idempotency check ───────────────────────────────────────────────────
echo "Idempotency: checking current workflow scheme..."
scheme_raw=$(jira_get "/rest/api/3/workflowscheme/project?projectId=$PROJECT_ID" 2>/dev/null || true)
current_default=$(echo "$scheme_raw" | python3 -c "
import sys, json
buf = sys.stdin.read()
idx = buf.rfind('__HTTP__')
body = buf[:idx] if idx != -1 else buf
try:
    d = json.loads(body.strip())
    vals = d.get('values', [])
    if vals:
        print(vals[0].get('workflowScheme', {}).get('defaultWorkflow', ''))
    else:
        print('')
except Exception:
    print('')
")

# Render the 12 canonical names as a python list literal for embedding.
KANBAN_PY=$(python3 -c "import sys; print(sys.argv[1:])" "${KANBAN_STATES[@]}")

if [[ "$current_default" == "jak-pipeline" ]]; then
  statuses_raw=$(jira_get "/rest/api/3/project/$PROJECT/statuses" 2>/dev/null || true)
  missing=$(echo "$statuses_raw" | python3 -c "
import sys, json
required = $KANBAN_PY
buf = sys.stdin.read()
idx = buf.rfind('__HTTP__')
body = buf[:idx] if idx != -1 else buf
try:
    data = json.loads(body.strip())
except Exception:
    print('|'.join(required))
    sys.exit(0)
present = set()
for t in data:
    for s in t.get('statuses', []):
        present.add(s.get('name', ''))
miss = [r for r in required if r not in present]
print('|'.join(miss))
")
  if [[ -z "$missing" ]]; then
    echo "provision-board: already provisioned (workflow=jak-pipeline, 12/12 statuses present on $PROJECT)"
    cat <<EOF

Manual step (board columns) — done if you've already mapped this project's board:

  ${JIRA_BASE_URL}/jira/software/projects/${PROJECT}/boards
    → Board → Configure → Columns
    Map columns to statuses in this order:
      Idea → Backlog → Planning → Plan Review → Ready to Dev
        → In Development → PR Review → Merge Queue → UAT → Done
    Leave Blocked and Cancelled unmapped (swimlane / terminal).

EOF
    exit 0
  fi
  echo "  workflow=jak-pipeline but missing statuses: ${missing//|/, } — will re-provision."
fi

# ─── 4. Discover reusable global statuses ───────────────────────────────────
# Backlog/Done/Blocked are typically global on Jira Cloud sites. Reusing them
# by id avoids NON_UNIQUE_STATUS_NAME during workflow create.
echo "Discovery: looking up reusable global statuses..."
existing_ids=""
for state in "${KANBAN_STATES[@]}"; do
  enc=$(python3 -c "import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))" "$state")
  raw=$(jira_get "/rest/api/3/statuses/search?searchString=$enc" 2>/dev/null || true)
  found_id=$(echo "$raw" | python3 -c "
import sys, json
target = sys.argv[1]
buf = sys.stdin.read()
idx = buf.rfind('__HTTP__')
body = buf[:idx] if idx != -1 else buf
try:
    d = json.loads(body.strip())
    for v in d.get('values', []):
        if v.get('name') == target and v.get('scope', {}).get('type') == 'GLOBAL':
            print(v.get('id', ''))
            sys.exit(0)
except Exception:
    pass
print('')
" "$state")
  if [[ -n "$found_id" ]]; then
    existing_ids+="${state}=${found_id}|"
    echo "  reusing existing GLOBAL status '$state' id=$found_id"
  fi
done

# ─── 5. Build workflow payload ──────────────────────────────────────────────
echo "Build: assembling workflow payload..."
PAYLOAD_FILE=$(mktemp)
trap 'rm -f "$PAYLOAD_FILE"' EXIT

python3 - "$PAYLOAD_FILE" "$existing_ids" "${KANBAN_STATES[@]}" <<'PY'
import json, sys, uuid

out_path = sys.argv[1]
existing_raw = sys.argv[2]
states = sys.argv[3:]

existing = {}
for piece in existing_raw.split('|'):
    if '=' in piece:
        k, v = piece.split('=', 1)
        existing[k.strip()] = v.strip()

CATEGORIES = {
    'Idea': 'TODO', 'Backlog': 'TODO', 'Planning': 'TODO',
    'Plan Review': 'TODO', 'Ready to Dev': 'TODO',
    'In Development': 'IN_PROGRESS', 'PR Review': 'IN_PROGRESS',
    'Merge Queue': 'IN_PROGRESS', 'UAT': 'IN_PROGRESS',
    'Done': 'DONE', 'Blocked': 'IN_PROGRESS', 'Cancelled': 'DONE',
}
DESCRIPTIONS = {
    'Idea': 'Spitball / pre-validation. Not yet a real ticket.',
    'Backlog': 'Validated work; awaiting a slot to be planned.',
    'Planning': 'Planner agent authoring the plan.',
    'Plan Review': 'Plan PR open for review; plan-reviewer agent active.',
    'Ready to Dev': 'Plan approved + merged; awaiting dev-agent dispatch.',
    'In Development': 'Dev-agent implementing the plan.',
    'PR Review': 'Feature PR open; pr-reviewer agent active.',
    'Merge Queue': 'Queued on Mergify; awaiting merge slot.',
    'UAT': 'Per-PR UAT gate running.',
    'Done': 'Shipped to main.',
    'Blocked': 'Sidebar swimlane; retains blocked_from for return path.',
    'Cancelled': 'Terminal. Re-doing this work requires a new ticket.',
}

refs = {s: str(uuid.uuid4()) for s in states}

statuses = []
for s in states:
    entry = {
        'name': s,
        'statusCategory': CATEGORIES[s],
        'statusReference': refs[s],
        'description': DESCRIPTIONS[s],
    }
    if s in existing:
        entry['id'] = existing[s]
    statuses.append(entry)

transitions = [{
    'id': '1',
    'name': 'Create',
    'type': 'INITIAL',
    'toStatusReference': refs['Backlog'],
    'links': [],
    'properties': {},
}]
for i, s in enumerate(states, start=11):
    transitions.append({
        'id': str(i),
        'name': f'Move to {s}',
        'type': 'GLOBAL',
        'toStatusReference': refs[s],
        'links': [],
        'properties': {},
    })

payload = {
    'scope': {'type': 'GLOBAL'},
    'statuses': statuses,
    'workflows': [{
        'name': 'jak-pipeline',
        'description': (
            '12-state kanban workflow for jak-pipeline. '
            'Idea -> Backlog -> Planning -> Plan Review -> Ready to Dev -> '
            'In Development -> PR Review -> Merge Queue -> UAT -> Done, plus '
            'Blocked (swimlane) and Cancelled (terminal). All inter-state '
            'moves are GLOBAL transitions.'
        ),
        'statuses': [{'statusReference': refs[s], 'properties': {}} for s in states],
        'transitions': transitions,
    }],
}

with open(out_path, 'w') as f:
    json.dump(payload, f)
PY

# ─── 6. Validate workflow payload ───────────────────────────────────────────
echo "Validate: POST /rest/api/3/workflows/create/validation..."
validate_body=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    payload = json.load(f)
print(json.dumps({'payload': payload, 'validationOptions': {'levels': ['WARNING', 'ERROR']}}))
" "$PAYLOAD_FILE")

validate_raw=$(jira_post "/rest/api/3/workflows/create/validation" "$validate_body" 2>/dev/null || true)
validate_result=$(echo "$validate_raw" | python3 -c "
import sys, json
buf = sys.stdin.read()
idx = buf.rfind('__HTTP__')
body = buf[:idx] if idx != -1 else buf
code = buf[idx+len('__HTTP__'):].strip() if idx != -1 else '000'
try:
    d = json.loads(body.strip()) if body.strip() else {}
except Exception:
    d = {}
errors = d.get('errors', [])
warnings = d.get('warnings', [])
print(f'{code}|{len(errors)}|{len(warnings)}')
for e in errors:
    print(f\"  ERROR: {json.dumps(e)}\", file=sys.stderr)
for w in warnings:
    print(f\"  WARN:  {json.dumps(w)}\", file=sys.stderr)
")
IFS='|' read -r validate_http err_count warn_count <<< "$validate_result"

if [[ "$validate_http" != "200" ]]; then
  echo "ERROR: workflow validation request failed (HTTP $validate_http)" >&2
  exit 1
fi
if [[ "$err_count" != "0" ]]; then
  echo "ERROR: workflow validation reported $err_count error(s) — see stderr above. Aborting." >&2
  exit 1
fi
echo "  validation OK ($err_count errors, $warn_count warnings)"

# ─── 7. Create workflow ─────────────────────────────────────────────────────
echo "Create: POST /rest/api/3/workflows/create..."
create_body=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    print(json.dumps(json.load(f)))
" "$PAYLOAD_FILE")

create_raw=$(jira_post "/rest/api/3/workflows/create" "$create_body" 2>/dev/null || true)
create_http=$(echo "$create_raw" | python3 -c "
import sys
buf = sys.stdin.read()
idx = buf.rfind('__HTTP__')
print(buf[idx+len('__HTTP__'):].strip() if idx != -1 else '000')
")

if [[ "$create_http" != "200" && "$create_http" != "201" ]]; then
  echo "ERROR: workflow create failed (HTTP $create_http)" >&2
  echo "$create_raw" >&2
  exit 1
fi
echo "  workflow created (HTTP $create_http)"

# ─── 8. Create workflow scheme ──────────────────────────────────────────────
echo "Scheme: POST /rest/api/3/workflowscheme..."
scheme_body='{"name":"jak-pipeline scheme","description":"Workflow scheme for jak-pipeline-driven projects. Uses jak-pipeline workflow as default for all issue types.","defaultWorkflow":"jak-pipeline"}'
scheme_raw=$(jira_post "/rest/api/3/workflowscheme" "$scheme_body" 2>/dev/null || true)
scheme_result=$(echo "$scheme_raw" | python3 -c "
import sys, json
buf = sys.stdin.read()
idx = buf.rfind('__HTTP__')
body = buf[:idx] if idx != -1 else buf
code = buf[idx+len('__HTTP__'):].strip() if idx != -1 else '000'
try:
    d = json.loads(body.strip()) if body.strip() else {}
    print(f\"{code}|{d.get('id','')}\")
except Exception:
    print(f'{code}|')
")
IFS='|' read -r scheme_http SCHEME_ID <<< "$scheme_result"

if [[ "$scheme_http" != "201" && "$scheme_http" != "200" ]]; then
  echo "ERROR: workflow scheme create failed (HTTP $scheme_http)" >&2
  echo "$scheme_raw" >&2
  exit 1
fi
echo "  scheme created id=$SCHEME_ID"

# ─── 9. Build switch payload with status mappings ───────────────────────────
# We need to map every existing status on the project (per issue type) to a
# jak-pipeline status the new scheme actually contains. Name-based heuristic:
echo "Mappings: building per-issue-type status mappings for switch..."
switch_payload=$(python3 - "$PROJECT" "$SCHEME_ID" "$PROJECT_ID" "$JIRA_BASE_URL" "$JIRA_EMAIL" "$JIRA_API_TOKEN" <<'PY'
import json, sys, base64, urllib.request, urllib.parse

project, scheme_id, project_id, base, email, token = sys.argv[1:7]
auth = base64.b64encode(f'{email}:{token}'.encode()).decode()
hdr = {'Authorization': f'Basic {auth}', 'Accept': 'application/json'}

def gget(path):
    req = urllib.request.Request(base + path, headers=hdr)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except Exception:
        return None

# Existing statuses on project, per issue type, BEFORE the switch
existing = gget(f'/rest/api/3/project/{project}/statuses') or []

# New statuses from the jak-pipeline scheme: query all statuses with scope GLOBAL
# matching our names. Their IDs are what we'll target.
NAME_MAP = {
    'to do': 'Backlog', 'todo': 'Backlog', 'open': 'Backlog', 'new': 'Backlog',
    'selected for development': 'Ready to Dev',
    'in progress': 'In Development', 'in review': 'PR Review',
    'code review': 'PR Review', 'reopened': 'Backlog',
    'closed': 'Done', 'resolved': 'Done', 'done': 'Done',
    'cancelled': 'Cancelled', 'canceled': 'Cancelled', 'blocked': 'Blocked',
}
WANTED = ['Idea','Backlog','Planning','Plan Review','Ready to Dev',
          'In Development','PR Review','Merge Queue','UAT','Done',
          'Blocked','Cancelled']

# Look up the new status IDs by name from the global statuses search.
new_id_by_name = {}
for name in WANTED:
    enc = urllib.parse.quote(name)
    r = gget(f'/rest/api/3/statuses/search?searchString={enc}')
    if not r:
        continue
    for v in r.get('values', []):
        if v.get('name') == name and v.get('scope', {}).get('type') == 'GLOBAL':
            new_id_by_name[name] = v.get('id')
            break

override = []
for it in existing:
    it_id = it.get('id')
    statuses = it.get('statuses', [])
    maps = []
    for s in statuses:
        old_id = s.get('id')
        old_name = s.get('name', '')
        # If the old status is already one of ours, no mapping needed.
        if old_name in WANTED:
            continue
        target_name = NAME_MAP.get(old_name.lower(), 'Backlog')
        new_id = new_id_by_name.get(target_name) or new_id_by_name.get('Backlog')
        if new_id and old_id:
            maps.append({'oldStatusId': old_id, 'newStatusId': new_id})
    if maps:
        override.append({'issueTypeId': it_id, 'statusMappings': maps})

print(json.dumps({
    'projectId': project_id,
    'targetSchemeId': scheme_id,
    'mappingsByIssueTypeOverride': override,
}))
PY
)

# ─── 10. Switch project to new scheme ───────────────────────────────────────
echo "Switch: POST /rest/api/3/workflowscheme/project/switch..."
switch_raw=$(jira_post "/rest/api/3/workflowscheme/project/switch" "$switch_payload" 2>/dev/null || true)
switch_http=$(echo "$switch_raw" | python3 -c "
import sys
buf = sys.stdin.read()
idx = buf.rfind('__HTTP__')
print(buf[idx+len('__HTTP__'):].strip() if idx != -1 else '000')
")

if [[ "$switch_http" == "303" || "$switch_http" == "201" || "$switch_http" == "200" || "$switch_http" == "204" ]]; then
  task_id=$(echo "$switch_raw" | python3 -c "
import sys, json
buf = sys.stdin.read()
idx = buf.rfind('__HTTP__')
body = buf[:idx] if idx != -1 else buf
try:
    d = json.loads(body.strip()) if body.strip() else {}
    print(d.get('taskId') or d.get('id') or '')
except Exception:
    print('')
")
  if [[ -n "$task_id" ]]; then
    echo "  switch enqueued as task $task_id — polling..."
    completed=""
    for _ in $(seq 1 30); do
      task_raw=$(jira_get "/rest/api/3/task/$task_id" 2>/dev/null || true)
      task_status=$(echo "$task_raw" | python3 -c "
import sys,json
buf=sys.stdin.read()
idx=buf.rfind('__HTTP__')
body=buf[:idx] if idx!=-1 else buf
try:
    d=json.loads(body.strip()) if body.strip() else {}
    print(d.get('status','UNKNOWN'))
except Exception:
    print('UNKNOWN')
")
      case "$task_status" in
        COMPLETE) echo "  task complete."; completed=1; break ;;
        FAILED|CANCEL_REQUESTED|CANCELLED) echo "ERROR: scheme switch task ended with status=$task_status" >&2; exit 1 ;;
        *) sleep 2 ;;
      esac
    done
    if [[ -z "$completed" ]]; then
      echo "ERROR: scheme switch task $task_id did not complete within 60s" >&2
      exit 1
    fi
  fi
  echo "  switch OK (HTTP $switch_http)"
elif [[ "$switch_http" == "409" ]]; then
  echo "ERROR: switch returned 409 conflictingTaskId — a prior scheme migration is still in progress." >&2
  echo "       Wait for it to finish and rerun this script." >&2
  exit 1
else
  echo "ERROR: scheme switch failed (HTTP $switch_http)" >&2
  echo "$switch_raw" >&2
  exit 1
fi

# ─── 11. Success — print manual board hand-off ──────────────────────────────
cat <<EOF

provision-board: SUCCESS

Workflow + 12 statuses provisioned on $PROJECT, workflow scheme assigned.

One manual step remains — board column mapping is UI-only on Jira Cloud:

  Go to ${JIRA_BASE_URL}/jira/software/projects/${PROJECT}/boards
    → Board → Configure → Columns
    Map the visible columns to:
      Idea → Backlog → Planning → Plan Review → Ready to Dev
        → In Development → PR Review → Merge Queue → UAT → Done
    Leave Blocked and Cancelled unmapped (swimlane / terminal).

EOF
