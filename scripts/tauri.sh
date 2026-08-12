#!/usr/bin/env bash
# Keep the normal `pnpm tauri ...` interface while giving every development build
# a distinct app identity. macOS development also uses the stable-signing runner.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_BIN="$PROJECT_ROOT/node_modules/.bin/tauri"
DEV_CONFIG="$PROJECT_ROOT/src-tauri/tauri.dev.conf.json"
DEV_PORT=1420
DEV_SESSION_DIR="$PROJECT_ROOT/target/.tauri-dev-session"
DEV_SESSION_PID_FILE="$DEV_SESSION_DIR/pid"
DEV_SESSION_LOCK_HELD=false

cleanup_dev_session_lock() {
  if [ "$DEV_SESSION_LOCK_HELD" != true ]; then
    return
  fi

  local owner_pid=""
  if [ -f "$DEV_SESSION_PID_FILE" ]; then
    IFS= read -r owner_pid < "$DEV_SESSION_PID_FILE" || true
  fi
  if [ "$owner_pid" = "$$" ]; then
    rm -f "$DEV_SESSION_PID_FILE"
    rmdir "$DEV_SESSION_DIR" 2>/dev/null || true
  fi
}

is_live_dev_session_owner() {
  local owner_pid="$1"
  case "$owner_pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if ! kill -0 "$owner_pid" 2>/dev/null; then
    return 1
  fi

  local owner_command owner_cwd=""
  owner_command="$(ps -p "$owner_pid" -o command= 2>/dev/null || true)"
  if command -v lsof >/dev/null 2>&1; then
    owner_cwd="$(lsof -a -p "$owner_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
    if [ -n "$owner_cwd" ] && [ "$owner_cwd" != "$PROJECT_ROOT" ]; then
      return 1
    fi
  fi
  case "$owner_command" in
    *"scripts/tauri.sh dev"*|*"/@tauri-apps/cli/tauri.js dev"*) return 0 ;;
    *) return 1 ;;
  esac
}

acquire_dev_session_lock() {
  mkdir -p "$PROJECT_ROOT/target"

  if ! mkdir "$DEV_SESSION_DIR" 2>/dev/null; then
    local owner_pid=""
    if [ -f "$DEV_SESSION_PID_FILE" ]; then
      IFS= read -r owner_pid < "$DEV_SESSION_PID_FILE" || true
    fi
    if is_live_dev_session_owner "$owner_pid"; then
      echo "error: DopeDB development is already running (PID $owner_pid)." >&2
      echo "Close that development app or stop its terminal before running pnpm tauri dev again." >&2
      exit 1
    fi

    rm -f "$DEV_SESSION_PID_FILE"
    rmdir "$DEV_SESSION_DIR" 2>/dev/null || true
    if ! mkdir "$DEV_SESSION_DIR" 2>/dev/null; then
      echo "error: another DopeDB development session started concurrently." >&2
      exit 1
    fi
  fi

  printf '%s\n' "$$" > "$DEV_SESSION_PID_FILE"
  DEV_SESSION_LOCK_HELD=true
  trap cleanup_dev_session_lock EXIT
}

is_stale_repo_vite() {
  local listener_pid="$1"
  local listener_cwd listener_command parent_pid parent_command grandparent_pid
  listener_cwd="$(lsof -a -p "$listener_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  listener_command="$(ps -p "$listener_pid" -o command= 2>/dev/null || true)"
  if [ "$listener_cwd" != "$PROJECT_ROOT" ]; then
    return 1
  fi
  case "$listener_command" in
    *"/vite/bin/vite.js"*) ;;
    *) return 1 ;;
  esac

  parent_pid="$(ps -p "$listener_pid" -o ppid= 2>/dev/null | tr -d ' ')"
  if [ -z "$parent_pid" ] || [ "$parent_pid" = "1" ]; then
    return 0
  fi
  parent_command="$(ps -p "$parent_pid" -o command= 2>/dev/null || true)"
  grandparent_pid="$(ps -p "$parent_pid" -o ppid= 2>/dev/null | tr -d ' ')"
  if [ "$grandparent_pid" = "1" ]; then
    case "$parent_command" in
      *"pnpm dev"*) return 0 ;;
    esac
  fi
  return 1
}

prepare_dev_port() {
  # Vite and tauri.conf.json intentionally share this fixed port. On macOS,
  # clean only a proven orphan from this checkout; never terminate an active
  # dev session or an unrelated process just because it owns the same port.
  if ! command -v lsof >/dev/null 2>&1; then
    return
  fi

  local listener_pids
  listener_pids="$(lsof -nP -t -iTCP:"$DEV_PORT" -sTCP:LISTEN 2>/dev/null | sort -u || true)"
  if [ -z "$listener_pids" ]; then
    return
  fi

  local listener_pid
  for listener_pid in $listener_pids; do
    if ! is_stale_repo_vite "$listener_pid"; then
      local listener_command
      listener_command="$(ps -p "$listener_pid" -o command= 2>/dev/null || true)"
      echo "error: port $DEV_PORT is already used by an active process (PID $listener_pid)." >&2
      echo "       $listener_command" >&2
      echo "Stop that process before running pnpm tauri dev again." >&2
      exit 1
    fi
  done

  echo "stopping stale DopeDB Vite server on port $DEV_PORT (PID: ${listener_pids//$'\n'/, })"
  for listener_pid in $listener_pids; do
    kill -TERM "$listener_pid" 2>/dev/null || true
  done

  local attempts_remaining=5
  while [ "$attempts_remaining" -gt 0 ]; do
    if ! lsof -nP -t -iTCP:"$DEV_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      return
    fi
    sleep 1
    attempts_remaining=$((attempts_remaining - 1))
  done

  echo "error: the stale Vite server did not release port $DEV_PORT." >&2
  echo "Stop it manually and run pnpm tauri dev again." >&2
  exit 1
}

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

  if [ "$command" = "dev" ]; then
    acquire_dev_session_lock
    prepare_dev_port
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
  if [ "$command" = "dev" ]; then
    "${launch_args[@]}"
    return
  fi
  exec "${launch_args[@]}"
}

if [ "${1:-}" = "dev" ]; then
  shift
  run_with_dev_identity dev "$@"
  exit $?
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
