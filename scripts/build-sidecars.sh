#!/usr/bin/env bash
set -euo pipefail

node scripts/generate-skill-bundle.mjs --check

target_triple="${TAURI_ENV_TARGET_TRIPLE:-}"
if [[ -z "$target_triple" ]]; then
  target_triple="$(rustc -vV | sed -n 's/^host: //p')"
fi

if [[ -z "$target_triple" ]]; then
  echo "Could not determine Rust target triple" >&2
  exit 1
fi

cargo_args=(
  build
  --release
  --package dopedb-cli
)
target_root="${CARGO_TARGET_DIR:-target}"
if [[ "$target_root" != /* ]]; then
  target_root="$PWD/$target_root"
fi
artifact_dir="$target_root/release"
if [[ -n "${TAURI_ENV_TARGET_TRIPLE:-}" ]]; then
  cargo_args+=(--target "$target_triple")
  artifact_dir="$target_root/$target_triple/release"
fi

bin_ext=""
if [[ "$target_triple" == *"windows"* ]]; then
  bin_ext=".exe"
fi

cargo "${cargo_args[@]}"
mkdir -p src-tauri/binaries

stage_binary() {
  local source_path="$1"
  local destination_path="$2"
  if [[ ! -f "$source_path" ]]; then
    echo "Sidecar build artifact is missing: $source_path" >&2
    exit 1
  fi
  local temporary_path
  temporary_path="$(mktemp "src-tauri/binaries/.sidecar.XXXXXX")"
  trap 'rm -f "$temporary_path"' RETURN
  cp "$source_path" "$temporary_path"
  chmod 755 "$temporary_path"
  mv -f "$temporary_path" "$destination_path"
  if [[ "$target_triple" != *"windows"* && ! -x "$destination_path" ]]; then
    echo "Staged sidecar is not executable: $destination_path" >&2
    exit 1
  fi
  trap - RETURN
}

stage_binary \
  "$artifact_dir/dopedb-cli$bin_ext" \
  "src-tauri/binaries/dopedb-cli-$target_triple$bin_ext"

# Cloud SQL's official Auth Proxy is the supported desktop transport. Pin both
# the release and each platform digest so a mutable PATH installation or a
# changed upstream object can never enter the signed app bundle.
cloud_sql_proxy_version="2.22.0"
cloud_sql_proxy_asset=""
cloud_sql_proxy_sha256=""
case "$target_triple" in
  aarch64-apple-darwin)
    cloud_sql_proxy_asset="cloud-sql-proxy.darwin.arm64"
    cloud_sql_proxy_sha256="a81b3bcf54a79f824174f3122e05f80cca23bdec08d57600f0b8d740800fe281"
    ;;
  x86_64-apple-darwin)
    cloud_sql_proxy_asset="cloud-sql-proxy.darwin.amd64"
    cloud_sql_proxy_sha256="e02f9b62532e70dbb0045c6a8ee3bb7d725c666ddef5eb7b10ed9bf65701cd9c"
    ;;
  x86_64-pc-windows-msvc)
    cloud_sql_proxy_asset="cloud-sql-proxy.x64.exe"
    cloud_sql_proxy_sha256="55f5932bdd7e5e3beb0be3ec1f480ea78e3bc9b0595ebc3ee2c31fa379cace22"
    ;;
  aarch64-unknown-linux-gnu)
    cloud_sql_proxy_asset="cloud-sql-proxy.linux.arm64"
    cloud_sql_proxy_sha256="ecf3d790bfde322776aaaf5953d46c49e2dc3f96eb20cf51c38e366aa1f1021d"
    ;;
  x86_64-unknown-linux-gnu)
    cloud_sql_proxy_asset="cloud-sql-proxy.linux.amd64"
    cloud_sql_proxy_sha256="42e73a8775bc3300b6514816cc4893f01b109a50f65aa779a451d3e4ff4c3ead"
    ;;
  *)
    echo "Cloud SQL Auth Proxy is not available for target $target_triple" >&2
    exit 1
    ;;
esac

cloud_sql_proxy_cache="$target_root/sidecars/cloud-sql-proxy-v$cloud_sql_proxy_version/$cloud_sql_proxy_asset"
mkdir -p "$(dirname "$cloud_sql_proxy_cache")"
if [[ ! -f "$cloud_sql_proxy_cache" ]]; then
  cloud_sql_proxy_download="$(mktemp "$(dirname "$cloud_sql_proxy_cache")/.cloud-sql-proxy.XXXXXX")"
  trap 'rm -f "$cloud_sql_proxy_download"' RETURN
  curl --fail --location --silent --show-error \
    "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v$cloud_sql_proxy_version/$cloud_sql_proxy_asset" \
    --output "$cloud_sql_proxy_download"
  node -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const [path, expected] = process.argv.slice(1);
    const actual = crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
    if (actual !== expected) {
      console.error(`Cloud SQL Auth Proxy checksum mismatch: ${actual}`);
      process.exit(1);
    }
  ' "$cloud_sql_proxy_download" "$cloud_sql_proxy_sha256"
  chmod 755 "$cloud_sql_proxy_download"
  mv -f "$cloud_sql_proxy_download" "$cloud_sql_proxy_cache"
  trap - RETURN
fi

node -e '
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  const [path, expected] = process.argv.slice(1);
  const actual = crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
  if (actual !== expected) process.exit(1);
' "$cloud_sql_proxy_cache" "$cloud_sql_proxy_sha256"

stage_binary \
  "$cloud_sql_proxy_cache" \
  "src-tauri/binaries/cloud-sql-proxy-$target_triple$bin_ext"
