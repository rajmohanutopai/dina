# Hermes Delegated Task Integration Architecture

## Purpose

This document defines the full architecture for supporting Hermes as a first-class delegated task runtime in Dina, alongside the existing OpenClaw integration.

The design goal is not "bolt Hermes onto the OpenClaw path." The goal is to make delegated task execution runner-agnostic while preserving the parts of the current design that are already correct:

- Core owns the delegated task lifecycle.
- Brain decides whether a task may run and whether approval is required.
- The runner executes autonomously using Dina MCP tools.
- All agent-origin writes remain caveated and session-scoped.

## Executive Summary

### Recommendation

Support Hermes through a generic runner layer in the CLI/daemon, not through new Core-specific Hermes plumbing.

The recommended MVP is:

1. Keep Core delegated tasks generic.
2. Generalize the CLI daemon from "OpenClaw submitter" to "agent runner daemon".
3. Introduce a runner interface with two implementations:
   - `OpenClawRunner`
   - `HermesRunner`
4. Implement `HermesRunner` using the documented Hermes Python library plus Dina MCP.
5. Treat Hermes hooks as optional telemetry, not as the correctness path.
6. Add per-task or per-instance runner selection without hardcoding OpenClaw into `/task` or Telegram.
7. Use the same runner abstraction for both `dina task` and `dina agent-daemon`.

### Why this is the right shape

- Core is already mostly runner-agnostic.
- Dina already has a generic MCP surface that Hermes can use.
- Hermes docs clearly support MCP, Python embedding, sessions, and hooks.
- Hermes does not present a clean, OpenClaw-style detached task gateway contract that Dina should bind itself to.
- The most maintainable integration point is therefore the CLI/daemon layer, not Core.
- The current direct `dina task` path is also OpenClaw-specific and must be brought under the same abstraction.

## Current State

### What already exists and is reusable

| Area | Current state | Reusable for Hermes? | Notes |
| --- | --- | --- | --- |
| Core delegated task model | Exists | Yes | `core/internal/domain/delegated_task.go` |
| Core delegated task API | Exists | Yes | `core/internal/handler/delegated_task.go` |
| Core internal callback endpoints | Exists | Yes, but wording should be generalized | `core/internal/handler/delegated_task_callback.go` |
| Brain task creation | Exists | Yes | Telegram/Brain create durable delegated tasks in Core |
| Dina MCP tool surface | Exists | Yes | `cli/src/dina_cli/mcp_server.py` |
| Session start/end and scoped actions | Exists | Yes | Already used by CLI and agents |
| Agent caveated provenance model | Exists | Yes | Agent-role CLI/device writes remain caveated |

### What is still OpenClaw-specific today

| Area | Current state | Why it must change |
| --- | --- | --- |
| OpenClaw WebSocket client | `cli/src/dina_cli/openclaw.py` | Specific handshake, auth, and RPC protocol |
| Agent daemon | `cli/src/dina_cli/agent_daemon.py` | Submits to OpenClaw hooks and reconciles OpenClaw ledger |
| CLI `/task` UX | `cli/src/dina_cli/main.py` | Explicitly delegates to OpenClaw |
| Telegram `/task` path | `brain/src/service/telegram.py` | Still hardcodes OpenClaw semantics/identity |
| CLI config | `cli/src/dina_cli/config.py` | Only contains OpenClaw settings |
| OpenClaw callback hook | `cli/src/dina_cli/openclaw_hook.py` | OpenClaw-only terminal callback path |

## Hermes Capability Inventory

Hermes documentation confirms the following useful capabilities:

| Hermes capability | Evidence | Architectural implication |
| --- | --- | --- |
| External MCP server support | Hermes MCP docs | Dina can be exposed to Hermes using the existing `dina mcp-server` |
| Python library with fresh `AIAgent` per task | Hermes Python library docs | Best MVP path for task execution inside Dina's daemon |
| Sessions | Hermes sessions docs | Can map naturally to Dina task/session boundaries |
| Hooks | Hermes hooks docs | Good for metrics and lifecycle telemetry, but not required for correctness |
| OpenAI-compatible API server | Hermes API server docs | Viable future remote runner path, not required for MVP |
| Migration guidance from OpenClaw | Hermes migration docs | Confirms conceptual overlap, but not a drop-in detached task contract |

