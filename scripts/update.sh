#!/usr/bin/env bash
set -euo pipefail

# update.sh — refresh skill-owned files in a jak-pipeline downstream from the
# upstream skill repo, without touching customisable templates or user config.
#
# Usage:
#   update.sh [--dry-run] [--verbose]
#
# Run from inside the downstream project's root, or set JAK_DOWNSTREAM_ROOT.
# Set JAK_SKILL_ROOT to override the skill location (defaults to this script's
# parent directory).
#
# What gets touched:
#   - Files listed in templates/install-manifest.tsv with category 'skill'
#     are always refreshed from upstream.
#   - The single 'skill-append' file (scripts/scrum-master/tick.sh) is refreshed
#     and the install-time Jira hook append is re-applied if it was present.
#   - Locally-modified copies of skill files are backed up to <path>.bak before
#     refresh.
#   - User-owned files (.env, .scrum-master.json, agent .md files, MCP bundle,
#     etc.) are NOT in the manifest and are NOT touched.
#
# State is recorded in <downstream>/.claude/jak-pipeline/install-manifest.json:
# the upstream SHA at the time of refresh + each tracked file's hash. Future
# update.sh runs use this to detect locally-modified vs upstream-changed.
#
# v1 scope: scripts only. Future versions may extend to customisable templates
# (.claude/agents/*.md, .mergify.yml, etc.) via a --force-customisable flag.

JAK_SKILL_ROOT="${JAK_SKILL_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DOWNSTREAM_ROOT="${JAK_DOWNSTREAM_ROOT:-${DOWNSTREAM_ROOT:-$PWD}}"

DRY_RUN=0
VERBOSE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)        DRY_RUN=1; shift ;;
    --verbose|-v)     VERBOSE=1; shift ;;
    --help|-h)
      sed -n '4,30p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "ERROR: unknown flag '$1' (try --help)" >&2; exit 1 ;;
  esac
done

MANIFEST_TSV="${JAK_SKILL_ROOT}/templates/install-manifest.tsv"
STATE_JSON="${DOWNSTREAM_ROOT}/.claude/jak-pipeline/install-manifest.json"

if [ ! -f "$MANIFEST_TSV" ]; then
  echo "ERROR: install-manifest.tsv not found at $MANIFEST_TSV" >&2
  echo "       JAK_SKILL_ROOT=$JAK_SKILL_ROOT" >&2
  exit 1
fi

if [ ! -d "$DOWNSTREAM_ROOT" ]; then
  echo "ERROR: DOWNSTREAM_ROOT=$DOWNSTREAM_ROOT is not a directory" >&2
  exit 1
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "[update] DRY-RUN — no files will be modified."
fi
echo "[update] skill root:     $JAK_SKILL_ROOT"
echo "[update] downstream:     $DOWNSTREAM_ROOT"
echo "[update] state manifest: $STATE_JSON"
echo

sha() {
  sha256sum "$1" 2>/dev/null | awk '{print $1}'
}

# Read previously-recorded installed_hash for a destination path. Empty if no
# state file (= bootstrap run) or the file isn't tracked yet.
state_get_hash() {
  local dst="$1"
  if [ ! -f "$STATE_JSON" ]; then echo ""; return; fi
  python3 -c "
import json, sys
try:
    with open('$STATE_JSON') as f:
        d = json.load(f)
    print(d.get('files', {}).get('$dst', {}).get('installed_hash', ''))
except Exception:
    print('')
"
}

# Re-apply the Plan 3 Jira hook to tick.sh. Mirrors install.sh:623.
reapply_jira_hook() {
  local tick_sh="$1"
  printf '\n# jak-pipeline: Jira tick pass\n. "$(dirname "${BASH_SOURCE[0]}")/../jak-pipeline/jira/tick-extension.sh"\njak_pipeline_jira_tick_pass\n' >> "$tick_sh"
}

# Counters
UPDATED=0
NO_CHANGE=0
INSTALLED=0
BACKED_UP=0
REAPPLIED=0
ERRORS=0

# Snapshot the manifest's bootstrap flag — true if no state file exists yet.
BOOTSTRAP=0
if [ ! -f "$STATE_JSON" ]; then
  BOOTSTRAP=1
  echo "[update] No prior state file — bootstrapping. Locally-modified detection"
  echo "[update] will not catch existing customisations on this run; future runs will."
  echo
fi

