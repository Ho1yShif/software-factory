# Code Provenance — Lift-and-Shift Map

**Status:** NON-NORMATIVE (implementation guidance)
**Companion to:** `00-project-seed.md` (the canonical contract)

> This document is **not** part of the canonical technical contract. It maps each
> area of the spec to the existing implementation that should be ported, adapted,
> or used as reference. Contracts and data models live in `00-project-seed.md`;
> sprint specs reference both. The two source repos are:
>
> - **H** = `render-agent-harness`
> - **T** = `agent-workflows-template`

## 1. From `agent-workflows-template` (orchestration kernel)

The template is the closer starting point for the SDK's core architecture. Its engine is small, clean, and already structured around the authoring and execution model we're building.

| Spec area | Template source | Adaptation |
|---|---|---|
| **Markdown agent loading + validation** | `src/engine/parse-agents.ts` | Extend frontmatter schema (add `plan`, `runner`, `permissions.requireApproval`). Add `_shared.md` merge. Wire Zod validation for fail-fast. |
| **Agent types** (`AgentDefinition`, `AgentSet`, `AgentTask`) | `src/engine/types/agent.ts` | Rename `AgentTask` → `Agent`. Add `.task()` alongside `.run()`. Add `plan` (`RenderPlan`), `runner` field. Bind agents to `AgentRuntime` (§5.23). |
| **Runtime / composition root** (`createRuntime`, `AgentRuntime`, `TaskDispatcher`) | *(new — no direct source)* | New code. Auto-detect store/model/dispatcher from env. Shared by gateway + workflow service. |
| **Task dispatch** (`agent.task()` → Render Workflows) | *(new — wraps `@renderinc/sdk/workflows`)* | Auto-register plan-tier `agent@<plan>` tasks; chained-run dispatch inside handlers, `client.runTask` from gateway, in-process fallback locally. Deterministic dispatch keys. |
| **Workflow handler + `ctx.step`** | `src/workflows/code-review/index.ts` | Add `ctx.step()` memoization (`workflow_steps` table), `retries=0` default, determinism contract (§8.7). |
| **Tool system** (`defineTool`, `defineMcpSource`, `ToolSource`) | `src/engine/tool.ts`, `types/tool.ts` | Direct lift. Add `ConnectorSpec` support. |
| **Skill system** (`SkillMetadata`, `loadSkills`, `load_skill` tool) | `src/engine/skills.ts`, `types/skill.ts` | Direct lift. |
| **LLM loop** (`runLoop`) | `src/engine/loop.ts` | Extend with: cancellation check, idempotency, HITL pause (placeholder tool_result), message persistence, cost accumulation. Core iterate/call/dispatch structure stays. |
| **Model client + tiers** | `src/engine/model.ts`, `model-tiers.ts` | Direct lift. Add `estimateCost`. |
| **Environment** (tool registry, mount/dispose) | `src/engine/environment.ts`, `types/environment.ts` | Direct lift. |
| **Tracing** (`Tracer`, `SpanInfo`) | `src/engine/store/tracer.ts`, `types/trace.ts` | Direct lift. Ensure the `workflow` and `step` span kinds already defined in the contract (§5.11) are emitted. |
| **Store** (RunStore, memory + Postgres) | `src/engine/store/` | Extend schema: add `tool_calls`, `total_cost_usd`, `cursor`, `conversation_id`, `user_id`. Add `run_messages` and `workflow_steps` tables (+ `getStepResult`/`putStepResult`). |
| **Workflow composition** | `src/workflows/code-review/index.ts` | Reference for `workflow()` helper design. The code-review pipeline becomes the scaffolder's default example. |
| **Gateway + webhooks** | `src/main.ts`, `src/server/` | Adapt to Hono. Add sessions, HITL, OAuth, schedule routes (from harness). |
| **Trace UI** | `src/ui/` | Direct lift as dev-mode trace viewer. |

## 2. From `render-agent-harness` (platform substrate)

The harness provides production-grade infrastructure that the template lacks. These modules are ported into `@render-agents/gateway` and `@render-agents/store`, adapted to the new data models.

