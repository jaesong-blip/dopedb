#!/usr/bin/env bash
# Pin this checkout's commit identity without changing the user's global Git config.
set -euo pipefail

readonly project_root="$(cd "$(dirname "$0")/.." && pwd)"
readonly committer_name="json-choi"
readonly committer_email="77596321+json-choi@users.noreply.github.com"

cd "$project_root"
if [ "$(git rev-parse --show-toplevel)" != "$project_root" ]; then
  echo "repo-identity: script must run from the DopeDB checkout" >&2
  exit 77
fi

git config --local user.name "$committer_name"
git config --local user.email "$committer_email"

if [ "$(git config --local user.name)" != "$committer_name" ] ||
  [ "$(git config --local user.email)" != "$committer_email" ]; then
  echo "repo-identity: failed to verify the repository-local commit identity" >&2
  exit 70
fi

echo "repo-identity: configured $committer_name <$committer_email>"
