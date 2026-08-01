#!/usr/bin/env bash
# component_version.sh — believable per-component versioning.
#
# Binds each deployable component folder (msgbox/, appview/, cli/) to a
# content digest derived from git itself, via a tiny committed manifest:
#
#   <component>/.release
#     version=1.2.3
#     tree=8a31c92f04e1        # digest of the folder, EXCLUDING this file
#
# The digest is sha256 over the sorted "blobhash<TAB>path" lines of the
# folder's tracked files (index or HEAD), truncated to 12 hex chars. Git's
# blob hashes are content-addressed, so this is deterministic across
# machines and ignores untracked/tmp files by construction.
#
# The binding is enforced in three places:
#   * pre-commit hook  → content changed but version didn't → commit fails
#   * deploy script    → refuses to ship a folder whose binding is broken
#   * publish wrapper  → same, for the PyPI package
#
# Usage:
#   component_version.sh hash      <dir> [--index|--head]   # print digest
#   component_version.sh stamp     <dir>                    # print "version tree dirty"
#   component_version.sh check     <dir> [--index|--head]   # verify binding (exit 2 = broken)
#   component_version.sh precommit <dir>                    # hook mode: heal-or-fail (see below)
#
# precommit exit codes: 0 ok/healed, 2 content changed without version bump.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

ACTION="${1:-}"
DIR="${2:-}"
MODE="${3:---index}"

[ -n "$ACTION" ] && [ -n "$DIR" ] || {
    echo "usage: $0 <hash|stamp|check|precommit> <component-dir> [--index|--head]" >&2
    exit 1
}
DIR="${DIR%/}"

sha_cmd() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi }

# ── digest of tracked content, excluding the manifest itself ──
tree_digest() {
    local mode="$1"
    local lines
    if [ "$mode" = "--head" ]; then
        # ls-tree: "<mode> <type> <hash>\t<path>"
        lines=$(git ls-tree -r HEAD -- "$DIR" | awk -F'\t' -v m="$DIR/.release" '$2 != m { split($1, a, " "); print a[3] "\t" $2 }')
    else
        # ls-files -s: "<mode> <hash> <stage>\t<path>"
        lines=$(git ls-files -s -- "$DIR" | awk -F'\t' -v m="$DIR/.release" '$2 != m { split($1, a, " "); print a[2] "\t" $2 }')
    fi
    printf '%s\n' "$lines" | LC_ALL=C sort | sha_cmd | cut -c1-12
}

manifest_field() {
    # $1 = manifest text, $2 = field
    printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -1
}

staged_manifest() { git show ":$DIR/.release" 2>/dev/null || cat "$DIR/.release" 2>/dev/null || true; }
head_manifest()   { git show "HEAD:$DIR/.release" 2>/dev/null || true; }

# ── secondary version sources that must agree with the manifest ──
declared_version() {
    case "$DIR" in
        cli)     sed -n 's/^version = "\(.*\)"$/\1/p' cli/pyproject.toml | head -1 ;;
        appview) sed -n 's/.*"version": "\(.*\)".*/\1/p' appview/package.json | head -1 ;;
        *)       echo "" ;;
    esac
}

# Every place a component declares its version must agree — the cli has TWO
# (pyproject + __init__.__version__; the wheel metadata reads the former,
# `dina --version` the latter, so drift ships a self-contradicting package).
# Returns non-zero with a message when any pair disagrees.
cross_check_versions() {
    if [ "$DIR" = "cli" ]; then
        local pv iv
        pv=$(sed -n 's/^version = "\(.*\)"$/\1/p' cli/pyproject.toml | head -1)
        iv=$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' cli/src/dina_cli/__init__.py | head -1)
        if [ "$pv" != "$iv" ]; then
            echo "error: cli version split-brain: pyproject.toml=$pv but __init__.py __version__=$iv" >&2
            echo "       sync both, then re-commit." >&2
            return 2
        fi
    fi
    return 0
}

is_dirty() { [ -n "$(git status --porcelain -- "$DIR")" ]; }

case "$ACTION" in
    hash)
        tree_digest "$MODE"
        ;;

    stamp)
        m=$(head_manifest)
        [ -n "$m" ] || { echo "error: no committed $DIR/.release" >&2; exit 3; }
        v=$(manifest_field "$m" version)
        t=$(manifest_field "$m" tree)
        d=0; is_dirty && d=1
        echo "$v $t $d"
        ;;

    check)
        m=$( [ "$MODE" = "--head" ] && head_manifest || staged_manifest )
        [ -n "$m" ] || { echo "error: $DIR/.release missing ($MODE)" >&2; exit 3; }
        want=$(manifest_field "$m" tree)
        have=$(tree_digest "$MODE")
        if [ "$want" != "$have" ]; then
            echo "error: $DIR binding broken: manifest tree=$want, actual=$have" >&2
            echo "       content changed without a version bump (or manifest is stale)." >&2
            exit 2
        fi
        dv=$(declared_version)
        mv=$(manifest_field "$m" version)
        if [ -n "$dv" ] && [ "$dv" != "$mv" ]; then
            echo "error: $DIR version drift: .release=$mv but package metadata=$dv" >&2
            exit 2
        fi
        cross_check_versions
        ;;

    precommit)
        cross_check_versions || exit 2
        idx=$(tree_digest --index)
        sm=$(staged_manifest)
        hm=$(head_manifest)
        sv=$(manifest_field "$sm" version)
        st=$(manifest_field "$sm" tree)
        hv=$(manifest_field "$hm" version)

        # keep .release in lockstep with package metadata when both staged
        dv=$(declared_version)
        if [ -n "$dv" ] && [ -n "$sv" ] && [ "$dv" != "$sv" ]; then
            # metadata is authoritative for cli/appview: adopt it
            sv="$dv"
        fi

        if [ -z "$sm" ] && [ -z "$hm" ]; then
            # first-time adoption: create the manifest at the declared (or 1.0.0) version
            sv="${dv:-1.0.0}"
            printf 'version=%s\ntree=%s\n' "$sv" "$idx" > "$DIR/.release"
            git add "$DIR/.release"
            echo "created $DIR/.release (version=$sv tree=$idx)"
            exit 0
        fi

        if [ "$st" = "$idx" ] && [ "$sv" = "$(manifest_field "$sm" version)" ]; then
            exit 0   # binding already correct
        fi

        if [ -z "$hm" ] || [ "$sv" != "$hv" ]; then
            # version was bumped (or no committed baseline): heal the tree pin
            printf 'version=%s\ntree=%s\n' "$sv" "$idx" > "$DIR/.release"
            git add "$DIR/.release"
            echo "$DIR/.release healed (version=$sv tree=$idx)"
            exit 0
        fi

        echo "" >&2
        echo "✗ $DIR content changed but its version was not bumped." >&2
        echo "  committed version: $hv   (tree pin now stale: $st → $idx)" >&2
        case "$DIR" in
            cli)     echo "  bump: cli/pyproject.toml + cli/src/dina_cli/__init__.py, then re-commit." >&2 ;;
            appview) echo "  bump: appview/package.json \"version\", then re-commit." >&2 ;;
            *)       echo "  bump: version= in $DIR/.release, then re-commit." >&2 ;;
        esac
        exit 2
        ;;

    *)
        echo "unknown action: $ACTION" >&2
        exit 1
        ;;
esac
