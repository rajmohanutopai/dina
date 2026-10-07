#!/usr/bin/env bash
# Compile apps/mobile/modules/dina-names/ios/NameFinder.swift with its macOS
# check and run it (docs/PII_ARCHITECTURE_V2.md §7). macOS 26+ with Apple
# Intelligence runs the model cases; otherwise the tagger cases only.
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
mod="$here/apps/mobile/modules/dina-names"
out="$(mktemp -d)/dina_names_check"
swiftc -O "$mod/ios/NameFinder.swift" "$mod/macos-check/main.swift" -o "$out"
"$out"
