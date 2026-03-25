#!/usr/bin/env python3
"""Decrypt a Dina export archive — standalone, no Dina required.

Your data is yours. This script lets you read your exported data
without running Dina. No Dina installation required.

Dependencies: pip install argon2-cffi cryptography mnemonic pysqlcipher3

One command does everything:
    python3 decrypt_export.py archive.dina \\
        --passphrase <export-passphrase> \\
        --mnemonic "word1 word2 ... word24"

This will:
  1. Decrypt the archive (AES-256-GCM + Argon2id)
  2. Derive per-persona vault keys from your recovery phrase
  3. Open each SQLCipher database and export contents as readable JSON

Output:
    dina-export/
      manifest.json           — export metadata
      identity.sqlite         — raw encrypted database (if you want sqlcipher access)
      general.sqlite          — raw encrypted database
      identity_data.json      — contacts, reminders, settings (readable)
      general_data.json       — your memories, notes (readable)
      health_data.json        — health records (readable)
      ...

You can also run individual steps:
    # Just decrypt the archive (no vault opening):
    python3 decrypt_export.py archive.dina --passphrase <pass>

    # Just derive keys (to use with sqlcipher manually):
    python3 decrypt_export.py --derive-keys --mnemonic "word1 word2 ... word24"
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys


# ---------------------------------------------------------------------------
# Archive decryption (Argon2id + AES-256-GCM)
# ---------------------------------------------------------------------------

ARCHIVE_HEADER = b"DINA_ARCHIVE_V2\n"
ARGON2_TIME = 3
ARGON2_MEMORY = 128 * 1024
ARGON2_THREADS = 4
ARGON2_KEY_LEN = 32
SALT_LEN = 16


def decrypt_archive(archive_path: str, passphrase: str) -> bytes:
    """Decrypt a .dina archive. Returns JSON plaintext."""
    from argon2.low_level import hash_secret_raw, Type
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    data = open(archive_path, "rb").read()
    if not data.startswith(ARCHIVE_HEADER):
        raise ValueError("Not a valid Dina archive (wrong header)")

    offset = len(ARCHIVE_HEADER)
    salt = data[offset:offset + SALT_LEN]
    offset += SALT_LEN
    nonce = data[offset:offset + 12]
    offset += 12
    ciphertext = data[offset:]

    key = hash_secret_raw(
        secret=passphrase.encode("utf-8"), salt=salt,
        time_cost=ARGON2_TIME, memory_cost=ARGON2_MEMORY,
        parallelism=ARGON2_THREADS, hash_len=ARGON2_KEY_LEN, type=Type.ID,
    )
    try:
        return AESGCM(key).decrypt(nonce, ciphertext, None)
    except Exception:
        raise ValueError("Decryption failed — wrong passphrase or corrupted archive")


def extract_archive(plaintext: bytes, output_dir: str) -> dict:
    """Extract decrypted payload to directory. Returns manifest."""
    import base64
    payload = json.loads(plaintext)
    manifest = payload.get("manifest", {})
    files = payload.get("files", {})

    os.makedirs(output_dir, exist_ok=True)

    with open(os.path.join(output_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    for name, content_encoded in files.items():
        if isinstance(content_encoded, str):
            try:
                content = base64.b64decode(content_encoded)
            except Exception:
                content = content_encoded.encode("utf-8")
        else:
            content = bytes(content_encoded) if isinstance(content_encoded, list) else content_encoded
        with open(os.path.join(output_dir, name), "wb") as f:
            f.write(content)
        print(f"  {name} — {len(content) / 1024:.0f} KB")

    return manifest


# ---------------------------------------------------------------------------
# Key derivation (HKDF-SHA256, matching Core's keyderiver.go)
# ---------------------------------------------------------------------------

def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int = 32) -> bytes:
    """HKDF-SHA256 (RFC 5869)."""
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    t, okm = b"", b""
    for i in range(1, (length + 31) // 32 + 1):
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest()
        okm += t
    return okm[:length]


def derive_vault_dek(master_seed: bytes, persona_name: str) -> bytes:
    """Derive SQLCipher DEK for a persona. Matches Core's DerivePersonaDEKVersioned v1."""
    salt = hashlib.sha256(f"dina:salt:{persona_name}".encode()).digest()
    info = f"dina:persona:{persona_name}:dek:v1".encode()
    return hkdf_sha256(master_seed, salt, info, 32)


