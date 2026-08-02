#!/usr/bin/env bash
# publish_plugins.sh - gated publish of the customer-facing plugin marketplace.
#
# The Dina monorepo is the only source of truth. The small dina-plugins repo is
# an immutable, generated release mirror used by Claude Code and Codex.
#
# Gates, before anything leaves the machine:
#   1. The whole source tree is clean and HEAD is the fetched public main.
#   2. cli/.release binding and focused plugin package tests pass.
#   3. All three dina-setup-bootstrap copies are byte-identical.
#   4. The exact pinned wheel is live on PyPI under the pinned sha256.
#   5. Matching signed Home Node archives exist for every supported platform.
#   6. Both staged marketplaces validate and share a new plugin version.
# Then builds the mirror tree from `git archive HEAD`, stamps provenance, and
# atomically pushes the branch plus an immutable plugins-vX.Y.Z tag.
#
# Usage: scripts/release/publish_plugins.sh [--dry-run]
#   DINA_PLUGINS_REMOTE overrides the mirror remote (default: derived from
#   origin by replacing the repository name with dina-plugins). The override
#   must still identify the rajmohanutopai/dina-plugins repository.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
CVS="$REPO_ROOT/scripts/release/component_version.sh"
GUARD="$REPO_ROOT/scripts/release/plugin_publish_guard.py"
DRY=0

if [ -n "${DINA_RELEASE_PYTHON:-}" ]; then
    PYTHON="$DINA_RELEASE_PYTHON"
elif [ -x "$REPO_ROOT/.venv/bin/python" ]; then
    PYTHON="$REPO_ROOT/.venv/bin/python"
else
    PYTHON="$(command -v python3 || true)"
fi
if [ -n "$PYTHON" ]; then
    PYTHON="$(command -v "$PYTHON" || true)"
fi
[ -n "$PYTHON" ] || {
    echo "error: Python 3 is required; set DINA_RELEASE_PYTHON." >&2
    exit 1
}

usage() {
    echo "usage: scripts/release/publish_plugins.sh [--dry-run]" >&2
}

case "$#" in
    0) ;;
    1)
        if [ "$1" != "--dry-run" ]; then
            usage
            exit 64
        fi
        DRY=1
        ;;
    *)
        usage
        exit 64
        ;;
esac

BOOTSTRAP="cli/agent-plugin-runtime/dina-setup-bootstrap"
COPIES=(
    "cli/claude-plugin/dina/bin/dina-setup-bootstrap"
    "cli/codex-plugin/plugins/dina/bin/dina-setup-bootstrap"
)
MIRROR_PATHS=(cli/claude-plugin cli/codex-plugin .claude-plugin .agents LICENSE)

# Gate 1: clean source and publicly auditable commit.
if [ -n "$(git status --porcelain)" ]; then
    echo "error: source tree is dirty; commit before publishing." >&2
    git status --short >&2
    exit 1
fi

ORIGIN_URL="$(git remote get-url origin)"
"$PYTHON" "$GUARD" validate-remote \
    --remote "$ORIGIN_URL" \
    --expected-slug rajmohanutopai/dina
git fetch --quiet origin refs/heads/main:refs/remotes/origin/main
SRC_COMMIT="$(git rev-parse HEAD)"
PUBLIC_COMMIT="$(git rev-parse refs/remotes/origin/main)"
if [ "$SRC_COMMIT" != "$PUBLIC_COMMIT" ]; then
    echo "error: HEAD is not the fetched public origin/main." >&2
    echo "  HEAD:        $SRC_COMMIT" >&2
    echo "  origin/main: $PUBLIC_COMMIT" >&2
    echo "  push the reviewed source commit before publishing its mirror." >&2
    exit 1
fi

