#!/usr/bin/env python3
"""Build one self-contained, platform-specific Home Node Lite release."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import platform
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENTRYPOINTS = {
    "core.cjs": ROOT / "apps/home-node-lite/core-server/src/bin.ts",
    "brain.cjs": ROOT / "apps/home-node-lite/brain-server/src/bin.ts",
    "archive.cjs": ROOT
    / "apps/home-node-lite/core-server/src/storage/archive_tool.ts",
}
NATIVE_PACKAGES = (
    "better-sqlite3-multiple-ciphers",
    "bindings",
    "file-uri-to-path",
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--out-dir", type=Path, default=ROOT / "dist/home-node-native")
    parser.add_argument(
        "--node",
        type=Path,
        help="Node runtime to bundle (default: current node executable)",
    )
    args = parser.parse_args()

    node = (args.node or current_node()).expanduser().resolve()
    node_info = json.loads(
        subprocess.check_output(
            [
                str(node),
                "-e",
                "process.stdout.write(JSON.stringify({"
                "platform:process.platform,arch:process.arch,"
                "major:Number(process.versions.node.split('.')[0])}))",
            ],
            cwd=ROOT,
            text=True,
        )
    )
    if node_info["major"] < 22:
        raise SystemExit("Home Node release builds require Node.js 22 or newer")
    if node_info["platform"] not in {"darwin", "linux", "win32"}:
        raise SystemExit(f"unsupported Node platform: {node_info['platform']}")
    if node_info["arch"] not in {"x64", "arm64"}:
        raise SystemExit(f"unsupported Node architecture: {node_info['arch']}")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    asset = (
        args.out_dir
        / f"dina-home-node-lite-{node_info['platform']}-{node_info['arch']}.tar.gz"
    )
    with tempfile.TemporaryDirectory(prefix="dina-hnl-native-") as temp_name:
        staging = Path(temp_name)
        build_entrypoints(staging)
        runtime_name = "node.exe" if node_info["platform"] == "win32" else "node"
        runtime_target = staging / "runtime" / runtime_name
        runtime_target.parent.mkdir(parents=True)
        shutil.copy2(node, runtime_target)
        copy_node_license(node, staging / "runtime" / "NODE_LICENSE")
        copy_native_packages(staging / "node_modules")
        validate_bundled_runtime(runtime_target, staging)

        files = {
            path.relative_to(staging).as_posix(): sha256(path)
            for path in sorted(staging.rglob("*"))
            if path.is_file()
        }
        manifest = {
            "schema": 1,
            "release": args.version,
            "platform": node_info["platform"],
            "arch": node_info["arch"],
            "node_major": node_info["major"],
            "node_entrypoint": f"runtime/{runtime_name}",
            "core_entrypoint": "core.cjs",
            "brain_entrypoint": "brain.cjs",
            "archive_entrypoint": "archive.cjs",
            "files": files,
        }
        (staging / "manifest.json").write_text(
            json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        write_deterministic_tar(staging, asset)

    digest = sha256(asset)
    asset.with_suffix(asset.suffix + ".sha256").write_text(
        f"{digest}  {asset.name}\n",
        encoding="ascii",
    )
    print(asset)
    print(f"sha256:{digest}")
    return 0


def current_node() -> Path:
    executable = shutil.which("node")
    if executable is None:
        raise SystemExit("node was not found on PATH")
    resolved = subprocess.check_output(
        [executable, "-p", "process.execPath"],
        cwd=ROOT,
        text=True,
    ).strip()
    return Path(resolved)


def build_entrypoints(staging: Path) -> None:
    esbuild = ROOT / "node_modules/.bin/esbuild"
    if os.name == "nt":
        esbuild = esbuild.with_suffix(".cmd")
    if not esbuild.exists():
        raise SystemExit("esbuild is missing; run npm ci first")
    for output, source in ENTRYPOINTS.items():
        subprocess.run(
            [
                str(esbuild),
                str(source),
                "--bundle",
                "--platform=node",
                "--target=node22",
                "--format=cjs",
                f"--outfile={staging / output}",
                "--external:better-sqlite3-multiple-ciphers",
                "--legal-comments=linked",
            ],
            cwd=ROOT,
            check=True,
        )


def copy_native_packages(destination: Path) -> None:
    destination.mkdir(parents=True)
    for package in NATIVE_PACKAGES:
        source = ROOT / "node_modules" / package
        if not source.is_dir():
            raise SystemExit(f"required native runtime package is missing: {package}")
        target = destination / package
        if package == "better-sqlite3-multiple-ciphers":
            target.mkdir()
            for name in ("package.json", "LICENSE", "index.d.ts"):
                if (source / name).is_file():
                    shutil.copy2(source / name, target / name)
            shutil.copytree(source / "lib", target / "lib")
            binding = source / "build/Release/better_sqlite3.node"
            if not binding.is_file():
                raise SystemExit(
                    "better-sqlite3-multiple-ciphers native binding is missing; "
                    "run npm ci with the release Node runtime"
                )
            (target / "build/Release").mkdir(parents=True)
            shutil.copy2(binding, target / "build/Release/better_sqlite3.node")
        else:
            shutil.copytree(
                source,
                target,
                ignore=shutil.ignore_patterns(
                    "test",
                    "tests",
                    ".github",
                    "*.md",
                    ".npmignore",
                ),
            )


def copy_node_license(node: Path, destination: Path) -> None:
    candidates = (
        node.parent.parent / "LICENSE",
        node.parent.parent / "share/doc/node/LICENSE",
        node.parent.parent.parent / "LICENSE",
    )
    for candidate in candidates:
        if candidate.is_file():
            shutil.copy2(candidate, destination)
            return
    raise SystemExit(
        f"could not locate the Node.js LICENSE next to bundled runtime {node}"
    )


def validate_bundled_runtime(node: Path, staging: Path) -> None:
    """Fail the release if Node and the native SQLCipher binding disagree."""
    script = """
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("./node_modules/better-sqlite3-multiple-ciphers");
const file = path.join(
  os.tmpdir(),
  `dina-native-release-${process.pid}-${Date.now()}.sqlite`,
);
try {
  let db = new Database(file);
  db.pragma("cipher = 'sqlcipher'");
  db.pragma("cipher_compatibility = 4");
  db.pragma("key = 'dina-release-abi-check'");
  db.exec("CREATE TABLE proof(value TEXT NOT NULL)");
  db.prepare("INSERT INTO proof(value) VALUES (?)").run("encrypted");
  db.close();

  const header = fs.readFileSync(file).subarray(0, 16).toString("binary");
  if (header === "SQLite format 3\\u0000") {
    throw new Error("SQLCipher binding wrote a plaintext SQLite header");
  }

  db = new Database(file);
  db.pragma("cipher = 'sqlcipher'");
  db.pragma("cipher_compatibility = 4");
  db.pragma("key = 'dina-release-abi-check'");
  const row = db.prepare("SELECT value FROM proof").get();
  db.close();
  if (row?.value !== "encrypted") {
    throw new Error("SQLCipher encrypted round trip failed");
  }
} finally {
  fs.rmSync(file, {force: true});
}
"""
    subprocess.run(
        [str(node), "-e", script],
        cwd=staging,
        check=True,
    )


def write_deterministic_tar(staging: Path, destination: Path) -> None:
    epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))
    temp = destination.with_name(f".{destination.name}.tmp")
    with temp.open("wb") as raw:
        with gzip.GzipFile(
            filename="",
            mode="wb",
            fileobj=raw,
            mtime=epoch,
        ) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as tar:
                for path in sorted(staging.rglob("*")):
                    if not path.is_file():
                        continue
                    relative = path.relative_to(staging).as_posix()
                    info = tar.gettarinfo(str(path), arcname=relative)
                    info.uid = 0
                    info.gid = 0
                    info.uname = ""
                    info.gname = ""
                    info.mtime = epoch
                    info.mode = 0o500 if relative.startswith("runtime/node") else 0o400
                    with path.open("rb") as stream:
                        tar.addfile(info, stream)
        raw.flush()
        os.fsync(raw.fileno())
    os.replace(temp, destination)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
