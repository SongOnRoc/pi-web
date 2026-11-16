#!/usr/bin/env sh
# Build this fork and install it as the global `pi-web`, for iterating on the
# question card without waiting for CI.
#
#   ./scripts/ask-install.sh            build if sources changed, then install
#   ./scripts/ask-install.sh --force    always rebuild
#   ./scripts/ask-install.sh --no-build install the existing .next as-is
#
# Not a package.json `prepare` script on purpose: `prepare` runs on every
# `npm install`, and `AGENTS.md` says `next build` must not run during
# development — it replaces `.next` with production output and breaks
# `npm run dev`. This only runs when asked.
#
# `npm install -g` over an existing install replaces it; there is no separate
# uninstall step, and no stale files are left behind.

set -eu

cd "$(dirname "$0")/.."

FORCE=0
BUILD=1
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# The sources that end up in a build. Anything here changing means a rebuild;
# a change confined to tests or docs does not.
needs_build() {
  [ -f .next/BUILD_ID ] || return 0
  [ "$FORCE" = 1 ] && return 0
  # Newer than the last build?
  newer=$(find app components hooks lib public bin next.config.ts package.json \
    -newer .next/BUILD_ID -type f 2>/dev/null | head -1)
  [ -n "$newer" ]
}

if [ "$BUILD" = 1 ]; then
  if needs_build; then
    echo "building (this takes about 3.5 minutes)…"
    if ! npm run build > /tmp/pi-web-ask-build.log 2>&1; then
      echo "build failed; see /tmp/pi-web-ask-build.log" >&2
      tail -20 /tmp/pi-web-ask-build.log >&2
      exit 1
    fi
  else
    echo "no source changes since the last build (use --force to rebuild)"
  fi
elif [ ! -f .next/BUILD_ID ]; then
  echo "no build found; drop --no-build" >&2
  exit 1
fi

# A cheap guard: the card's tests and the type check catch a rename upstream made
# that would leave the tool registered but broken.
if [ "$BUILD" = 1 ]; then
  echo "testing the card…"
  node --experimental-strip-types --test \
    lib/ask-question.test.mjs \
    lib/ask-question-runtime.test.mjs \
    components/AskQuestionPanel.test.mjs > /tmp/pi-web-ask-test.log 2>&1 || {
      echo "tests failed; see /tmp/pi-web-ask-test.log" >&2
      tail -30 /tmp/pi-web-ask-test.log >&2
      exit 1
    }
fi

echo "packing…"
packed=$(npm pack 2>/dev/null | tail -1)
short=$(git rev-parse --short HEAD)
dirty=""
git diff --quiet 2>/dev/null || dirty="-dirty"
target="pi-web-ask-${short}${dirty}.tgz"
mv "$packed" "$target"

echo "installing $target…"
# npm 11+ refuses install scripts unless named; node-pty builds its native addon
# in one. Older npm rejects the flag, so retry without it rather than fail.
if ! npm install -g "./$target" \
  --allow-scripts=@agegr/pi-web,node-pty,@google/genai,protobufjs > /tmp/pi-web-ask-install.log 2>&1; then
  if ! npm install -g "./$target" > /tmp/pi-web-ask-install.log 2>&1; then
    echo "install failed; see /tmp/pi-web-ask-install.log" >&2
    tail -20 /tmp/pi-web-ask-install.log >&2
    exit 1
  fi
fi

rm -f "./$target"

version=$(node -p "require('./package.json').version")
echo
echo "installed: pi-web $version (${short}${dirty})"
echo "restart any running pi-web to pick it up:"
echo "  pi-web"
