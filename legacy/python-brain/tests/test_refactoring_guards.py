"""Refactoring guard tests — prevent common regression patterns.

These tests call real functions (not mocks) and check for anti-patterns
using ``inspect.getsource()``, ``ast.parse()``, and direct source file
reading.  They are static analysis tests that catch regressions before
they reach integration.

Maps to Brain TEST_PLAN SS23 (Code Review Fix Verification).
"""
from __future__ import annotations

import ast
import dataclasses
import inspect
import pathlib
import textwrap

import pytest


# Root of the brain source tree.
_BRAIN_SRC = pathlib.Path(__file__).resolve().parents[1] / "src"


# ============================================================================
# SS23.2 Refactoring Guards
# ============================================================================


# -- 1. Reminder handler has no hardcoded vault query -------------------------

# TRACE: {"suite": "BRAIN", "case": "0840", "section": "23", "sectionName": "Code Review Fix Verification", "subsection": "02", "scenario": "01", "title": "reminder_handler_no_hardcoded_vault_query"}
def test_reminder_handler_no_hardcoded_vault_query():
    """_handle_reminder_fired must not contain hardcoded search terms.

    The reminder message was already composed by the ReminderPlanner at
    creation time.  The handler should deliver it as-is, not re-query
    the vault with hardcoded keywords like 'RTO' or 'insurance'.
    """
    from src.service.guardian import GuardianLoop

    source = inspect.getsource(GuardianLoop._handle_reminder_fired)

    forbidden_terms = ["RTO", "renewal", "insurance", "address", "driving"]
    violations = [t for t in forbidden_terms if t in source]
    assert not violations, (
        f"_handle_reminder_fired contains hardcoded search terms: {violations}. "
        "The reminder message should be sent as-is — no vault queries needed."
    )


# -- 2. Reminder handler has no LLM call -------------------------------------

# TRACE: {"suite": "BRAIN", "case": "0841", "section": "23", "sectionName": "Code Review Fix Verification", "subsection": "02", "scenario": "02", "title": "reminder_handler_no_llm_call"}
def test_reminder_handler_no_llm_call():
    """_handle_reminder_fired must not invoke the LLM.

    The reminder message was composed at planning time.  Firing should
    deliver it as-is — no LLM rewrite, no self._llm.route() or
    self._llm.complete() calls.
    """
    from src.service.guardian import GuardianLoop

    source = inspect.getsource(GuardianLoop._handle_reminder_fired)

    forbidden_calls = ["self._llm.route(", "self._llm.complete("]
    violations = [c for c in forbidden_calls if c in source]
    assert not violations, (
        f"_handle_reminder_fired calls the LLM: {violations}. "
        "Reminder messages should be sent as-is without LLM rewriting."
    )


# -- 3. No undefined variable references in guardian -------------------------

# TRACE: {"suite": "BRAIN", "case": "0842", "section": "23", "sectionName": "Code Review Fix Verification", "subsection": "02", "scenario": "03", "title": "reminder_handler_no_undefined_variables"}
def test_reminder_handler_no_undefined_variables():
    """_handle_reminder_fired must not reference deleted variables.

    Old versions used personal_context, doc_context, and expiry_date.
    These were removed during refactoring.  If they reappear, the handler
    will crash at runtime with NameError.
    """
    from src.service.guardian import GuardianLoop

    source = inspect.getsource(GuardianLoop._handle_reminder_fired)

    # Parse into AST and collect all Name nodes (variable references).
    tree = ast.parse(textwrap.dedent(source))
    names_used: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            names_used.add(node.id)

    deleted_vars = {"personal_context", "doc_context", "expiry_date"}
    violations = deleted_vars & names_used
    assert not violations, (
        f"_handle_reminder_fired references deleted variables: {violations}. "
        "These were removed during refactoring and will cause NameError."
    )


# -- 4. All response types use format not parse_mode -------------------------