def mnemonic_to_seed(mnemonic: str) -> bytes:
    """BIP-39: 24-word mnemonic → 32-byte master seed (entropy extraction)."""
    from mnemonic import Mnemonic
    m = Mnemonic("english")
    if not m.check(mnemonic.strip()):
        raise ValueError("Invalid mnemonic — checksum failed or unknown words")
    return bytes(m.to_entropy(mnemonic.strip()))


def seed_hex_to_bytes(seed_hex: str) -> bytes:
    """Convert 64-char hex string to 32 bytes."""
    b = bytes.fromhex(seed_hex)
    if len(b) != 32:
        raise ValueError(f"Seed must be 32 bytes, got {len(b)}")
    return b


# ---------------------------------------------------------------------------
# Vault reading (SQLCipher)
# ---------------------------------------------------------------------------

def read_vault(db_path: str, dek: bytes) -> dict:
    """Open a SQLCipher database and export all tables as JSON."""
    try:
        import pysqlcipher3.dbapi2 as sqlite3
    except ImportError:
        # Fallback: try system sqlcipher via subprocess
        return _read_vault_subprocess(db_path, dek)

    key_hex = f"x'{dek.hex()}'"
    db = sqlite3.connect(db_path)
    db.execute(f'PRAGMA key = "{key_hex}"')

    result = {}
    try:
        tables = [r[0] for r in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()]

        for table in tables:
            if table.startswith("sqlite_"):
                continue
            try:
                cursor = db.execute(f"SELECT * FROM [{table}]")
                cols = [d[0] for d in cursor.description]
                rows = cursor.fetchall()
                result[table] = [dict(zip(cols, row)) for row in rows]
            except Exception:
                result[table] = {"error": "could not read table"}
    except Exception as e:
        result["_error"] = str(e)
    finally:
        db.close()

    return result


