#!/usr/bin/env python3
"""Bundle OpenAPI spec with external $ref into a single self-contained file.

Reads core-api.yaml and components/schemas.yaml, merges shared schemas
into the spec's components/schemas section, rewrites $ref paths from
external (components/schemas.yaml#/Foo) to local (#/components/schemas/Foo),
and writes the bundled output.

Usage:
    python scripts/bundle_openapi.py [--out api/core-api.bundled.yaml]
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("pyyaml is required: pip install pyyaml")

ROOT = Path(__file__).resolve().parent.parent
API_DIR = ROOT / "api"
CORE_SPEC = API_DIR / "core-api.yaml"
SHARED_SCHEMAS = API_DIR / "components" / "schemas.yaml"


def load_yaml(path: Path) -> dict:
    with open(path) as f:
        return yaml.safe_load(f)


def rewrite_refs(obj, shared_names: set[str]):
    """Recursively rewrite $ref values to canonical #/components/schemas/ paths."""
    if isinstance(obj, dict):
        if "$ref" in obj:
            old = obj["$ref"]
            # External ref: components/schemas.yaml#/Foo → #/components/schemas/Foo
            if old.startswith("components/schemas.yaml#/"):
                name = old.split("#/", 1)[1]
                obj["$ref"] = f"#/components/schemas/{name}"
            # Internal ref from merged schemas: #/Foo → #/components/schemas/Foo
            # Only rewrite if Foo is a known shared schema name (not a deep path)
            elif old.startswith("#/") and not old.startswith("#/components/"):
                name = old[2:]  # strip "#/"
                if name in shared_names:
                    obj["$ref"] = f"#/components/schemas/{name}"
        for v in obj.values():
            rewrite_refs(v, shared_names)
    elif isinstance(obj, list):
        for item in obj:
            rewrite_refs(item, shared_names)


def bundle() -> dict:
    spec = load_yaml(CORE_SPEC)
    shared = load_yaml(SHARED_SCHEMAS)

    # Downgrade to 3.0.3 for oapi-codegen compatibility.
    spec["openapi"] = "3.0.3"

    # Merge shared schemas into spec's components/schemas.
    if "components" not in spec:
        spec["components"] = {}
    if "schemas" not in spec["components"]:
        spec["components"]["schemas"] = {}

    for name, schema in shared.items():
        if name not in spec["components"]["schemas"]:
            spec["components"]["schemas"][name] = schema

    # Rewrite $ref paths to canonical form.
    shared_names = set(shared.keys())
    rewrite_refs(spec, shared_names)

    # Fix 3.1-only features for 3.0.3 compatibility:
    # - Replace "type: string\nconst: X" with "type: string\nenum: [X]"
    fix_const(spec)

    return spec


def fix_const(obj):
    """Replace OpenAPI 3.1 'const' with 3.0 'enum: [value]'."""
    if isinstance(obj, dict):
        if "const" in obj:
            obj["enum"] = [obj.pop("const")]
        for v in obj.values():
            fix_const(v)
    elif isinstance(obj, list):
        for item in obj:
            fix_const(item)


def main():
    parser = argparse.ArgumentParser(description="Bundle OpenAPI spec")
    parser.add_argument(
        "--out", default=str(API_DIR / "core-api.bundled.yaml"),
        help="Output path (default: api/core-api.bundled.yaml)",
    )
    args = parser.parse_args()

    bundled = bundle()
    out = Path(args.out)
    with open(out, "w") as f:
        yaml.dump(bundled, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
    print(f"Bundled spec written to {out}")


if __name__ == "__main__":
    main()
