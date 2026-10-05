"""Bridge to the official UCP samples' RFC 9421 module (rest/python/server/ucp_signing.py).

Used by samples_signing.e2e.test.ts to cross-check Dina's signatures against an
implementation Dina did not write (UCP plan §3.2, T-U2-1).

  verify: stdin {method, url, headers, body_b64, jwk} -> stdout {"ok": keyid} or {"error": code}
  sign:   stdin {method, url, headers, body_b64}       -> stdout {"headers": {...}, "jwk": {...}}
"""

import base64
import json
import os
import sys
from urllib.parse import urlsplit

sys.path.insert(0, os.path.join(os.environ["DINA_UCP_SAMPLES_DIR"], "rest", "python", "server"))

import ucp_signing  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402


def main() -> None:
    mode = sys.argv[1]
    req = json.load(sys.stdin)
    body = base64.b64decode(req.get("body_b64", ""))
    if mode == "verify":
        url = urlsplit(req["url"])
        try:
            keyid = ucp_signing.verify_request(
                req["method"],
                url.netloc,
                url.path,
                url.query,
                {k.lower(): v for k, v in req["headers"].items()},
                body,
                [req["jwk"]],
            )
            print(json.dumps({"ok": keyid}))
        except ucp_signing.SignatureError as exc:
            print(json.dumps({"error": exc.code}))
        return
    if mode == "sign":
        key = ec.generate_private_key(ec.SECP256R1())
        jwk = ucp_signing.jwk_from_public_key(key.public_key(), "samples-key")
        added = ucp_signing.sign_request(
            key, "samples-key", req["method"], req["url"], dict(req["headers"]), body
        )
        print(json.dumps({"headers": added, "jwk": jwk}))
        return
    raise SystemExit(f"unknown mode {mode}")


if __name__ == "__main__":
    main()