command -v gh >/dev/null 2>&1 || {
    echo "error: GitHub CLI is required to verify source CI." >&2
    exit 1
}
if ! CI_JSON="$(gh run list \
    --repo rajmohanutopai/dina \
    --commit "$SRC_COMMIT" \
    --workflow cli-plugin-test.yml \
    --json status,conclusion,headSha \
    --limit 1)"; then
    echo "error: cannot read plugin CI status from GitHub." >&2
    exit 1
fi
if ! printf '%s' "$CI_JSON" | "$PYTHON" "$GUARD" verify-ci-run \
    --source-commit "$SRC_COMMIT"; then
    echo "error: wait for the plugin CI workflow to pass before publishing." >&2
    exit 1
fi
echo "verified: plugin CI passed for dina@${SRC_COMMIT:0:8}"

# Gate 2: component binding and focused package/release tests.
"$CVS" check cli --head
read -r CLI_VERSION CLI_TREE _ <<< "$("$CVS" stamp cli)"
if ! "$PYTHON" -c 'import pytest' >/dev/null 2>&1; then
    echo "error: pytest is required; install ./cli[dev] or set DINA_RELEASE_PYTHON." >&2
    exit 1
fi
"$PYTHON" -m pytest \
    cli/tests/test_claude_plugin_package.py \
    cli/tests/test_codex_plugin_package.py \
    scripts/release/test_plugin_publish_guard.py \
    -q

# Gate 3: managed bootstrap copies must match their source exactly.
for copy in "${COPIES[@]}"; do
    cmp -s "$BOOTSTRAP" "$copy" || {
        echo "error: $copy differs from $BOOTSTRAP; sync before publishing." >&2
        exit 1
    }
done

# Gate 4: verify the exact non-yanked wheel, not merely any wheel with the hash.
PIN_FILE="$(sed -n 's/.*"\(dina_agent-.*-py3-none-any\.whl\)".*/\1/p' "$BOOTSTRAP" | head -1)"
PIN_VERSION="$(printf '%s\n' "$PIN_FILE" | sed -n 's/^dina_agent-\(.*\)-py3-none-any\.whl$/\1/p')"
PIN_SHA="$(sed -n 's/^DINA_WHEEL_SHA256 = "\([0-9a-f]\{64\}\)"$/\1/p' "$BOOTSTRAP")"
[ -n "$PIN_VERSION" ] && [ -n "$PIN_SHA" ] || {
    echo "error: could not read the wheel pin from $BOOTSTRAP" >&2
    exit 1
}
if ! PYPI_JSON="$(curl -fsS "https://pypi.org/pypi/dina-agent/$PIN_VERSION/json")"; then
    echo "error: cannot fetch dina-agent $PIN_VERSION metadata from PyPI." >&2
    exit 1
fi
if ! printf '%s' "$PYPI_JSON" | "$PYTHON" "$GUARD" verify-wheel \
    --filename "$PIN_FILE" --sha256 "$PIN_SHA"; then
    echo "error: bootstrap wheel pin is not exactly reproducible from PyPI." >&2
    echo "  publish the wheel first, then update the bootstrap pin." >&2
    exit 1
fi
echo "verified: $PIN_FILE ($PIN_SHA) is live on PyPI"

# Gate 5: the installer must have a signed native bundle on every platform.
RELEASE_TAG="home-node-lite-v$PIN_VERSION"
if ! RELEASE_JSON="$(gh api \
    "repos/rajmohanutopai/dina/releases/tags/$RELEASE_TAG")"; then
    echo "error: cannot fetch GitHub release $RELEASE_TAG." >&2
    exit 1
fi
if ! printf '%s' "$RELEASE_JSON" | "$PYTHON" "$GUARD" \
    verify-native-release --version "$PIN_VERSION"; then
    echo "error: $RELEASE_TAG is missing, incomplete, draft, or prerelease." >&2
    echo "  publish all native Home Node archives and signatures first." >&2
    exit 1
fi
echo "verified: $RELEASE_TAG covers every supported platform"

