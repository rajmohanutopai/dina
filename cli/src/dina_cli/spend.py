"""Declared purchase fields for agent intent validation (REAL_LIFE_FIXES_2 §15).

A purchase an agent declares (amount, currency, merchant, category) can be
covered by a spending budget the owner set for it in Dina. These are the
agent's claim; Dina never pays — the agent pays at the shop. Each purchase
carries a request key: the same key and purchase return Dina's recorded
answer, so a retry never counts twice. Without an explicit key, one is
derived from the session and the purchase, so re-running the same command
is a retry, not a second purchase.
"""

from __future__ import annotations

import hashlib
import re
from decimal import Decimal, InvalidOperation

_CURRENCY = re.compile(r"^[A-Z]{3}$")

# ISO 4217 minor-unit exponents that are not 2 (Core's money_display table).
_EXPONENTS = {
    **{c: 0 for c in ("JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XAF", "XOF", "XPF", "PYG", "RWF", "GNF", "KMF", "DJF", "BIF", "VUV")},
    **{c: 3 for c in ("BHD", "KWD", "OMR", "JOD", "IQD", "TND", "LYD")},
}


def minor_units(amount: str, currency: str) -> int:
    """`amount` in the main unit as a whole number of the currency's minor unit."""
    try:
        scaled = Decimal(amount) * (Decimal(10) ** _EXPONENTS.get(currency, 2))
    except InvalidOperation as exc:
        raise ValueError(f"amount must be a number, got {amount!r}") from exc
    if scaled <= 0 or scaled != scaled.to_integral_value():
        raise ValueError(f"amount must be positive, with no more decimals than {currency} has")
    return int(scaled)


def spend_fields(
    *,
    session: str,
    action: str,
    description: str,
    amount: str | None,
    currency: str | None,
    merchant: str | None,
    category: str | None,
    request_key: str | None,
) -> dict:
    """Body fields for a declared purchase, or {} when no amount is given.

    Raises ValueError on a bad amount or currency, before anything is sent.
    """
    if amount is None:
        return {}
    code = (currency or "").upper()
    if not _CURRENCY.match(code):
        raise ValueError("currency must be a three-letter code, e.g. INR")
    minor = minor_units(amount, code)
    key = request_key or hashlib.sha256(
        "|".join([session, action, description, str(minor), code, merchant or "", category or ""]).encode()
    ).hexdigest()[:32]
    fields: dict = {"amount": {"value_minor": int(minor), "currency": code}, "request_key": key}
    if merchant:
        fields["merchant"] = merchant
    if category:
        fields["category"] = category
    return fields
