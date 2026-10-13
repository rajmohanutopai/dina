"""REAL_LIFE_FIXES_2 §15 — declared purchase fields for intent validation."""

import pytest

from dina_cli.spend import spend_fields

BASE = dict(session="ses_1", action="purchase", description="dish soap x3", merchant="Kirana Plus", category="household items", request_key=None)


def test_no_amount_sends_nothing():
    assert spend_fields(amount=None, currency=None, **BASE) == {}


def test_amount_in_minor_units_with_a_stable_key():
    a = spend_fields(amount="1299.50", currency="inr", **BASE)
    b = spend_fields(amount="1299.50", currency="INR", **BASE)
    assert a["amount"] == {"value_minor": 129950, "currency": "INR"}
    assert a["merchant"] == "Kirana Plus" and a["category"] == "household items"
    assert a["request_key"] == b["request_key"]  # re-running the same purchase is a retry


@pytest.mark.parametrize("bad", ["0", "-5", "1.005", "abc"])
def test_bad_amounts_are_refused(bad):
    with pytest.raises(ValueError):
        spend_fields(amount=bad, currency="INR", **BASE)


def test_bad_currency_is_refused():
    with pytest.raises(ValueError):
        spend_fields(amount="10", currency="rupees", **BASE)


def test_minor_units_follow_the_currency():
    assert spend_fields(amount="5000", currency="JPY", **BASE)["amount"] == {"value_minor": 5000, "currency": "JPY"}
    assert spend_fields(amount="1.250", currency="KWD", **BASE)["amount"] == {"value_minor": 1250, "currency": "KWD"}
    with pytest.raises(ValueError):
        spend_fields(amount="10.5", currency="JPY", **BASE)