def _read_vault_subprocess(db_path: str, dek: bytes) -> dict:
    """Fallback: read vault using sqlcipher CLI."""
    import subprocess
    key_hex = f"x'{dek.hex()}'"
    commands = f"""PRAGMA key = "{key_hex}";
SELECT name FROM sqlite_master WHERE type='table';"""

    try:
        proc = subprocess.run(
            ["sqlcipher", db_path],
            input=commands.encode(), capture_output=True, timeout=10,
        )
        if proc.returncode != 0:
            return {"_error": f"sqlcipher failed: {proc.stderr[:200]}"}

        stdout = proc.stdout.decode("utf-8", errors="replace")
        tables = [line.strip() for line in stdout.strip().split("\n")
                  if line.strip() and line.strip() != "ok" and not line.startswith("sqlite_")]

        result = {}
        for table in tables:
            query = f"""PRAGMA key = "{key_hex}";
.mode json
SELECT * FROM [{table}] LIMIT 100;"""
            proc2 = subprocess.run(
                ["sqlcipher", db_path],
                input=query.encode(), capture_output=True, timeout=10,
            )
            try:
                output = proc2.stdout.decode("utf-8", errors="replace").strip()
                # Skip the "ok" line from PRAGMA
                lines = [l for l in output.split("\n") if l.strip() and l.strip() != "ok"]
                json_str = "\n".join(lines)
                if json_str:
                    result[table] = json.loads(json_str)
                else:
                    result[table] = []
            except json.JSONDecodeError:
                result[table] = {"_note": f"{table}: contains binary data, use sqlcipher directly"}
            except Exception:
                result[table] = {"_note": f"{table}: could not parse output"}

        return result
    except FileNotFoundError:
        return {"_error": "sqlcipher not found. Install: brew install sqlcipher (macOS) or apt install sqlcipher (Linux)"}
    except Exception as e:
        return {"_error": str(e)}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(
        description="Decrypt a Dina export archive. Your data is yours.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("archive", nargs="?", help="Path to .dina archive file")
    parser.add_argument("--passphrase", help="Export passphrase")
    parser.add_argument("--mnemonic", help="24-word BIP-39 recovery phrase")
    parser.add_argument("--seed", help="Master seed as 64-char hex (alternative to --mnemonic)")
    parser.add_argument("--output", default="dina-export", help="Output directory (default: dina-export)")
    parser.add_argument("--derive-keys", action="store_true",
                        help="Just print per-persona keys (no archive needed)")

    args = parser.parse_args()

    # --- Derive keys only mode ---
    if args.derive_keys:
        master_seed = _resolve_seed(args)
        if not master_seed:
            sys.exit(1)
        print("\nPer-persona vault keys:\n")
        for persona in ["identity", "general", "work", "health", "finance"]:
            dek = derive_vault_dek(master_seed, persona)
            print(f"  {persona:12s}  x'{dek.hex()}'")
        print("\n  sqlcipher general.sqlite")
        print("  PRAGMA key = \"x'<key>'\";")
        print("  SELECT summary FROM vault_items;")
        return

    # --- Full decrypt + read mode ---
    if not args.archive:
        parser.print_help()
        sys.exit(1)
    if not args.passphrase:
        print("Error: --passphrase required", file=sys.stderr)
        sys.exit(1)

    # Step 1: Decrypt archive
    print(f"Decrypting {args.archive}...\n")
    try:
        plaintext = decrypt_archive(args.archive, args.passphrase)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"Extracting to {args.output}/\n")
    manifest = extract_archive(plaintext, args.output)
    print(f"\nArchive decrypted. Timestamp: {manifest.get('timestamp', '?')}")

    # Step 2: If mnemonic/seed provided, derive keys and read vaults
    master_seed = _resolve_seed(args)
    if master_seed:
        print("\nOpening vaults...\n")
        personas_found = [f.replace(".sqlite", "")
                          for f in os.listdir(args.output) if f.endswith(".sqlite")]

        for persona in personas_found:
            db_path = os.path.join(args.output, f"{persona}.sqlite")
            dek = derive_vault_dek(master_seed, persona)
            print(f"  {persona}:")

            data = read_vault(db_path, dek)
            if "_error" in data:
                print(f"    Error: {data['_error']}")
                continue

            # Write readable JSON
            json_path = os.path.join(args.output, f"{persona}_data.json")
            with open(json_path, "w") as f:
                json.dump(data, f, indent=2, default=str)

            # Summary
            for table, rows in data.items():
                if isinstance(rows, list):
                    print(f"    {table}: {len(rows)} rows")
                else:
                    print(f"    {table}: {rows}")

        print(f"\nDone. Readable JSON files are in {args.output}/")
        print("You can open these with any text editor or JSON viewer.")
    else:
        print("\nTo also read vault contents, add your recovery phrase:")
        print(f'  python3 {sys.argv[0]} {args.archive} --passphrase "{args.passphrase}" --mnemonic "word1 word2 ... word24"')


def _resolve_seed(args) -> bytes | None:
    """Resolve master seed from --mnemonic or --seed."""
    if args.mnemonic:
        try:
            return mnemonic_to_seed(args.mnemonic)
        except ImportError:
            print("Error: pip install mnemonic", file=sys.stderr)
            return None
        except ValueError as e:
            print(f"Error: {e}", file=sys.stderr)
            return None
    if args.seed:
        try:
            return seed_hex_to_bytes(args.seed)
        except ValueError as e:
            print(f"Error: {e}", file=sys.stderr)
            return None
    return None


if __name__ == "__main__":
    main()