# TRACE: {"suite": "BRAIN", "case": "0843", "section": "23", "sectionName": "Code Review Fix Verification", "subsection": "02", "scenario": "04", "title": "response_types_use_format_not_parse_mode"}
def test_response_types_use_format_not_parse_mode():
    """Response dataclasses must use 'format' field, never 'parse_mode'.

    parse_mode is a Telegram-specific concept.  Transport-agnostic
    response types should use TextFormat via the 'format' field.
    """
    from src.domain import response as resp_mod

    # Collect all dataclass types defined in the response module.
    response_classes = [
        obj for name, obj in inspect.getmembers(resp_mod, inspect.isclass)
        if dataclasses.is_dataclass(obj) and obj.__module__ == resp_mod.__name__
    ]

    assert response_classes, "No dataclass response types found — module structure changed?"

    violations = []
    for cls in response_classes:
        field_names = {f.name for f in dataclasses.fields(cls)}
        if "parse_mode" in field_names:
            violations.append(cls.__name__)

    assert not violations, (
        f"Response types with 'parse_mode' field: {violations}. "
        "Use 'format: TextFormat' instead — parse_mode is Telegram-specific."
    )


# -- 5. TelegramService handlers don't call reply_text directly ---------------

# TRACE: {"suite": "BRAIN", "case": "0844", "section": "23", "sectionName": "Code Review Fix Verification", "subsection": "02", "scenario": "05", "title": "telegram_handlers_use_channel_send"}
def test_telegram_handlers_use_channel_send():
    """TelegramService handler methods must use ch.send(), not reply_text.

    All handlers should go through the channel abstraction.  Direct
    update.message.reply_text() bypasses formatting, logging, and
    multi-channel support.

    Exclusions: send_nudge, send_approval_prompt, send_reminder_plan
    are outbound push methods, not user-facing handlers.
    """
    from src.service.telegram import TelegramService

    source = inspect.getsource(TelegramService)

    # Parse to find method definitions and check each one.
    tree = ast.parse(textwrap.dedent(source))

    # Methods excluded from the check (outbound pushes, not handlers).
    excluded = {"send_nudge", "send_approval_prompt", "send_reminder_plan"}

    violations = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name in excluded or node.name.startswith("_"):
                # Skip excluded and private/dunder methods.
                continue
            method_source = ast.get_source_segment(source, node)
            if method_source and "update.message.reply_text" in method_source:
                violations.append(node.name)

    assert not violations, (
        f"TelegramService methods using update.message.reply_text: {violations}. "
        "Use ch.send(BotResponse(...)) instead for transport-agnostic output."
    )


# -- 6. trace.py import has fallback ------------------------------------------

# TRACE: {"suite": "BRAIN", "case": "0845", "section": "23", "sectionName": "Code Review Fix Verification", "subsection": "02", "scenario": "06", "title": "trace_import_has_fallback"}
def test_trace_import_has_fallback():
    """trace.py must have a try/except ImportError fallback for trace_store.

    The route file is loaded under two different package layouts
    (relative and absolute).  Without the fallback, one layout breaks.
    """
    trace_path = _BRAIN_SRC / "dina_brain" / "routes" / "trace.py"
    assert trace_path.exists(), f"trace.py not found at {trace_path}"

    source = trace_path.read_text()
    tree = ast.parse(source)

    # Walk the AST looking for a Try node that has an ExceptHandler
    # catching ImportError.
    found_import_fallback = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Try):
            for handler in node.handlers:
                # handler.type can be a Name node with id "ImportError"
                if handler.type is not None:
                    if isinstance(handler.type, ast.Name) and handler.type.id == "ImportError":
                        found_import_fallback = True
                        break
            if found_import_fallback:
                break

    assert found_import_fallback, (
        "trace.py is missing try/except ImportError fallback for trace_store import. "
        "This is required for both relative and absolute import layouts to work."
    )


# -- 7. _push_notification exists and sends to both channels ------------------

