#!/usr/bin/env bash
# Type-check against the pi that is actually installed.
#
# @earendil-works/* and typebox are peers that pi aliases at runtime, so they
# are not in node_modules. Point tsc at the global pi install instead of
# bundling a copy.
set -euo pipefail
cd "$(dirname "$0")/.."

PI_ROOT="${PI_ROOT:-$(npm root -g)/@earendil-works/pi-coding-agent}"
[[ -d "$PI_ROOT/dist" ]] || { echo "pi not found at $PI_ROOT (set PI_ROOT)" >&2; exit 1; }

TMP=".tsconfig.typecheck.json"
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" <<EOF
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@earendil-works/pi-coding-agent": ["$PI_ROOT/dist/index.d.ts"],
      "@earendil-works/pi-ai": ["$PI_ROOT/node_modules/@earendil-works/pi-ai/dist/index.d.ts"],
      "typebox": ["$PI_ROOT/node_modules/typebox/build/index.d.mts"]
    }
  }
}
EOF
npx tsc --noEmit -p "$TMP" "$@"
echo "typecheck ok"
