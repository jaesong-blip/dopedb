#!/usr/bin/env bash
# Keep the normal `pnpm tauri ...` interface while giving every development build
# a distinct app identity. macOS development also uses the stable-signing runner.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_BIN="$PROJECT_ROOT/node_modules/.bin/tauri"
DEV_CONFIG="$PROJECT_ROOT/src-tauri/tauri.dev.conf.json"

run_with_dev_identity() {
  local command="$1"
  shift
  local separated=false
  local -a command_args=()
  local -a passthrough_args=()

  for arg in "$@"; do
    if [ "$separated" = false ] && [ "$arg" = "--" ]; then
      separated=true
    fi
    if [ "$separated" = true ]; then
      passthrough_args+=("$arg")
    else
      command_args+=("$arg")
    fi
  done

  if [ "$command" = "dev" ] && [ "$(uname -s)" = "Darwin" ]; then
    command_args+=(--runner "$PROJECT_ROOT/scripts/cargo-signed-runner.sh")
  fi

  # Merge this last so a caller cannot accidentally make a development process
  # impersonate the production bundle through an earlier config override.
  local -a launch_args=("$TAURI_BIN" "$command")
  if [ "${#command_args[@]}" -gt 0 ]; then
    launch_args+=("${command_args[@]}")
  fi
  launch_args+=(--config "$DEV_CONFIG")
  if [ "${#passthrough_args[@]}" -gt 0 ]; then
    launch_args+=("${passthrough_args[@]}")
  fi
  exec "${launch_args[@]}"
}

if [ "${1:-}" = "dev" ]; then
  shift
  run_with_dev_identity dev "$@"
fi

if [ "${1:-}" = "build" ]; then
  debug=false
  for arg in "${@:2}"; do
    [ "$arg" = "--" ] && break
    if [ "$arg" = "--debug" ] || [ "$arg" = "-d" ]; then
      debug=true
      break
    fi
  done
  if [ "$debug" = true ]; then
    shift
    run_with_dev_identity build "$@"
  fi
fi

exec "$TAURI_BIN" "$@"