# TRACE: {"suite": "BRAIN", "case": "0846", "section": "23", "sectionName": "Code Review Fix Verification", "subsection": "02", "scenario": "07", "title": "push_notification_sends_to_both_channels"}
def test_push_notification_sends_to_both_channels():
    """GuardianLoop._push_notification must check both _telegram and _bluesky.

    Notifications should fan out to all configured channels.  If a
    channel check is missing, users on that channel silently miss alerts.
    """
    from src.service.guardian import GuardianLoop

    assert hasattr(GuardianLoop, "_push_notification"), (
        "GuardianLoop is missing _push_notification method"
    )

    source = inspect.getsource(GuardianLoop._push_notification)

    assert "_telegram" in source, (
        "_push_notification does not check for _telegram channel. "
        "Telegram notifications will be silently skipped."
    )
    assert "_bluesky" in source, (
        "_push_notification does not check for _bluesky channel. "
        "Bluesky notifications will be silently skipped."
    )


# -- 8. Brain startup wires PDS publisher outside Telegram block --------------

# TRACE: {"suite": "BRAIN", "case": "0847", "section": "23", "sectionName": "Code Review Fix Verification", "subsection": "02", "scenario": "08", "title": "pds_publisher_outside_telegram_block"}
def test_pds_publisher_outside_telegram_block():
    """PDS publisher wiring must be independent of the Telegram block.

    Trust commands (vouch, review, flag) work via Telegram, admin CLI,
    and web UI.  If the PDS publisher is wired inside the
    ``if cfg.telegram_token:`` block, it breaks for non-Telegram users.
    """
    main_path = _BRAIN_SRC / "main.py"
    assert main_path.exists(), f"main.py not found at {main_path}"

    source = main_path.read_text()
    tree = ast.parse(source)

    # Strategy: find the ``if cfg.telegram_token:`` block and the PDS
    # publisher assignment.  The PDS wiring (identified by the string
    # "PDSPublisher" or variable "pds_publisher_instance") must NOT be
    # nested inside the telegram_token if-block.

    class TelegramBlockVisitor(ast.NodeVisitor):
        """Collects all ast nodes inside ``if cfg.telegram_token:`` blocks."""

        def __init__(self):
            self.telegram_block_lines: set[int] = set()
            self.inside_telegram_block = False

        def visit_If(self, node: ast.If):
            # Detect ``if cfg.telegram_token:``
            is_telegram_check = False
            test = node.test
            if isinstance(test, ast.Attribute):
                if (isinstance(test.value, ast.Name)
                        and test.value.id == "cfg"
                        and test.attr == "telegram_token"):
                    is_telegram_check = True

            if is_telegram_check:
                # Record all line numbers in the body (but not orelse).
                for child in ast.walk(node):
                    if hasattr(child, "lineno"):
                        self.telegram_block_lines.add(child.lineno)
                # Don't recurse into the body — we already walked it.
                # But do visit orelse in case there are nested ifs.
                for child in node.orelse:
                    self.visit(child)
            else:
                self.generic_visit(node)

    visitor = TelegramBlockVisitor()
    visitor.visit(tree)

    # Now find the PDS publisher assignment line(s).
    pds_lines: list[int] = []
    for node in ast.walk(tree):
        # Look for: pds_publisher_instance = PDSPublisher(...)
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "pds_publisher_instance":
                    if isinstance(node.value, ast.Call):
                        pds_lines.append(node.lineno)
        # Also look for: from .adapter.pds_publisher import PDSPublisher
        if isinstance(node, ast.ImportFrom):
            if node.module and "pds_publisher" in node.module:
                pds_lines.append(node.lineno)

    assert pds_lines, (
        "Could not find PDS publisher wiring in main.py. "
        "Expected 'pds_publisher_instance = PDSPublisher(...)' assignment."
    )

    violations = [ln for ln in pds_lines if ln in visitor.telegram_block_lines]
    assert not violations, (
        f"PDS publisher wiring is inside the telegram_token block at lines {violations}. "
        "PDS publisher must be wired independently so trust commands work "
        "without Telegram configured."
    )
