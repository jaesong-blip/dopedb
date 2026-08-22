#!/usr/bin/env bash

# Notarizes the final disk image that users download. Tauri notarizes and
# staples the app before creating the DMG, so the outer distribution container
# needs its own ticket before the draft asset can be trusted or published.

set -euo pipefail

usage() {
  echo "usage: notarize-macos-dmg.sh --bundle-root <path> --github-output <path>" >&2
  exit 2
}

if [[ "$#" -ne 4 || "$1" != "--bundle-root" || "$3" != "--github-output" ]]; then
  usage
fi

bundle_root="$2"
github_output="$4"

for variable in APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH RUNNER_TEMP; do
  if [[ -z "${!variable:-}" ]]; then
    echo "DMG notarization requires $variable." >&2
    exit 1
  fi
done

if [[ ! -f "$APPLE_API_KEY_PATH" ]]; then
  echo "DMG notarization API key file is missing." >&2
  exit 1
fi
if [[ ! -d "$bundle_root/dmg" ]]; then
  echo "DMG bundle directory is missing." >&2
  exit 1
fi
if [[ -z "$github_output" || "$github_output" == *$'\n'* ]]; then
  echo "GitHub output path is invalid." >&2
  exit 1
fi

bundle_root="$(cd "$bundle_root" && pwd -P)"
dmg_root="$bundle_root/dmg"
shopt -s nullglob
dmg_files=("$dmg_root"/*.dmg)
shopt -u nullglob
if [[ "${#dmg_files[@]}" -ne 1 ]]; then
  echo "Expected exactly one DMG in the target bundle." >&2
  exit 1
fi
dmg="${dmg_files[0]}"
if [[ "$dmg" == *$'\n'* ]]; then
  echo "DMG path is invalid." >&2
  exit 1
fi

notary_receipt="$(mktemp "$RUNNER_TEMP/dopedb-dmg-notarization.XXXXXX.json")"
cleanup() {
  rm -f "$notary_receipt"
}
trap cleanup EXIT

# Fail before upload when the generated image is already corrupt, then verify
# it again after stapler modifies the top-level container.
hdiutil verify "$dmg"
xcrun notarytool submit "$dmg" \
  --key "$APPLE_API_KEY_PATH" \
  --key-id "$APPLE_API_KEY" \
  --issuer "$APPLE_API_ISSUER" \
  --wait \
  --timeout 20m \
  --output-format json > "$notary_receipt"

notary_status="$(node -e '
  const fs = require("node:fs");
  const receipt = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (typeof receipt.status !== "string") process.exit(2);
  process.stdout.write(receipt.status);
' "$notary_receipt")"
if [[ "$notary_status" != "Accepted" ]]; then
  echo "DMG notarization did not finish as Accepted: $notary_status" >&2
  exit 1
fi

# Ticket propagation can lag the Accepted response briefly. Retry only the
# bounded staple operation; never re-submit the artifact inside this loop.
stapled=0
for attempt in 1 2 3 4 5 6; do
  if xcrun stapler staple "$dmg"; then
    stapled=1
    break
  fi
  if [[ "$attempt" -lt 6 ]]; then
    sleep "$((attempt * 5))"
  fi
done
if [[ "$stapled" != "1" ]]; then
  echo "Accepted DMG notarization ticket could not be stapled." >&2
  exit 1
fi

xcrun stapler validate "$dmg"
hdiutil verify "$dmg"
printf 'dmg=%s\n' "$dmg" >> "$github_output"
