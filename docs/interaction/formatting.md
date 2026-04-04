# Response Formatting Architecture

## Purpose

This document defines the canonical response-format contract for Dina, OpenClaw integrations, and internal systems.

The goal is to separate:

- content semantics
- storage
- rendering

Producers should emit structured semantic content. Renderers should decide how that content appears in Telegram, CLI, web, admin UI, or other channels.

## Design Principles

1. Content is semantic, not presentation-specific.
2. Renderers own styling.
3. Every structured response must also have a plain-text fallback.
4. Unknown or invalid structured responses must degrade safely to raw text.
5. The top-level response type set should stay small and stable.
6. Styling intent should be represented as semantics like `critical` or `warning`, not as HTML, CSS, or hard-coded colors.

## Top-Level Response Types

Use this exact set:

- `summary`
- `list`
- `table`
- `comparison`
- `status`
- `error`
- `raw`

Meanings:

- `summary`: title plus body text
- `list`: ordered or unordered items
- `table`: rows and columns
- `comparison`: side-by-side options
- `status`: in-progress update
- `error`: terminal or non-terminal failure information
- `raw`: unstructured fallback

## Canonical Envelope

All structured responses should use the same envelope:

```json
{
  "schema_version": "1",
  "type": "summary",
  "title": "Weekly Recap",
  "text": "Three important updates.",
  "data": {},
  "meta": {
    "source": "openclaw",
    "task_id": "task-123",
    "generated_at": 1770000000
  }
}
```

Field rules:

- `schema_version`: required contract version
- `type`: one of the allowed response types
- `title`: optional short heading
- `text`: required plain-text fallback after normalization
- `data`: type-specific structured payload
- `meta`: optional metadata, never required for rendering correctness

## Semantic Text Model

Any text-bearing field may be either:

- a plain string
- a rich text object with semantic segments

Canonical rich text shape:

```json
{
  "segments": [
    {
      "text": "Payment failed for ",
      "tone": "normal",
      "emphasis": "none"
    },
    {
      "text": "subscription",
      "tone": "critical",
      "emphasis": "strong"
    }
  ]
}
```

Supported segment fields:

- `text`: literal text
- `tone`: `normal | muted | info | success | warning | critical`
- `emphasis`: `none | strong`
- `code`: `true | false`
- `link`: optional URL
- `entity`: optional semantic tag such as `price`, `date`, or `vendor`

This is the correct way to express cases like:

- part of a list item should be bold
- part of a list item should be red in web UI

The content should mark the segment as semantic:

- `tone = "critical"`
- `emphasis = "strong"`

The renderer then maps that to:

- web: bold red
- Telegram: bold
- CLI: warning prefix or uppercase

Do not encode styling directly in content as:

- HTML
- Markdown fragments as the primary representation
- CSS-like fields such as `color: red`

## Type-Specific Shapes

### Summary

```json
{
  "type": "summary",
  "title": "Weekly Recap",
  "text": "Three important updates.",
  "data": {
    "body": {
      "segments": [
        { "text": "Revenue is up 12%. ", "tone": "success", "emphasis": "strong" },
        { "text": "Churn increased slightly.", "tone": "warning", "emphasis": "none" }
      ]
    }
  }
}
```

### List

```json
{
  "type": "list",
  "title": "Top Webcam Picks",
  "text": "Three options found.",
  "data": {
    "ordered": true,
    "items": [
      {
        "label": "1",
        "body": {
          "segments": [
            { "text": "Logitech C920 - ", "tone": "normal", "emphasis": "strong" },
            { "text": "$69", "tone": "success", "emphasis": "strong" }
          ]
        }
      }
    ]
  }
}
```

### Table

```json
{
  "type": "table",
  "title": "Vendor Comparison",
  "text": "Three rows.",
  "data": {
    "columns": ["Vendor", "Price", "Stock"],
    "rows": [
      ["Amazon", "$69", "In stock"],
      ["Best Buy", "$72", "Low stock"],
      ["B&H", "$68", "Backordered"]
    ]
  }
}
```

### Comparison

