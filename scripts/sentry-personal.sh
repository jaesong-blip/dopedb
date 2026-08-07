#!/usr/bin/env bash
# Runs one Sentry CLI command with the personal token held in macOS Keychain.
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: scripts/sentry-personal.sh <sentry arguments...>" >&2
  exit 64
fi

if ! command -v sentry >/dev/null 2>&1; then
  echo "Sentry CLI is not installed or is not on PATH." >&2
  exit 127
fi

personal_token="$(security find-generic-password \
  -a personal \
  -s com.dopedb.sentry.personal \
  -w)"

if [[ -z "$personal_token" ]]; then
  echo "The personal Sentry Keychain entry is empty." >&2
  exit 1
fi

export SENTRY_AUTH_TOKEN="$personal_token"
unset personal_token

exec sentry "$@"
