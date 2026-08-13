#!/usr/bin/env bash
set -euo pipefail

cloud_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${VERCEL_ENV:-}" != "production" ]]; then
  echo "Production migrations require VERCEL_ENV=production" >&2
  exit 1
fi

unpooled_url="${DATABASE_URL_UNPOOLED:-}"
if [[ -z "${unpooled_url//[[:space:]]/}" ]]; then
  echo "DATABASE_URL_UNPOOLED is required for production migrations" >&2
  exit 1
fi

cd "$cloud_dir"
DATABASE_URL="$unpooled_url" DATABASE_URL_UNPOOLED="$unpooled_url" pnpm db:migrate
