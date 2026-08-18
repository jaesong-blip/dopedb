#!/usr/bin/env bash
# Run one explicit owner-authored commit or annotated tag without persisting identity.
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
readonly project_root
readonly owner_name="json-choi"
readonly owner_email="77596321+json-choi@users.noreply.github.com"

usage() {
  cat >&2 <<'EOF'
Usage:
  pnpm repo:owner-identity -- git commit <arguments...>
  pnpm repo:owner-identity -- git tag -a <arguments...>

This owner-only wrapper is for an explicitly requested direct-main commit or
annotated stable-release tag. Contributors and PR workers keep their own Git identity.
EOF
}

if [ "${1:-}" = "--" ]; then
  shift
fi
if [ "$#" -lt 2 ] || [ "$(basename "$1")" != "git" ]; then
  usage
  exit 64
fi

readonly git_action="$2"
case "$git_action" in
  commit)
    ;;
  tag)
    annotated=false
    for argument in "${@:3}"; do
      if [ "$argument" = "-a" ] || [ "$argument" = "--annotate" ]; then
        annotated=true
        break
      fi
    done
    if [ "$annotated" != true ]; then
      echo "repo-owner-identity: only annotated tags are allowed" >&2
      exit 64
    fi
    ;;
  *)
    echo "repo-owner-identity: only git commit or annotated git tag is allowed" >&2
    usage
    exit 64
    ;;
esac

cd "$project_root"
if [ "$(git rev-parse --show-toplevel)" != "$project_root" ]; then
  echo "repo-owner-identity: script must run from the DopeDB checkout" >&2
  exit 77
fi
if [ "$(git branch --show-current)" != "main" ]; then
  echo "repo-owner-identity: owner-authored commands require the main branch" >&2
  exit 77
fi

GIT_AUTHOR_NAME="$owner_name" \
GIT_AUTHOR_EMAIL="$owner_email" \
GIT_COMMITTER_NAME="$owner_name" \
GIT_COMMITTER_EMAIL="$owner_email" \
  "$@"