# Iterate over manifest
while IFS=$'\t' read -r src dst cat; do
  [[ -z "${src:-}" ]] && continue
  [[ "$src" =~ ^# ]] && continue
  [[ "$src" == "src_path" ]] && continue

  abs_src="${JAK_SKILL_ROOT}/$src"
  abs_dst="${DOWNSTREAM_ROOT}/$dst"

  if [ ! -f "$abs_src" ]; then
    echo "  [ERROR]    $src — upstream source missing in skill repo"
    ERRORS=$((ERRORS+1))
    continue
  fi

  if [ ! -f "$abs_dst" ]; then
    echo "  [INSTALL]  $dst (not present in downstream)"
    INSTALLED=$((INSTALLED+1))
    if [ "$DRY_RUN" = "0" ]; then
      mkdir -p "$(dirname "$abs_dst")"
      cp "$abs_src" "$abs_dst"
      chmod +x "$abs_dst" 2>/dev/null || true
    fi
    continue
  fi

  src_hash=$(sha "$abs_src")
  dst_hash=$(sha "$abs_dst")
  prev_hash=$(state_get_hash "$dst")

  if [ "$src_hash" = "$dst_hash" ]; then
    [[ "$VERBOSE" = "1" ]] && echo "  [NOOP]     $dst"
    NO_CHANGE=$((NO_CHANGE+1))
    continue
  fi

  # File differs from upstream. Decide based on category.
  locally_modified=0
  if [ -n "$prev_hash" ] && [ "$prev_hash" != "$dst_hash" ]; then
    locally_modified=1
  fi

  case "$cat" in
    skill)
      if [ "$locally_modified" = "1" ]; then
        echo "  [UPDATE+BACKUP] $dst (locally modified; .bak written)"
        BACKED_UP=$((BACKED_UP+1))
        if [ "$DRY_RUN" = "0" ]; then
          cp "$abs_dst" "${abs_dst}.bak"
        fi
      else
        echo "  [UPDATE]   $dst"
      fi
      UPDATED=$((UPDATED+1))
      if [ "$DRY_RUN" = "0" ]; then
        cp "$abs_src" "$abs_dst"
        chmod +x "$abs_dst" 2>/dev/null || true
      fi
      ;;
    skill-append)
      had_sentinel=0
      if grep -qF "jak_pipeline_jira_tick_pass" "$abs_dst" 2>/dev/null; then
        had_sentinel=1
      fi
      if [ "$locally_modified" = "1" ]; then
        echo "  [UPDATE+BACKUP] $dst (locally modified; .bak written)"
        BACKED_UP=$((BACKED_UP+1))
        if [ "$DRY_RUN" = "0" ]; then
          cp "$abs_dst" "${abs_dst}.bak"
        fi
      else
        echo "  [UPDATE]   $dst"
      fi
      UPDATED=$((UPDATED+1))
      if [ "$DRY_RUN" = "0" ]; then
        cp "$abs_src" "$abs_dst"
        chmod +x "$abs_dst" 2>/dev/null || true
        if [ "$had_sentinel" = "1" ]; then
          reapply_jira_hook "$abs_dst"
          REAPPLIED=$((REAPPLIED+1))
          echo "    └─ re-applied jak_pipeline_jira_tick_pass hook"
        fi
      fi
      ;;
    *)
      echo "  [ERROR]    $dst — unknown category '$cat' in manifest"
      ERRORS=$((ERRORS+1))
      ;;
  esac
done < "$MANIFEST_TSV"

# Write fresh state manifest reflecting new hashes
if [ "$DRY_RUN" = "0" ]; then
  mkdir -p "$(dirname "$STATE_JSON")"
  python3 - "$JAK_SKILL_ROOT" "$DOWNSTREAM_ROOT" "$MANIFEST_TSV" "$STATE_JSON" <<'PY'
import sys, json, hashlib, os, subprocess

skill_root, downstream_root, manifest_tsv, state_json = sys.argv[1:5]

def sha256_file(path):
    if not os.path.exists(path):
        return ""
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            h.update(chunk)
    return h.hexdigest()

rows = []
with open(manifest_tsv) as f:
    for line in f:
        line = line.rstrip('\n')
        if not line or line.startswith('#') or line.startswith('src_path'):
            continue
        parts = line.split('\t')
        if len(parts) < 3:
            continue
        rows.append((parts[0], parts[1], parts[2]))

try:
    upstream_sha = subprocess.check_output(
        ['git', '-C', skill_root, 'rev-parse', 'HEAD'],
        stderr=subprocess.DEVNULL,
    ).decode().strip()
except Exception:
    upstream_sha = ''

files = {}
for src, dst, cat in rows:
    abs_dst = os.path.join(downstream_root, dst)
    files[dst] = {
        'installed_hash': sha256_file(abs_dst),
        'category': cat,
        'src': src,
    }

state = {
    'schema_version': 1,
    'upstream_sha': upstream_sha,
    'updated_at': subprocess.check_output(['date', '-u', '+%Y-%m-%dT%H:%M:%SZ']).decode().strip(),
    'files': files,
}
with open(state_json, 'w') as f:
    json.dump(state, f, indent=2)
    f.write('\n')
PY
  [[ "$VERBOSE" = "1" ]] && echo "[update] wrote state manifest → $STATE_JSON"
fi

echo
if [ "$DRY_RUN" = "1" ]; then
  echo "[update] DRY-RUN summary: would update ${UPDATED}, install ${INSTALLED}, backup ${BACKED_UP}; ${NO_CHANGE} already up to date."
else
  echo "[update] Summary: updated ${UPDATED}, installed ${INSTALLED} new, backed up ${BACKED_UP} local edits, re-applied ${REAPPLIED} hooks, ${NO_CHANGE} unchanged."
fi

if [ "$ERRORS" -gt 0 ]; then
  echo "[update] ${ERRORS} error(s) — see above." >&2
  exit 1
fi