# Build only from committed content, never from the working directory.
STAGE="$(mktemp -d)"
WORK="$(mktemp -d)"
CLAUDE_STATE="$(mktemp -d)"
CODEX_STATE="$(mktemp -d)"
cleanup() { rm -rf "$STAGE" "$WORK" "$CLAUDE_STATE" "$CODEX_STATE"; }
trap cleanup EXIT

git archive HEAD "${MIRROR_PATHS[@]}" | tar -x -C "$STAGE"
rm -rf "$STAGE/cli/claude-plugin/e2e"

cat > "$STAGE/README.md" <<EOF
# Dina - coding-agent plugins

Marketplace for the Dina plugins: a Core-owned deterministic safety gate on
every tool call, plus encrypted personal memory, services, approvals, intent
validation, and local PII scrubbing over MCP. Your data lives in your own
Home Node; the plugin installs and manages it.

## Claude Code

\`\`\`text
/plugin marketplace add rajmohanutopai/dina-plugins
/plugin install dina@dina
/dina:setup
\`\`\`

Details: [cli/claude-plugin/dina/README.md](cli/claude-plugin/dina/README.md)

## Codex

\`\`\`bash
codex plugin marketplace add rajmohanutopai/dina-plugins
codex plugin add dina@dina
\`\`\`

Then say **Set up Dina**. Details:
[cli/codex-plugin/plugins/dina/README.md](cli/codex-plugin/plugins/dina/README.md)

## About this repository

This is a release mirror of the plugin directories in
[rajmohanutopai/dina](https://github.com/rajmohanutopai/dina), published by
\`scripts/release/publish_plugins.sh\`. Do not open pull requests here; send
changes to the main repository. The \`main\` branch is publisher-owned and each
release has an immutable \`plugins-vX.Y.Z\` tag. \`.source\` records the exact
public source commit, payload digest, and runtime artifacts of every release.
EOF

PLUGIN_VERSION="$("$PYTHON" "$GUARD" validate-stage --root "$STAGE")"
PAYLOAD_DIGEST="$("$PYTHON" "$GUARD" payload-digest --root "$STAGE")"

# Validate and install the exact staged tree through both customer host CLIs.
command -v claude >/dev/null 2>&1 || {
    echo "error: Claude Code is required for staged plugin validation." >&2
    exit 1
}
command -v codex >/dev/null 2>&1 || {
    echo "error: Codex is required for staged plugin validation." >&2
    exit 1
}
CLAUDE_CONFIG_DIR="$CLAUDE_STATE" \
    claude plugin validate --strict "$STAGE/cli/claude-plugin/dina"
CLAUDE_CONFIG_DIR="$CLAUDE_STATE" claude plugin validate --strict "$STAGE"
CLAUDE_CONFIG_DIR="$CLAUDE_STATE" \
    claude plugin marketplace add "$STAGE" --scope user >/dev/null
CLAUDE_CONFIG_DIR="$CLAUDE_STATE" \
    claude plugin install dina@dina --scope user >/dev/null
CLAUDE_CONFIG_DIR="$CLAUDE_STATE" claude plugin list --json | \
    "$PYTHON" "$GUARD" verify-claude-install --version "$PLUGIN_VERSION"

CODEX_HOME="$CODEX_STATE" codex plugin marketplace add "$STAGE" --json >/dev/null
CODEX_HOME="$CODEX_STATE" codex plugin add dina@dina --json | \
    "$PYTHON" "$GUARD" verify-codex-install --version "$PLUGIN_VERSION"
echo "verified: staged plugin installs in Claude Code and Codex"

# Validate the destination by repository identity before destructive staging.
REMOTE="${DINA_PLUGINS_REMOTE:-$(printf '%s\n' "$ORIGIN_URL" | sed 's|/dina\(\.git\)\{0,1\}$|/dina-plugins.git|')}"
"$PYTHON" "$GUARD" validate-remote \
    --remote "$REMOTE" \
    --expected-slug rajmohanutopai/dina-plugins

git clone --quiet "$REMOTE" "$WORK"
if [ "$(git -C "$WORK" branch --show-current)" != "main" ]; then
    echo "error: mirror default branch must be main." >&2
    exit 1
fi

CURRENT_PLUGIN_VERSION="$("$PYTHON" "$GUARD" plugin-version --root "$WORK")"
if [ -n "$(git -C "$WORK" tag --list 'plugins-v*')" ]; then
    CURRENT_TAG="plugins-v$CURRENT_PLUGIN_VERSION"
    if ! git -C "$WORK" show-ref --verify --quiet "refs/tags/$CURRENT_TAG" || \
        [ "$(git -C "$WORK" rev-list -n 1 "$CURRENT_TAG")" != \
          "$(git -C "$WORK" rev-parse HEAD)" ]; then
        echo "error: mirror main is not pinned by its expected $CURRENT_TAG tag." >&2
        echo "  refuse to overwrite a mirror that may have been edited by hand." >&2
        exit 1
    fi
else
    echo "notice: accepting the legacy untagged mirror for its first tagged update"
fi

CURRENT_DIGEST="$("$PYTHON" "$GUARD" payload-digest --root "$WORK")"
if [ "$PAYLOAD_DIGEST" = "$CURRENT_DIGEST" ]; then
    echo "mirror payload already current (plugin $PLUGIN_VERSION, payload ${PAYLOAD_DIGEST:0:12})"
    exit 0
fi

# Gate 6: every customer-visible change gets a strictly newer immutable tag.
PLUGIN_VERSION="$("$PYTHON" "$GUARD" require-version-advance \
    --current-root "$WORK" \
    --staged-root "$STAGE")"
PLUGIN_TAG="plugins-v$PLUGIN_VERSION"
if git -C "$WORK" show-ref --verify --quiet "refs/tags/$PLUGIN_TAG"; then
    echo "error: immutable mirror tag $PLUGIN_TAG already exists." >&2
    exit 1
fi

cat > "$STAGE/.source" <<EOF
source_repo=https://github.com/rajmohanutopai/dina
source_commit=$SRC_COMMIT
plugin_version=$PLUGIN_VERSION
payload_sha256=$PAYLOAD_DIGEST
source_cli_version=$CLI_VERSION
cli_tree=$CLI_TREE
runtime_cli_version=$PIN_VERSION
pinned_wheel_file=$PIN_FILE
pinned_wheel_sha256=$PIN_SHA
native_release=$RELEASE_TAG
EOF

find "$WORK" -mindepth 1 -maxdepth 1 -name .git -prune -o -exec rm -rf {} +
cp -R "$STAGE"/. "$WORK"/

if [ -z "$(git -C "$WORK" status --porcelain)" ]; then
    echo "mirror already current"
    exit 0
fi

git -C "$WORK" add -A
if [ "$DRY" -eq 1 ]; then
    echo "dry run: would publish $PLUGIN_TAG"
    git -C "$WORK" diff --cached --stat | tail -20
    exit 0
fi

if [ -z "$(git -C "$WORK" config user.name)" ] || \
    [ -z "$(git -C "$WORK" config user.email)" ]; then
    echo "error: git user.name and user.email are required for the mirror release." >&2
    exit 1
fi

git -C "$WORK" commit --quiet \
    -m "Release plugins $PLUGIN_VERSION from dina@${SRC_COMMIT:0:8}"
git -C "$WORK" tag -a "$PLUGIN_TAG" \
    -m "Dina coding-agent plugins $PLUGIN_VERSION"
git -C "$WORK" push --quiet --atomic origin \
    HEAD:refs/heads/main "refs/tags/$PLUGIN_TAG"
echo "published $PLUGIN_TAG from dina@${SRC_COMMIT:0:8} (runtime $PIN_VERSION)"