### Hermes Documentation Cross-Reference

This table links each Hermes documentation page to the parts of this design that depend on it.

| Hermes doc page | Why it matters in Dina | Design sections in this document |
| --- | --- | --- |
| [Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture/) | Confirms Hermes core structure, tool orchestration, provider abstraction, and session persistence model | [Hermes Capability Inventory](#hermes-capability-inventory), [Recommended Architecture](#recommended-architecture), [Hermes Runner Design](#hermes-runner-design) |
| [Using Hermes as a Python Library](https://hermes-agent.nousresearch.com/docs/guides/python-library/) | Primary basis for the recommended MVP: per-task embedded Hermes agent execution inside Dina's daemon | [Implement Hermes via the Python library first](#4-implement-hermes-via-the-python-library-first), [Hermes Runner Design](#hermes-runner-design), [Phase 3: Hermes MVP](#phase-3-hermes-mvp) |
| [MCP (Model Context Protocol)](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/) | Confirms Hermes can consume external MCP servers directly, which makes `dina mcp-server` the stable integration surface | [Dina MCP remains the stable contract](#3-dina-mcp-remains-the-stable-contract), [Keep Dina MCP as the universal runner contract](#6-keep-dina-mcp-as-the-universal-runner-contract), [Security and Trust Model](#security-and-trust-model) |
| [Use MCP with Hermes](https://hermes-agent.nousresearch.com/docs/guides/use-mcp-with-hermes/) | Reinforces the operational model for exposing a bounded MCP surface to Hermes rather than binding directly to Dina internals | [Dina MCP remains the stable contract](#3-dina-mcp-remains-the-stable-contract), [Keep Dina as the memory and policy boundary](#2-keep-dina-as-the-memory-and-policy-boundary), [Prefer minimal tool exposure](#3-prefer-minimal-tool-exposure) |
| [Sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions/) | Confirms Hermes has a first-class session model that can map to Dina task/session boundaries | [Hermes Capability Inventory](#hermes-capability-inventory), [Implement Hermes via the Python library first](#4-implement-hermes-via-the-python-library-first), [Hermes execution flow](#hermes-execution-flow) |
| [Event Hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks/) | Supports the claim that Hermes hooks are useful for telemetry and lifecycle events but should not be the correctness path | [Hooks are telemetry, not truth](#4-hooks-are-telemetry-not-truth), [Optional Future: Hermes Remote Runner](#optional-future-hermes-remote-runner), [Observability](#observability) |
| [API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/) | Basis for the future remote Hermes mode, not the MVP | [Optional Future: Hermes Remote Runner](#optional-future-hermes-remote-runner) |
| [Migrate from OpenClaw](https://hermes-agent.nousresearch.com/docs/guides/migrate-from-openclaw/) | Confirms Hermes and OpenClaw overlap conceptually, but do not share a drop-in detached-task protocol | [Hermes Capability Inventory](#hermes-capability-inventory), [Keep OpenClaw as an adapter, not the template](#5-keep-openclaw-as-an-adapter-not-the-template), [Final Position](#final-position) |

### Important constraint

Hermes documentation is strong, but it does not give Dina the equivalent of OpenClaw's current end-to-end pattern of:

- submit detached task to a gateway endpoint
- receive a durable external run id
- reconcile against a documented task ledger endpoint
- rely on a built-in terminal callback path

That means Dina should not contort Hermes into an OpenClaw-shaped adapter if a simpler integration exists.

## Design Goals

1. Support Hermes and OpenClaw under one delegated-task architecture.
2. Keep Core as the canonical source of task state.
3. Keep Dina MCP as the agent tool contract.
4. Avoid runner-specific logic in Brain and Telegram.
5. Preserve current safety behavior: validation, approval, sessions, caveated writes.
6. Make Hermes support feasible without introducing a second ad hoc callback protocol.
7. Allow a clean future path to additional runners beyond Hermes.

## Non-Goals

1. Replace OpenClaw.
2. Remove existing OpenClaw support.
3. Build a generic remote execution cluster in this phase.
4. Tie Core to Hermes internals.
5. Depend on Hermes hooks for correctness.

## Architectural Principles

### 1. Core owns lifecycle, not the runner

Task states such as `queued`, `claimed`, `running`, `completed`, and `failed` remain Core concepts.

Runners may have richer internal lifecycles, but Dina does not expose those directly. Dina only normalizes them into the delegated task model.

### 2. Runner-specific code belongs at the execution edge

The CLI/daemon is the right place for:

- runner configuration
- launch logic
- reconciliation logic
- runner-specific health checks

Core should not know whether a task ran on OpenClaw, Hermes, or something else.

### 3. Dina MCP remains the stable contract

All supported runners should use the same Dina-facing tool surface:

- `dina_session_start`
- `dina_session_end`
- `dina_validate`
- `dina_ask`
- `dina_remember`
- `dina_task_progress`
- `dina_task_complete`
- `dina_task_fail`

This keeps agent behavior portable across runtimes.

### 4. Hooks are telemetry, not truth

Hooks may be used to:

- emit metrics
- mirror progress
- create alerts
- record structured run metadata

They should not be the only path that prevents data loss or state drift.

## Recommended Architecture

### 1. Introduce a runner abstraction in the CLI layer

Create a generic runner interface in `cli/src/dina_cli/`.

#### Proposed interface

```python
from dataclasses import dataclass, field
from typing import Any, Protocol, Literal

@dataclass
class RunnerResult:
    state: Literal["running", "completed", "failed"]
    run_id: str = ""
    summary: str = ""
    error: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

class AgentRunner(Protocol):
    runner_name: str

    def validate_config(self) -> None: ...
    def health(self) -> dict[str, Any]: ...
    def execute(self, task: dict, prompt: str, session_name: str) -> RunnerResult: ...
    def reconcile(self, task: dict) -> RunnerResult | None: ...
    def cancel(self, task: dict) -> None: ...
```

#### Why this shape works

- `OpenClawRunner.execute()` can submit the task and return `state="running"` with `run_id`.
- `HermesRunner.execute()` can run inline to terminal and return `completed` or `failed`.
- The daemon owns the common task-state transitions against Core.
- Reconciliation stays optional and runner-specific.

### 2. Generalize the daemon into a runner daemon

The current `agent_daemon.py` becomes runner-agnostic.

#### New responsibility split

#### The daemon should own

- claim task from Core
- start Dina session
- build the task prompt and session envelope
- call `runner.execute(...)`
- normalize result into Core task transitions
- end session on terminal state
- invoke runner reconciliation if the runner supports it

#### The runner should own

- runtime-specific launch/auth/transport
- runtime-specific run ids
- runtime-specific health checks
- runtime-specific reconciliation of lost runs

#### Reconciliation must be runner-conditional

The current reconciler thread is OpenClaw-specific because it depends on:

- OpenClaw hook submission
- OpenClaw task ledger lookup
- detached OpenClaw execution after submit

That logic must not run unconditionally once Hermes is added.

Required behavior:

- `OpenClawRunner` enables reconciliation
- `HermesRunner` in inline/library mode does not start a reconciler
- future remote Hermes mode may add its own reconciliation strategy if needed

#### Resulting control flow

```text
Brain/Telegram/CLI
  -> Core delegated task created
  -> runner daemon claims task
  -> daemon starts Dina session
  -> daemon selects runner
  -> runner executes task
     -> agent uses Dina MCP tools
  -> daemon normalizes terminal state back into Core
  -> user checks /taskstatus
```

### 3. Add explicit runner selection

If Dina is expected to support more than one runner at the same time, tasks need a runner selection field.

#### Recommended task model additions

Add to delegated task storage/model:

- `requested_runner` — what the caller asked for, e.g. `openclaw`, `hermes`, `auto`
- `assigned_runner` — what the daemon actually used
- `run_id` — already exists; keep as generic external/internal runner run id

#### Why both fields matter

- `requested_runner` captures intent and allows `/task --runner hermes`
- `assigned_runner` captures reality and makes `/taskstatus` explainable
- `auto` remains possible if Dina later chooses a runner by policy

#### MVP fallback

If per-task runner selection is too much for the first pass, the daemon may use a single configured default runner. But the architecture should still be designed around runner selection so another refactor is not required later.

### 4. Implement Hermes via the Python library first

#### Recommended Hermes MVP

Use the Hermes Python library in-process from Dina's CLI/daemon environment.

#### Package and dependency stance

The implementation should not assume a stable PyPI package name until verified against the actual Hermes documentation and install guidance.

At the time of writing, Hermes library usage appears to be documented primarily via a Git-based install path rather than a simple pinned PyPI dependency. Dina should therefore treat Hermes as an external runtime dependency isolated behind `HermesRunner`, not as a package imported throughout the codebase.

Practical implication:

- add Hermes dependency wiring only in the CLI/runner environment
- isolate Hermes imports behind the runner adapter
- do not leak Hermes-specific imports into Core or Brain

#### Why this is the right MVP

- It is documented.
- It does not require inventing a Hermes-specific detached-task transport.
- It gives Dina direct lifecycle control per task.
- It maps naturally to the current daemon-owned task claim loop.
- It avoids a second callback protocol.

### Hermes execution model

For each claimed task:

1. Create a fresh Hermes `AIAgent` instance.
2. Configure it with the dedicated Dina task profile.
3. Start a fresh Dina MCP stdio subprocess for that task.
4. Provide the task prompt and Dina session name.
5. Let Hermes call Dina through MCP.
6. On terminal return, convert the outcome into `task_complete` or `task_fail`.

### Important rule

Create a fresh Hermes agent per task. Do not share a single long-lived Hermes agent instance across tasks. Hermes docs explicitly describe task-scoped instances as the safe pattern.

The same default should apply to Dina MCP lifecycle for Hermes MVP:

- one fresh `dina mcp-server` stdio subprocess per task

This is the safest initial contract because it matches task isolation and avoids hidden shared-state coupling between Hermes runs.

Reuse of a shared long-lived MCP server should be considered only later, if Hermes library behavior and operational characteristics prove that reuse is stable and materially beneficial.

### 5. Keep OpenClaw as an adapter, not the template

OpenClaw remains supported, but its mechanics should be isolated inside `OpenClawRunner`.

### OpenClaw-specific features that stay in its adapter

- WebSocket handshake and device auth
- hook submission (`/hooks/agent`)
- task ledger reconciliation (`/api/v1/tasks`)
- hook-based completion fallback

The rest of Dina should stop caring about these details.

### 6. Keep Dina MCP as the universal runner contract

### Task prompt contract

All runners should receive the same high-level task envelope:

```text
TASK ID: <task_id>
DINA SESSION: <session_name>
RUNNER: <runner_name>

OBJECTIVE: <description>

INSTRUCTIONS:
1. Use Dina MCP tools for memory, validation, and task status.
2. Use session '<session_name>' for all Dina tool calls.
3. Report progress via dina_task_progress.
4. Report success via dina_task_complete.
5. Report failure via dina_task_fail.
```

### Why this matters

This prevents each runner from having its own Dina task semantics.

## Detailed Architecture

### Core

#### Keep Core generic

Core should remain the canonical source of truth for:

- task creation
- task approval linkage
- claiming and leases
- running/completed/failed transitions
- task visibility to user/admin clients

#### Required Core changes

#### 1. Add runner metadata to delegated tasks

Recommended additions:

- `requested_runner`
- `assigned_runner`

#### 2. Generalize callback naming/comments

The callback endpoints are already useful beyond OpenClaw. Their code/comments should stop implying they are OpenClaw-only.

#### 3. Keep callback endpoints optional

Hermes MVP does not need callback endpoints for correctness if execution is inline in the daemon. The endpoints stay useful for:

- OpenClaw
- future remote Hermes mode
- future external runners

### Brain and Telegram

#### Remove runner hardcoding from `/task`

`brain/src/service/telegram.py` should stop hardcoding OpenClaw semantics into task validation and task creation.

#### Recommended Telegram behavior

Support one of these models:

#### Simple MVP

- `/task <description>` uses the configured default runner
- `/taskstatus` shows `assigned_runner`

#### Better UX

- `/task --runner hermes <description>`
- `/task --runner openclaw <description>`

#### Validation event stance

Brain should validate the existence and risk of a delegated task, not bind the request to OpenClaw specifically.

The current use of an OpenClaw-specific `agent_did` in the Telegram `/task` path should be replaced by a runner-neutral delegated-task identity or task context.

### CLI and Daemon

#### New modules

Recommended new files:

- `cli/src/dina_cli/agent_runner.py` — interface and shared types
- `cli/src/dina_cli/openclaw_runner.py` — adapter around current OpenClaw client + hook flow
- `cli/src/dina_cli/hermes_runner.py` — adapter around Hermes Python library
- `cli/src/dina_cli/runner_registry.py` — resolves runner name to implementation

#### Existing files to change

- `cli/src/dina_cli/agent_daemon.py` — generic daemon, no direct OpenClaw knowledge
- `cli/src/dina_cli/main.py` — `/task` and `agent-daemon` become runner-aware
- `cli/src/dina_cli/config.py` — runner-generic config plus Hermes config

### Hermes Runner Design

#### Preferred Hermes profile model

Use a dedicated Hermes profile for Dina tasks. That profile should:

- enable only the needed toolsets
- include the Dina MCP server
- use a task-appropriate model
- prefer local execution where possible
- keep MCP lifecycle task-scoped for the MVP

#### Recommended Hermes configuration surface

Add config fields such as:

- `agent_runner` — `openclaw` or `hermes`
- `hermes_mode` — `library` for MVP
- `hermes_profile` — profile/config name for Dina task runs
- `hermes_model` — optional override
- `hermes_config_dir` — optional path to Hermes config
- `hermes_timeout_seconds`
- `hermes_max_steps`

The exact names can vary, but the separation should be clear: OpenClaw settings stay OpenClaw-specific; runner selection and Hermes settings become first-class.

#### Hermes execution flow

```text
Daemon claims task from Core
  -> starts Dina session
  -> builds task prompt
  -> HermesRunner creates fresh AIAgent
  -> HermesRunner starts fresh `dina mcp-server` subprocess
  -> Hermes connects to that MCP server
  -> Hermes runs the task
     -> dina_validate
     -> dina_ask
     -> dina_remember
     -> dina_task_progress / complete / fail
  -> Hermes returns terminal result
  -> daemon finalizes any missing task state in Core
  -> daemon ends Dina session
```

#### Completion behavior

Preferred behavior:

- Hermes uses `dina_task_complete` / `dina_task_fail` itself.
- The daemon treats those tool calls as the primary status path.
- If Hermes returns terminal output without having called a completion tool, the daemon applies a fallback completion/failure update.

This gives robustness without making the fallback path the main contract.

#### Progress behavior

Progress remains tool-driven through `dina_task_progress`.

Hooks may mirror or enrich this later, but the MCP progress tool remains the canonical path.

### OpenClaw Runner Design

#### Existing behavior retained inside the adapter

`OpenClawRunner` should wrap the current behavior:

- authenticate to OpenClaw Gateway
- submit work via the current protocol
- receive or infer `run_id`
- return `state="running"`
- use callback hook and reconciliation for terminal cleanup

#### Why keep reconciliation only for OpenClaw

OpenClaw currently runs detached from the daemon after submission. That is why callback + reconciliation exists.

Hermes MVP does not have the same requirement if it executes inline in the daemon.

### Optional Future: Hermes Remote Runner

Hermes also documents an API server and gateway surfaces. Dina may later support a second Hermes mode:

- `hermes_mode = api_server`

This would be a different runner implementation or a second mode in `HermesRunner`.

#### When this becomes worth doing

- multiple machines need to share one Hermes runtime
- long-running detached Hermes tasks become operationally necessary
- you want Hermes outside the CLI process boundary

#### Why not use this for MVP

Because it reintroduces the exact complexity the Python-library approach avoids:

- remote transport
- external run tracking
- callback/polling contract design
- more moving parts before value is proven

## Security and Trust Model

### 1. Keep the agent channel stance

The CLI/device used for delegated task execution remains an `agent` role device. This preserves existing caveated provenance behavior.

### 2. Keep Dina as the memory and policy boundary

Hermes should not get direct database or internal HTTP access. Hermes should interact with Dina via the MCP server and approved Core HTTP flows only.

### 3. Prefer minimal tool exposure

For a Dina task profile, Hermes should get only the toolsets it needs. Dina MCP can be the main stable surface; other high-risk tools should be added deliberately.

### 4. Cloud model caution remains separate

Hermes may still use cloud LLM providers depending on its configuration. That is not introduced by this architecture, but it should be an explicit operational decision.

## Interactive CLI Path

### `dina task` must use the same runner abstraction

The current interactive CLI task path is OpenClaw-specific. That is not acceptable once Hermes support exists.

The architecture therefore requires:

- `dina task` uses the same runner selection and runner adapter layer as `dina agent-daemon`
- no separate one-off OpenClaw path remains in the interactive CLI
- approval flow may differ in UX, but execution must go through the same runner abstraction

### Why this matters

If `dina task` keeps a direct OpenClaw code path while the daemon becomes generic, Dina will have two delegated-task architectures:

- interactive CLI path
- queued daemon path

That will create configuration drift, runner skew, and duplicated integration logic.

The correct architecture is one execution abstraction used by both entry points.

## Failure Model

### OpenClaw failure model

- task may be submitted and continue detached
- hook callback may fail
- daemon reconciliation repairs stale running tasks

### Hermes MVP failure model

- daemon owns the Hermes process/library invocation
- if the daemon crashes mid-task, Core lease/claim semantics determine requeue/recovery
- if Hermes exits without terminal task status, daemon applies fallback failure/summary logic

### Important difference

OpenClaw is naturally detached. Hermes MVP is naturally inline.

The architecture must allow both without forcing both into the same transport model.

## Deployment and Test Stack

### Default stance: one shared Dina stack

Hermes should run in the same Dina Docker/test stack as OpenClaw, Core, Brain, and the Dina MCP surface.

That means:

- no separate Hermes-only Docker architecture
- no parallel Compose topology just for Hermes
- no duplicated Dina environment for Hermes tests

The delegated task system should be tested as one system with multiple runner options, not as separate products.

### Why this is the correct approach

Using the same stack preserves the real integration boundaries:

- same Core delegated task API
- same Brain validation and approval flow
- same Dina MCP server
- same agent-role identity and caveated provenance
- same network and callback environment

If Hermes were tested in a separate Docker setup, the test environment would drift from the real multi-runner architecture and hide integration issues that only appear when runners coexist.

### Recommended Compose shape

Use one shared test/development stack and add Hermes as an additional service or optional profile.

Example shape:

- `core`
- `brain`
- `cli-agent`
- `openclaw`
- `hermes`
- supporting infrastructure

Runner selection should determine which runtime executes a delegated task; the surrounding Dina stack should stay the same.

### Preferred operational model

Use:

- one Compose file
- optional service profiles if Hermes is not always needed
- one shared network
- one shared Dina MCP contract

This does not require OpenClaw and Hermes to run in the same container.

The architecture only requires:

- the same Compose/test stack
- the same surrounding Dina services
- the same delegated task API and MCP contract

Runner-specific containers or services are acceptable inside that one shared stack.

Do not use:

- one OpenClaw Compose file and one Hermes Compose file
- duplicated Core/Brain stacks for runner-specific testing
- separate end-to-end environments unless a hard runtime conflict forces it

### Only valid exception

A separate Hermes container shape is acceptable only if Hermes introduces a hard runtime constraint that cannot coexist cleanly with the current stack, for example:

- incompatible system dependencies
- conflicting runtime requirements
- GPU/runtime isolation that cannot be expressed cleanly in the shared stack

Even in that case, the default should still be:

- one Compose project
- optional profiles or service variants

not a second independent Docker architecture.

## Observability

### Task status shown to users/admins should include

- task id
- requested runner
- assigned runner
- current status
- last progress note
- run id when available
- error/summary

### Optional runner telemetry

Hermes hooks and OpenClaw hooks may later be used for:

- step counts
- tool usage metrics
- latency histograms
- run trace correlation

This is useful, but it should remain additive.

## Implementation Plan

### Phase 1: Runner abstraction

1. Introduce `AgentRunner` interface and shared types.
2. Move OpenClaw-specific logic into `OpenClawRunner`.
3. Convert `agent_daemon.py` to use the interface.
4. Add runner selection in config.

### Phase 2: Task model cleanup

1. Add `requested_runner` and `assigned_runner` to delegated task storage/API.
2. Remove OpenClaw-specific wording from task handlers and comments.
3. Update `/taskstatus` and admin task views to display runner info.

### Phase 3: Hermes MVP

1. Implement `HermesRunner` using the Python library.
2. Add dedicated Hermes task profile/config.
3. Wire Dina MCP into Hermes task runs.
4. Add health checks and terminal fallback handling.

### Phase 4: Runner-aware UX

1. Update CLI `/task` to accept runner selection.
2. Update Telegram `/task` to stop hardcoding OpenClaw.
3. Update docs/help text to say "delegated runner" instead of only OpenClaw where appropriate.

### Phase 5: Reconciliation and optional telemetry

1. Keep OpenClaw reconciliation as-is inside the adapter.
2. Add optional Hermes telemetry hooks if useful.
3. Consider remote Hermes mode only after the local/library mode proves stable.

## Verification

### Core and API

- create delegated task with requested runner
- claim task and record assigned runner
- task status includes runner information

### CLI/daemon

- daemon starts with `agent_runner=openclaw`
- daemon starts with `agent_runner=hermes`
- bad runner config fails fast with clear error

### Docker and integration environment

- Hermes runs in the same Compose/test stack as OpenClaw and Dina
- runner selection switches execution path without changing the surrounding stack
- no separate Hermes-only integration environment is required
- if profiles are used, enabling Hermes should not duplicate Core or Brain services

### OpenClaw runner

- existing OpenClaw task flow still works unchanged
- callback + reconciliation still close stale tasks

### Hermes runner

- Hermes can call Dina MCP tools during a task
- Hermes task completes and updates Core status
- Hermes task failure marks the task failed
- daemon fallback completion works if Hermes returns without `dina_task_complete`

### UX

- `/task` works with default runner
- `/task --runner hermes` works when enabled
- `/taskstatus` shows which runner is handling the task

## What this architecture avoids

1. A second OpenClaw-shaped protocol just for Hermes.
2. Hermes-specific state in Core handlers.
3. Hook-only correctness paths.
4. Runner-specific task semantics in Brain.
5. A future rewrite when a third runner is added.

## Final Position

Hermes support is feasible without destabilizing the current design, but only if Dina stops treating delegated task execution as synonymous with OpenClaw.

The correct long-term architecture is:

- Core task lifecycle stays generic.
- Dina MCP stays the stable agent contract.
- CLI/daemon becomes the execution abstraction boundary.
- OpenClaw and Hermes become adapters behind a shared runner interface.

For Hermes specifically, the Python-library integration is the right first implementation. It is the most direct, least brittle, and most aligned with the current Dina architecture.

## References

### Dina code

- `core/internal/domain/delegated_task.go`
- `core/internal/handler/delegated_task.go`
- `core/internal/handler/delegated_task_callback.go`
- `cli/src/dina_cli/mcp_server.py`
- `cli/src/dina_cli/openclaw.py`
- `cli/src/dina_cli/openclaw_hook.py`
- `cli/src/dina_cli/agent_daemon.py`
- `cli/src/dina_cli/main.py`
- `cli/src/dina_cli/config.py`
- `brain/src/service/telegram.py`
- `docs/OPENCLAW_INTEGRATION_PLAN.md`

### Hermes docs

- Architecture: https://hermes-agent.nousresearch.com/docs/developer-guide/architecture/
- MCP: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/
- Use MCP with Hermes: https://hermes-agent.nousresearch.com/docs/guides/use-mcp-with-hermes/
- Hooks: https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks/
- Sessions: https://hermes-agent.nousresearch.com/docs/user-guide/sessions/
- API server: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/
- Python library: https://hermes-agent.nousresearch.com/docs/guides/python-library/
- Migration from OpenClaw: https://hermes-agent.nousresearch.com/docs/guides/migrate-from-openclaw