| Spec area | Harness source | Adaptation |
|---|---|---|
| **HITL approval flow** | `core/src/loop-steps.ts` (`pauseForApproval`, `replayPendingToolUses`, `pauseForAwaitingInput`) | Port pause/resume logic. Adapt to our `RunContext.requestApproval()` contract. The placeholder `tool_result` trick and replay-pending-uses are critical. |
| **Idempotent tool dispatch** | `core/src/idempotency.ts` | Direct lift. `SHA-256(runId + toolCallId)` → check before dispatch, record after. |
| **OAuth implementation** | `core/src/connections.ts` | Port: AES-256-GCM encryption, `SELECT FOR UPDATE` refresh, `SecretsContext` builder. Adapt to our `OAuthStore` + `ToolContext.connection()` contract. |
| **OAuth HTTP routes** | `web/src/routes/connections.ts` | Port: `/start`, `/callback`, `DELETE`. Adapt HMAC state signing. |
| **SSRF-guarded fetch** | `core/src/builtins/fetchUrl.ts` | Direct lift into `@render-agents/engine`. DNS resolve + private IP block via `ipaddr.js`, redirect re-check, size/timeout caps. |
| **Cooperative cancellation** | `core/src/cancel.ts` | Port pattern: Valkey `cancel:{runId}` with poll. Adapt to our `CancelStore` interface. |
| **Conversation model** | `web/src/routes/conversations.ts`, `core/src/state/repo.ts` | Port: `loadConversationMessages` (cross-run history), sequential-only enforcement (unique index), `409 conversation_busy` on concurrent turns. |
| **SSE streaming** | `web/src/routes/runs.ts` (SSE handler), `core/src/state/repo.ts` (NOTIFY) | Port: pointer-payload NOTIFY pattern, dedicated `pg.Client` for LISTEN, replay-then-stream initialization. |
| **Budget enforcement** | `core/src/loop.ts` (`overBudget`, `estimateCost`, `addUsage`) | Port cost estimation. Adapt `DEFAULT_BUDGET` (harness defaults: `maxCostUsd: 10`, `maxWallSeconds: 39600`). |
| **Run state repo** | `core/src/state/repo.ts` | Reference for cursor update, message append with `next_seq()`, status transitions, NOTIFY emission. |
| **Migrations + advisory lock** | `core/sql/*.sql`, `core/src/state/schema.ts` | Port advisory-lock pattern for safe concurrent migration. Adapt table schemas to our spec. |
| **API key auth** | `web/src/auth.ts` | Port: constant-time compare, fail-closed on missing key. |
| **Input validation** | `web/src/routes/*.ts` | Port: non-empty input strings, pause-reason body matching, agent name resolution. |
| **Scaffolder** | `create-render-agent/` | Port wizard flow (`@clack/prompts`), `buildFileMap`, blueprint emission. Adapt to generate our project layout. |

## 3. Not ported (intentionally dropped)

| Harness module | Why |
|---|---|
| **Four runtime adapters** (`runtime-web`, `runtime-worker`, `runtime-cron`, `runtime-workflows`) | Replaced by one model: `agent.run()` (in-process) + `agent.task()` (Workflow). Cron and webhooks are trigger types, not runtimes. |
| **Capability packs** (`definePack`, namespace mangling) | Replaced by convention-discovered tools with flat names and hard-error collisions. The `ConnectorSpec` covers the inbound-webhook contribution packs provided. |
| **`render-harness.yaml`** config schema | No project-level config file (Decision #4c). Replaced by `package.json` (project metadata), markdown frontmatter (agent config), `render.yaml` (deploy), and env vars (infra). Agent identity lives in the agent file, not a config registry. |
| **YAML agent definitions** | Replaced by markdown-first authoring. |
| **Gallery / registry index** | Deferred. The scaffolder generates projects directly; a registry of templates is a future concern. |
| **Operator UI** (`@render-harness/ui`) | Deferred to post-MVP. The trace UI from the template serves as the initial dev-mode viewer. |
| **pg-boss queue** | Replaced by Render Workflows for job dispatch. The gateway dispatches workflows directly; no intermediate queue. |
| **Valkey for cancel** | Replaced by `CancelStore` interface — implementations can use Render KV, Postgres flag, or in-memory. |

## 4. Porting principles

1. **Port contracts, not code.** The harness is callback-heavy and config-driven. Extract the logic, implement it against our interfaces.
2. **Flatten the dependency graph.** The harness has 10+ packages with complex cross-deps. Our monorepo has 4 packages with a clean tree.
3. **Delete the YAML layer.** Every place the harness reads from `render-harness.yaml` or `AgentDefinition` built by `defineFromConfig`, we read from markdown frontmatter (agent config) or `package.json` (project metadata). There is no project-level config file.
4. **Keep the SQL.** The harness's migration patterns (advisory lock, idempotent `CREATE TABLE IF NOT EXISTS`, index naming) are production-proven.
5. **Test against the harness's edge cases.** The harness handles: concurrent conversation turns, mid-loop crashes, OAuth token races, SSRF via DNS rebinding, budget overflow on the last turn. These are the test cases we must not lose.

---

*Section references (§) point to `00-project-seed.md`, the canonical contract.*