```json
{
  "type": "comparison",
  "title": "Choose One",
  "text": "Two options compared.",
  "data": {
    "options": [
      {
        "name": "Option A",
        "summary": "Cheaper",
        "pros": ["Lower cost", "Fast shipping"],
        "cons": ["Weaker mic"]
      },
      {
        "name": "Option B",
        "summary": "Better quality",
        "pros": ["Sharper image", "Better mic"],
        "cons": ["Higher price"]
      }
    ]
  }
}
```

### Status

```json
{
  "type": "status",
  "title": "Research In Progress",
  "text": "Checked two of five vendors.",
  "data": {
    "stage": "research",
    "percent": 40,
    "message": "Checked two of five vendors.",
    "eta_seconds": 180
  }
}
```

### Error

```json
{
  "type": "error",
  "title": "Task Failed",
  "text": "Amazon blocked access from the current region.",
  "data": {
    "code": "ACCESS_BLOCKED",
    "retryable": false,
    "detail": "Amazon blocked access from the current region."
  }
}
```

### Raw

```json
{
  "type": "raw",
  "title": "Agent Output",
  "text": "Unstructured result text.",
  "data": {}
}
```

## Rendering Rules

Renderers must be channel-specific:

- Telegram renderer
- CLI renderer
- web renderer
- admin renderer

The same semantic content may render differently by channel.

Example semantic mapping:

- `critical + strong`
  - web: bold red
  - Telegram: bold
  - CLI: `CRITICAL:`
- `warning`
  - web: amber
  - Telegram: plain text with warning prefix
  - CLI: `Warning:`
- `success`
  - web: green
  - Telegram: bold or plain
  - CLI: `OK:`

Producers do not decide exact styling.

## Persistence Model

Structured response data should not replace text storage.

For task and status persistence, store both:

- plain-text summary or error
- optional structured payload JSON

Recommended fields for delegated task storage:

- `result_summary`
- `result_payload_json`
- `result_type`
- `progress_note`
- `progress_payload_json`
- `progress_type`
- `error`
- `error_payload_json`

Rules:

- plain text must always exist
- structured payload is optional
- invalid structured payload must not break task completion
- if parsing fails, keep text and downgrade to `raw`

## API Contract

Completion, progress, and failure APIs should accept both text and optional structured response payloads.

### Complete

```json
{
  "result": "Three webcam options found.",
  "response": {
    "schema_version": "1",
    "type": "list",
    "title": "Top Webcam Picks",
    "text": "Three webcam options found.",
    "data": {
      "ordered": true,
      "items": []
    }
  }
}
```

### Progress

```json
{
  "message": "Checked two of five vendors.",
  "response": {
    "schema_version": "1",
    "type": "status",
    "title": "Research In Progress",
    "text": "Checked two of five vendors.",
    "data": {
      "stage": "research",
      "percent": 40,
      "message": "Checked two of five vendors."
    }
  }
}
```

### Fail

```json
{
  "error": "Amazon blocked access from the current region.",
  "response": {
    "schema_version": "1",
    "type": "error",
    "title": "Task Failed",
    "text": "Amazon blocked access from the current region.",
    "data": {
      "code": "ACCESS_BLOCKED",
      "retryable": false
    }
  }
}
```

## Validation and Normalization

Every structured response should go through a normalizer before storage or rendering.

Normalization steps:

1. Parse payload if present.
2. Validate `schema_version`.
3. Validate `type`.
4. Validate `data` shape for that type.
5. Normalize text fields to plain strings or rich text segments.
6. Ensure `text` fallback exists.
7. Apply size limits.
8. Downgrade invalid payloads to `raw`.

Validation rules:

- `type` must be one of the allowed values
- `text` must exist after normalization
- no HTML
- no CSS-like styling fields
- no renderer-specific markup as the primary format
- limit number of rows, columns, items, and segments

## Producer Rules

OpenClaw and internal services should follow this rule:

- always provide a plain-text summary
- provide structured payload only when it cleanly fits the schema
- use semantic segments for emphasis
- do not emit HTML or CSS
- use `raw` when structure is not reliable

## Rollout

Recommended rollout order:

1. Add envelope and validation models.
2. Keep existing plain string fields unchanged.
3. Add optional structured payload support to complete, fail, and progress flows.
4. Update Telegram, CLI, and web renderers.
5. Update OpenClaw prompt contract and internal producers.

## Status

This architecture is defined here but not fully implemented yet.
