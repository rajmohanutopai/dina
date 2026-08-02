#!/usr/bin/env bash
# publish_plugins.sh — gated publish of the customer-facing plugin marketplace.
#
# The Dina monorepo is the source of truth for both coding-agent plugins.
# Customers install from the small mirror repo (rajmohanutopai/dina-plugins)
# so a plugin release is a deliberate act, installs stay light, and the code
# a cautious user audits is only the plugin itself.
#
# The mirror preserves monorepo paths (cli/claude-plugin, cli/codex-plugin,
# .claude-plugin, .agents), so both marketplace manifests ship verbatim —
# no path rewriting, no drift.
#
# Gates, before anything leaves the machine:
#   1. cli/ working tree must be clean (mirror ships committed code only).
#   2. cli/.release binding must be valid at HEAD.
#   3. All three dina-setup-bootstrap copies must be byte-identical.
#   4. The wheel the bootstrap pins must be live on PyPI with the same sha256.
# Then builds the mirror tree from `git archive HEAD`, stamps provenance
# (.source), and pushes only when content actually changed.
#
# Usage: scripts/release/publish_plugins.sh [--dry-run]
#   DINA_PLUGINS_REMOTE overrides the mirror remote (default: derived from
#   origin by replacing the repository name with dina-plugins).

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
CVS="$REPO_ROOT/scripts/release/component_version.sh"
DRY="${1:-}"

BOOTSTRAP="cli/agent-plugin-runtime/dina-setup-bootstrap"
COPIES=(
    "cli/claude-plugin/dina/bin/dina-setup-bootstrap"
    "cli/codex-plugin/plugins/dina/bin/dina-setup-bootstrap"
)
MIRROR_PATHS=(cli/claude-plugin cli/codex-plugin .claude-plugin .agents LICENSE)

# ── Gate 1: clean tree ──
if [ -n "$(git status --porcelain -- cli/ .claude-plugin/ .agents/)" ]; then
    echo "✗ plugin sources are dirty — commit first; the mirror ships committed code only." >&2
    git status --short -- cli/ .claude-plugin/ .agents/ >&2
    exit 1
fi

# ── Gate 2: binding valid at HEAD ──
"$CVS" check cli --head
read -r CLI_VERSION CLI_TREE _ <<< "$("$CVS" stamp cli)"

# ── Gate 3: bootstrap copies identical ──
for copy in "${COPIES[@]}"; do
    cmp -s "$BOOTSTRAP" "$copy" || {
        echo "✗ $copy differs from $BOOTSTRAP — sync the copies before publishing." >&2
        exit 1
    }
done

# ── Gate 4: the pinned wheel is live on PyPI under the pinned sha ──
PIN_FILE="$(sed -n 's/.*"\(dina_agent-.*-py3-none-any\.whl\)".*/\1/p' "$BOOTSTRAP" | head -1)"
PIN_VERSION="$(printf '%s\n' "$PIN_FILE" | sed -n 's/^dina_agent-\(.*\)-py3-none-any\.whl$/\1/p')"
PIN_SHA="$(sed -n 's/^DINA_WHEEL_SHA256 = "\([0-9a-f]\{64\}\)"$/\1/p' "$BOOTSTRAP")"
[ -n "$PIN_VERSION" ] && [ -n "$PIN_SHA" ] || {
    echo "✗ could not read the wheel pin from $BOOTSTRAP" >&2
    exit 1
}
if ! curl -fsS "https://pypi.org/pypi/dina-agent/$PIN_VERSION/json" | grep -q "\"sha256\": \"$PIN_SHA\""; then
    echo "✗ bootstrap pins dina-agent $PIN_VERSION sha256 $PIN_SHA, but PyPI does not serve that artifact." >&2
    echo "  publish the wheel first (scripts/release/publish_cli.sh), then update the pin." >&2
    exit 1
fi
echo "▸ pin verified: dina-agent $PIN_VERSION ($PIN_SHA) is live on PyPI"

# ── Build the mirror tree from committed content ──
SRC_COMMIT="$(git rev-parse HEAD)"
STAGE="$(mktemp -d)"
WORK="$(mktemp -d)"
cleanup() { rm -rf "$STAGE" "$WORK"; }
trap cleanup EXIT

git archive HEAD "${MIRROR_PATHS[@]}" | tar -x -C "$STAGE"
rm -rf "$STAGE/cli/claude-plugin/e2e"   # monorepo test harness, not for customers

cat > "$STAGE/README.md" <<EOF
# Dina — coding-agent plugins

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
\`scripts/release/publish_plugins.sh\`. Do not open pull requests here — send
changes to the main repository. \`.source\` records the exact source commit
and the version binding of every publication.
EOF

cat > "$STAGE/.source" <<EOF
source_repo=https://github.com/rajmohanutopai/dina
source_commit=$SRC_COMMIT
cli_version=$CLI_VERSION
cli_tree=$CLI_TREE
pinned_wheel=dina-agent==$PIN_VERSION
pinned_wheel_sha256=$PIN_SHA
EOF

# ── Publish ──
ORIGIN_URL="$(git remote get-url origin)"
REMOTE="${DINA_PLUGINS_REMOTE:-$(printf '%s\n' "$ORIGIN_URL" | sed 's|/dina\(\.git\)\{0,1\}$|/dina-plugins.git|')}"
[ "$REMOTE" != "$ORIGIN_URL" ] || {
    echo "✗ could not derive the mirror remote from origin ($ORIGIN_URL); set DINA_PLUGINS_REMOTE." >&2
    exit 1
}

git clone --quiet --depth 1 "$REMOTE" "$WORK"
find "$WORK" -mindepth 1 -maxdepth 1 -name .git -prune -o -exec rm -rf {} +
cp -R "$STAGE"/. "$WORK"/

if [ -z "$(git -C "$WORK" status --porcelain)" ]; then
    echo "✓ mirror already current (dina@${SRC_COMMIT:0:8}, dina-agent $CLI_VERSION)"
    exit 0
fi

git -C "$WORK" add -A
if [ "$DRY" = "--dry-run" ]; then
    echo "▸ dry run — would publish:"
    git -C "$WORK" diff --cached --stat | tail -20
    exit 0
fi

git -C "$WORK" commit --quiet -m "Sync from dina@${SRC_COMMIT:0:8} (cli $CLI_VERSION, tree $CLI_TREE, wheel $PIN_VERSION)"
git -C "$WORK" push --quiet origin HEAD
echo "✓ published dina-plugins from dina@${SRC_COMMIT:0:8} (cli $CLI_VERSION, pinned wheel $PIN_VERSION)"
