# 00 — Technical Specification: render-agents

**Author:** Jacob Prall
**Status:** DRAFT  
**Date:** 2025-06-25  

---

## 1. Overview

This document is the canonical technical contract for the render-agents SDK. It defines every data model, interface, API signature, convention, and requirement that sprint-scoped specs (01, 02, ...) implement against. It does not describe implementation order — that belongs in the sprint specs.

### North star

A software engineer defines agents as markdown files, composes them into pipelines with TypeScript, and deploys the result on Render with one config file. The SDK provides the authoring model, execution kernel, tool system, observability, and platform substrate. The agent loop is pluggable. Everything else is opinionated.

### Scope

| In scope | Out of scope |
|---|---|
| TypeScript SDK (`@render-agents/sdk`) | Python SDK (future, same platform contract) |
| Markdown agent authoring + validation | GUI/visual agent builder |
| In-process and Workflow-dispatched execution | Non-Render orchestration backends |
| Local tools and MCP tool sources | Custom tool protocols beyond MCP |
| OTel-shaped tracing to Postgres | Third-party collector integrations (export only) |
| Web gateway with sessions, HITL, OAuth | End-user-facing chat UI |
| Render Workflows as the orchestration primitive | Generic workflow engine abstraction |

---

## 2. Design Principles

### Authoring model
1. **One path** — one way to define an agent (markdown), one way to run it (in-process or as a task), one way to deploy it (Render Workflow). Fewer choices, less friction.
2. **Markdown is the spec** — an agent definition is human-readable, diffable, portable, and self-contained. No build step to understand what an agent does.
3. **Convention over configuration** — drop a file in the right directory and it's wired. The directory name is the identity. No manual registration, no YAML glue, no namespace mangling.

### Architecture
4. **Render primitives, not abstractions over them** — Workflows for durability and orchestration, Postgres for state and traces, services for the gateway. Don't re-invent what the platform already provides.
5. **Workflows orchestrate, Postgres persists** — Workflows answer "what task runs next?" Postgres answers "what happened, what did the model see, what tools ran, what is paused, and what can be resumed?" These are distinct responsibilities.
6. **Composable, not coupled** — agents are units. They compose via orchestration code (TypeScript), not framework magic. Deterministic and LLM steps are peers.
7. **Local = production** — the same agent definitions run in-process locally and as isolated Workflow tasks in production with zero changes. No separate config, no separate deployment shapes.

### Extensibility
8. **Pluggable where it matters** — the runner (agent loop) is swappable. The orchestration model and deployment targets are opinionated.
9. **MCP at the boundary** — local tools for in-language convenience, MCP as the portable protocol for cross-language reuse and production isolation. Tools start local, promote to MCP servers or private services when they need a different language or stronger isolation.
10. **Portable, not locked in** — vendor-agnostic model layer, standard protocols (MCP for tools, OTel for traces), swappable runner. The agent markdown is the same regardless of what runs it or where it deploys.

### Trust and operations
11. **Safe by default** — permissions, budgets, HITL approval, scoped access, audit trails, and secrets management are built into the platform layer, not bolted on by the agent author. Agents are constrained by default.
12. **Observable by default** — tracing is not opt-in. Every run produces a full span tree with cost attribution.
13. **Fail fast** — unknown fields, invalid tool/skill/model references, and bad budget values fail at load time, in CI, and ideally in the IDE.

---

## 3. Package Structure

```
render-agents/                         # monorepo root
├── packages/
│   ├── sdk/                           # @render-agents/sdk — public API surface
│   │   ├── src/
│   │   │   ├── index.ts               # re-exports everything below
│   │   │   ├── runtime.ts             # createRuntime, AgentRuntime
│   │   │   ├── agents.ts              # loadAgents, AgentSet
│   │   │   ├── workflow.ts            # workflow() helper
│   │   │   ├── tool.ts                # defineTool, defineMcpSource
│   │   │   ├── testing.ts             # @render-agents/sdk/testing (mockModel, createTestRuntime)
│   │   │   └── types.ts               # all public type re-exports
│   │   └── package.json
│   ├── engine/                        # @render-agents/engine — default runner + LLM loop
│   │   ├── src/
│   │   │   ├── loop.ts                # runLoop — the core iterate/call/dispatch cycle
│   │   │   ├── model.ts               # ModelClient adapters (Anthropic, OpenAI)
│   │   │   ├── model-tiers.ts         # small/medium/large → concrete ModelSpec
│   │   │   ├── environment.ts         # Environment lifecycle (mount/dispose)
│   │   │   ├── runner.ts              # DefaultRunner implements AgentRunner
│   │   │   └── skills.ts              # load_skill tool + prompt assembly
│   │   └── package.json
│   ├── store/                         # @render-agents/store — persistence layer
│   │   ├── src/
│   │   │   ├── postgres.ts            # Postgres-backed RunStore + migrations
│   │   │   ├── memory.ts              # In-memory RunStore (local dev)
│   │   │   ├── tracer.ts              # Span emitter → RunStore
│   │   │   └── index.ts               # createRunStore (auto-selects by DATABASE_URL)
│   │   └── package.json
│   ├── gateway/                       # @render-agents/gateway — web service layer
│   │   ├── src/
│   │   │   ├── server.ts              # Hono app: routes, middleware
│   │   │   ├── sessions.ts            # Session + conversation state
│   │   │   ├── hitl.ts                # HITL approval gate enforcement
│   │   │   ├── oauth.ts               # Per-user OAuth token store
│   │   │   ├── streaming.ts           # SSE over Postgres LISTEN/NOTIFY
│   │   │   └── webhooks.ts            # Webhook discovery + dispatch
│   │   └── package.json
│   └── create-render-agent/           # npm create initializer / scaffolder
│       ├── template/
│       └── package.json
├── docs/
│   └── specs/
│       ├── 00-project-seed.md         # this document
│       ├── 01-*.md                    # sprint specs reference this
│       └── ...
├── turbo.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

### Package dependency graph

```
@render-agents/sdk
  └── @render-agents/engine  (default runner, re-exported)
  └── @render-agents/store   (tracer + store, re-exported)

@render-agents/gateway
  └── @render-agents/sdk
  └── @render-agents/store

create-render-agent
  └── (no runtime deps — scaffolds a project that depends on @render-agents/sdk)
```

### Build + publish

- **Monorepo:** pnpm workspaces + Turborepo
- **TypeScript:** strict mode, `NodeNext` module resolution, declaration emit
- **Target:** Node 20+, ESM only
- **Publish:** each `packages/*` publishes independently to npm

---

## 4. Project Convention — User-Facing Directory Layout

A project using the SDK follows this structure:

```
my-project/
├── agents/                           # markdown agent definitions
│   ├── _shared.md                    # merged into every agent's system prompt
│   ├── security.md
│   ├── performance.md
│   └── judge.md
├── tools/                            # tool sources (one or many tools per source)
│   ├── github/                       # multi-tool source
│   │   ├── index.ts                  # re-exports or defines all tools
│   │   ├── get-file.ts               # defineTool({ name: "get_file", ... })
│   │   └── create-pr.ts             # defineTool({ name: "create_pr", ... })
│   ├── web_fetch/index.ts            # single-tool source
│   └── brave_search/index.ts         # MCP source (many remote tools)
├── skills/                           # on-demand instruction content
│   └── security-patterns/SKILL.md
├── workflows/                        # orchestration pipelines
│   └── code-review/index.ts
├── webhooks/                         # inbound event adapters (auto-discovered)
│   └── github.ts
├── runners/                          # custom AgentRunner implementations (optional)
│   └── opencode.ts
├── render.yaml                       # Render deploy manifest (generated or hand-authored)
├── compose.yaml                      # local dev: Postgres, etc.
├── package.json
├── tsconfig.json
└── .env
```

### Discovery rules

| Directory | Key | Glob | Collision behavior |
|---|---|---|---|
| `agents/` | filename without `.md` | `*.md` (non-recursive, skip `_shared.md`) | Hard error |
| `tools/` | directory name (source id) | `*/index.ts` (single or array export) | Hard error on source id; hard error on model-facing tool name |
| `skills/` | directory name | `*/SKILL.md` | Hard error |
| `workflows/` | directory name | `*/index.ts` | Hard error |
| `webhooks/` | filename without ext | `*.ts` | Hard error |
| `runners/` | filename without ext | `*.ts` | Hard error |

All directories are optional. Missing directories are silently skipped unless an agent references a tool/skill from a missing directory. Collisions (two sources resolving to the same key) are always hard errors. Both are load-time failures — see the canonical fail-fast list in §6.5.

---

## 5. Data Models

All types below are the canonical contracts. Implementations must conform exactly. Types are defined in `@render-agents/sdk` and re-exported from the package root.

The subsections are numbered for stable cross-referencing, not grouped by layer. The map below shows which package each contract belongs to (subsection headings carry the same layer tag):

| Layer / package | Contracts |
|---|---|
| **Core SDK** (`@render-agents/sdk`) | §5.1 Agent · §5.2 Agent Set · §5.3 Model · §5.4 Messages · §5.5 Tool · §5.6 Tool Authoring · §5.7 Skill · §5.8 Environment · §5.9 Runner · §5.16 Workflow · §5.17 Webhook · §5.18 Idempotency · §5.19 Cancellation · §5.23 Runtime & Composition |
| **Engine** (`@render-agents/engine`) | §5.10 Model Client · §5.20 Cost Estimation |
| **Store** (`@render-agents/store`) | §5.11 Tracing · §5.12 Store · §5.21 Schedules |
| **Gateway** (`@render-agents/gateway`) | §5.13 Sessions · §5.14 HITL · §5.15 OAuth · §5.22 Connectors |

### 5.1 Agent (core)

```ts
interface AgentDefinition {
  name: string;
  /** Author-declared version string. Metadata only — no selection/resolution logic. Recorded on agent spans and run records for audit/repro ("which version produced this?"). */
  version?: string;
  model: ModelSpec;
  systemPrompt: string;
  tools: string[];
  skills?: SkillMetadata[];
  sampling?: SamplingParams;
  budget?: Budget;
  permissions?: Permissions;
  /** Optional JSON Schema for structured output. When set, the runner returns validated `AgentOutput.data`. */
  output?: Record<string, unknown>;
  plan?: RenderPlan;
  runner?: string;
}

interface Permissions {
  /** Resolved tool names that require HITL approval before execution. */
  requireApproval?: string[];
}

/**
 * Render Workflows instance type for a task run — Render's `plan` task option.
 * Values mirror Render's instance-type slugs; `standard` (1 CPU / 2 GB) is the
 * default. `pro_plus` / `pro_max` / `pro_ultra` require requesting workspace
 * access. Compute is bound to the task at definition/registration time: there
 * is no arbitrary cpu/memory, and the run-trigger API (startTask / REST) takes
 * only task + input — no per-run override. This is why §8.6 registers one
 * dispatch task per referenced plan.
 */
type RenderPlan =
  | "starter"
  | "standard"
  | "pro"
  // The following require requesting workspace access:
  | "pro_plus"
  | "pro_max"
  | "pro_ultra";

type AgentInput = string | Record<string, unknown>;

interface AgentOutput<T = unknown> {
  text: string;
  /** Validated structured output. Present only when the agent declares an `output` schema (§5.1, §8.8). */
  data?: T;
  usage: TokenUsage;
}

/**
 * Result of an agent invocation when inspected at a runtime boundary.
 * The happy path of `run()`/`task()` resolves to `AgentOutput` (completed).
 * On HITL pause, the runner throws `RunPaused` (control-flow signal); the
 * runtime catch boundary can surface a `PausedResult` for callers that inspect.
 */
type AgentResult =
  | ({ status: "completed" } & AgentOutput)
  | PausedResult;

interface PausedResult {
  status: "paused";
  reason: string;
  pendingApprovalIds: string[];
}

/** Thrown by the runner to unwind execution on HITL pause. Caught by the workflow/gateway runtime, which marks the run "paused". */
declare class RunPaused extends Error {
  readonly runId: string;
  readonly pendingApprovalIds: string[];
}
```

### 5.2 Agent Set (core)

```ts
interface AgentSet {
  get(id: string): Agent;
  get(ids: string[]): Agent[];
  has(id: string): boolean;
  all(): Agent[];
}

interface Agent {
  readonly name: string;
  readonly definition: AgentDefinition;
  /** `T` is the type of `AgentOutput.data` when the agent declares an `output` schema. */
  run<T = unknown>(input: AgentInput, opts?: RunOptions): Promise<AgentOutput<T>>;
  task<T = unknown>(input: AgentInput, opts?: TaskOptions): Promise<AgentOutput<T>>;
}

interface RunOptions {
  signal?: AbortSignal;
  runId?: string;
  parentSpanId?: string;
}

/**
 * Options for `agent.task()`. Compute is NOT overridable per dispatch — the
 * effective plan comes from the agent's frontmatter `plan` (or the default).
 * See §8.6 for the auto-wired plan-tier dispatch model.
 */
type TaskOptions = RunOptions;
```

### 5.3 Model (core)

```ts
interface ModelSpec {
  provider: "anthropic" | "openai";
  model: string;
  baseURL?: string;
  apiKeyEnv?: string;
}

type ModelTier = "small" | "medium" | "large";

interface SamplingParams {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

interface Budget {
  maxIterations?: number;
  maxTokens?: number;
  /** USD ceiling per agent invocation. Default 10; null or 0 disables it. Rules in §5.20, enforcement in §8.2. */
  maxCostUsd?: number | null;
  maxWallSeconds?: number;
}
```

### 5.4 Messages (core)

```ts
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

type MessageRole = "user" | "assistant" | "tool";

interface Message {
  role: MessageRole;
  content: ContentBlock[];
}
```

### 5.5 Tool (core)

```ts
interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  invoke(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

interface ToolResult {
  content: string;
  isError?: boolean;
}

interface ToolContext {
  env(name: string): string | undefined;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /**
   * Per-user OAuth connection for the given provider, resolved via the run's
   * `userId` against the OAuthStore. Returns undefined when there is no user
   * (system/cron runs) or no stored connection — OAuth-dependent tools should
   * return a clear error result in that case rather than throwing.
   */
  connection(provider: string): Promise<OAuthTokens | undefined>;
  /** SSRF-guarded fetch. Blocks private IPs, internal ranges, and metadata endpoints. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

interface ToolSource {
  readonly id: string;
  resolve(env: Environment): Promise<ResolvedSource>;
}

interface ResolvedSource {
  readonly tools: Tool[];
  close(): Promise<void>;
}
```

### 5.6 Tool Authoring (core)

A tool directory is a **source**. A source can provide one or many tools. Agents reference sources by directory name in frontmatter (`tools: [github]`).

```ts
interface DefineToolSpec {
  /** Tool name within the source. Required for multi-tool sources. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  invoke(input: unknown, ctx: ToolContext): Promise<ToolResult | string>;
}

function defineTool(spec: DefineToolSpec): ToolSource;

interface DefineMcpSpec {
  name?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: () => Record<string, string>;
}

function defineMcpSource(spec: DefineMcpSpec): ToolSource;
```

**Single-tool source:** `index.ts` default-exports one `ToolSource`. The model-facing tool name equals the directory name.

```ts
// tools/web_fetch/index.ts — model sees: "web_fetch"
export default defineTool({
  name: "web_fetch",
  description: "Fetch a URL",
  inputSchema: { ... },
  invoke: async (input, ctx) => { ... },
});
```

**Multi-tool source:** `index.ts` default-exports an array of `ToolSource`. Each tool is namespaced as `sourceId__toolName` to prevent cross-source collisions.

```ts
// tools/github/index.ts — model sees: "github__get_file", "github__create_pr"
import { defineTool } from "@render-agents/sdk";

export default [
  defineTool({
    name: "get_file",
    description: "Fetch file contents from a GitHub repo",
    inputSchema: { ... },
    invoke: async (input, ctx) => { ... },
  }),
  defineTool({
    name: "create_pr",
    description: "Create a pull request",
    inputSchema: { ... },
    invoke: async (input, ctx) => { ... },
  }),
];
```

Multi-tool sources can also split tools into sibling files and re-export:

```ts
// tools/github/index.ts
export { default as get_file } from "./get-file.js";
export { default as create_pr } from "./create-pr.js";
```

**MCP source:** `index.ts` default-exports a `defineMcpSource()`. The MCP server's tools are namespaced the same way: `sourceId__toolName`.

```ts
// tools/brave_search/index.ts — model sees: "brave_search__web_search", etc.
export default defineMcpSource({
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-brave-search"],
});
```

**Naming rule:**

| Source type | # tools | Model-facing name |
|---|---|---|
| Single `ToolSource` | 1 | `sourceId` (e.g. `web_fetch`) |
| Array of `ToolSource` | N | `sourceId__toolName` (e.g. `github__get_file`) |
| `defineMcpSource` | N | `sourceId__toolName` (e.g. `brave_search__web_search`) |

Cross-source collisions on the final model-facing name are hard errors at load time (§6.5).

### 5.7 Skill (core)

A skill is on-demand instruction content the model can pull into context when it's relevant — not always-on system-prompt text. See §8.9 for the loading model.

```ts
interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  whenToUse: string;
  content: string;
}

interface SkillRegistry {
  get(id: string): SkillMetadata;
  has(id: string): boolean;
  ids(): string[];
}
```

**Authoring (`SKILL.md`).** A skill is a directory under `skills/` containing a `SKILL.md`. The directory name is the skill `id`. YAML frontmatter supplies the metadata advertised to the model; the body is the `content` injected on load.

```markdown
---
name: Security patterns
description: Common web-app vulnerability patterns and how to spot them.
whenToUse: When reviewing code or diffs for security issues (authn, injection, SSRF, secrets).
---

When auditing for security issues, work through these categories in order:

1. **Authentication & session** — ...
2. **Injection** (SQL, command, template) — ...
3. **SSRF & request forgery** — ...
...
```

| `SkillMetadata` field | Source |
|---|---|
| `id` | Directory name (`skills/security-patterns/` → `security-patterns`) |
| `name` | `SKILL.md` frontmatter |
| `description` | `SKILL.md` frontmatter |
| `whenToUse` | `SKILL.md` frontmatter |
| `content` | `SKILL.md` body (everything after the frontmatter) |

**Id → metadata resolution.** Frontmatter `skills:` lists ids (`string[]`); `loadAgents` resolves each id against the `SkillRegistry` and stores the fully-resolved `SkillMetadata[]` (including `content`) on `AgentDefinition.skills`, so the runner can serve `load_skill` without re-reading disk. An unresolvable id is a load-time error (§6.5).

### 5.8 Environment (core)

```ts
interface Environment {
  readonly logger: Logger;
  readonly signal: AbortSignal;
  env(name: string): string | undefined;
  mount(toolIds: string[]): Promise<MountedTools>;
  dispose(): Promise<void>;
}

interface MountedTools {
  readonly tools: Tool[];
  byName(name: string): Tool | undefined;
}

interface ToolRegistry {
  get(id: string): ToolSource;
  has(id: string): boolean;
  ids(): string[];
}
```

### 5.9 Runner (core)

```ts
interface AgentRunner {
  run(agent: AgentDefinition, input: AgentInput, ctx: RunContext): Promise<AgentOutput>;
}

interface RunContext {
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly runId: string;
  readonly parentSpanId?: string;
  /** The user this run belongs to (from the gateway's auth). Undefined for system/cron runs. Used to resolve per-user OAuth in ToolContext. */
  readonly userId?: string;
  env(name: string): string | undefined;

  mountTools(toolIds: string[]): Promise<MountedTools>;

  /**
   * HITL gate. Production (gateway) persists an ApprovalRequest and returns
   * `{ status: "pending" }`; in-process behavior follows the approval mode.
   * Full pause/resume mechanics are in §8.3 (dispatch), §8.3.2 (in-process
   * modes), and §8.7 (resume semantics). It does NOT block for hours.
   */
  requestApproval(toolName: string, input: unknown): Promise<ApprovalResult>;

  /** Budget accounting: called by the runner after each LLM call. */
  recordUsage(usage: TokenUsage, cost?: number): void;

  /** Streaming: emit a progress event to the gateway. */
  emit(event: RunEvent): void;

  /** Persist a message for checkpoint-resume (called after each turn). */
  persistMessage(agentName: string, msg: Message): Promise<void>;

  /** Load persisted messages for a resumed run. Returns [] for fresh runs. */
  loadMessages(agentName: string): Promise<Message[]>;

  /** Idempotent tool dispatch: check if a tool call already has a stored result. */
  checkIdempotency(toolCallId: string): Promise<ToolResult | undefined>;

  /** Record a completed tool call for idempotency. */
  recordToolCall(toolCallId: string, toolName: string, input: unknown, result: ToolResult): Promise<void>;

  /** Cooperative cancellation: check if this run has been cancelled. */
  isCancelled(): Promise<boolean>;
}

type ApprovalResult =
  | { approved: true }
  | { approved: false; reason?: string }
  | { status: "pending"; approvalRequestId: string };

type RunEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; result: ToolResult }
  | { type: "status"; status: string };
```

The `RunContext` is the full platform contract a runner must interact with. It carries HITL, budget, tracing, streaming, and tool mounting — not just the prompt. Custom runners that skip these hooks degrade gracefully (the in-process context stubs them), but production runners must honor them.

### 5.10 Model Client (engine)

```ts
interface ModelClient {
  complete(args: CompleteArgs): Promise<CompleteResult>;
  /**
   * Streaming variant. Yields incremental deltas and returns the final
   * `CompleteResult`. The engine forwards `text_delta` events via
   * `RunContext.emit` → SSE `text.delta`. Optional: implementations without
   * native streaming omit it, and the engine falls back to `complete()`
   * (one terminal text event). Token-level deltas are post-MVP (§11.3).
   */
  stream?(args: CompleteArgs): AsyncGenerator<ModelStreamEvent, CompleteResult>;
}

type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; partialInput: string };

interface CompleteArgs {
  model: ModelSpec;
  system: string;
  tools: ToolSchema[];
  messages: Message[];
  sampling?: SamplingParams;
  /** Structured-output request. When set, the model is asked to return JSON conforming to this schema (provider-native when supported). */
  responseFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  signal: AbortSignal;
}

interface CompleteResult {
  content: ContentBlock[];
  usage: TokenUsage;
  stopReason: string;
}

interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Retry policy for the default ModelClient. Retries transient failures
 * (network errors + `retryableStatuses`) with exponential backoff + jitter,
 * honoring a `Retry-After` header when present. Retries are transparent: they
 * are NOT new loop iterations and add no token budget; `maxWallSeconds` still
 * bounds total elapsed time.
 */
interface RetryPolicy {
  maxRetries: number;          // default 3
  initialDelayMs: number;      // default 500
  maxDelayMs: number;          // default 30000
  backoffMultiplier: number;   // default 2
  retryableStatuses: number[]; // default [429, 500, 502, 503, 504]
}
```

### 5.11 Tracing (store)

```ts
type SpanKind = "workflow" | "agent" | "llm" | "tool" | "step";

interface SpanInfo {
  spanId: string;
  parentSpanId?: string;
  runId: string;
  name: string;
  kind: SpanKind;
}

type SpanOutcome =
  | { ok: true; output: unknown }
  | { ok: false; error: string };

interface Tracer {
  onStart(span: SpanInfo, input: unknown): void;
  onEnd(span: SpanInfo, outcome: SpanOutcome): void;
}
```

### 5.12 Store (store)

```ts
type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
type SpanStatus = "running" | "ok" | "error";

interface RunRecord {
  id: string;
  workflow: string;
  status: RunStatus;
  input?: unknown;
  result?: unknown;
  error?: string;
  trigger?: string;
  /** Accumulated USD cost across all agent invocations in this run. */
  totalCostUsd: number;
  /** Serialized loop cursor for checkpoint-resume. */
  cursor?: RunCursor;
  conversationId?: string;
  userId?: string;
  /** Agent version, when this run corresponds to a single agent invocation (audit/repro; §5.1). */
  agentVersion?: string;
  startedAt: string;
  finishedAt?: string;
}

interface RunCursor {
  usage: TokenUsage;
  iteration: number;
}

interface SpanRecord {
  id: string;
  runId: string;
  parentId?: string;
  seq: number;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  attributes?: Record<string, unknown>;
}

/** LLM loop message persisted to Postgres for inspectability and resume. */
interface RunMessageRecord {
  id: string;
  runId: string;
  agentName: string;
  seq: number;
  role: MessageRole;
  content: ContentBlock[];
  createdAt: string;
}

interface RunStore {
  init(): Promise<void>;

  createRun(run: RunRecord): Promise<void>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<void>;
  getRun(id: string): Promise<RunRecord | undefined>;
  listRuns(opts?: ListRunsOptions): Promise<RunRecord[]>;

  startSpan(span: SpanRecord): Promise<void>;
  endSpan(id: string, patch: Partial<SpanRecord>): Promise<void>;
  listSpans(runId: string): Promise<SpanRecord[]>;

  /** Persist an LLM loop message (called after each model turn and tool result). */
  appendRunMessage(msg: RunMessageRecord): Promise<void>;
  /** Retrieve persisted messages for checkpoint-resume. */
  getRunMessages(runId: string, agentName: string): Promise<RunMessageRecord[]>;

  /** Memoized workflow step result (ctx.step). Returns existing result if present. */
  getStepResult(runId: string, name: string): Promise<{ value: unknown } | undefined>;
  /** Persist a memoized workflow step result keyed by (runId, name). */
  putStepResult(runId: string, name: string, value: unknown): Promise<void>;

  close(): Promise<void>;
}

interface ListRunsOptions {
  workflow?: string;
  status?: RunStatus;
  limit?: number;
  /** Keyset cursor: runs older than this ID. More efficient than offset for large sets. */
  before?: string;
}
```

### 5.13 Sessions (gateway)

```ts
interface Session {
  id: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  lastActiveAt: string;
}

interface Conversation {
  id: string;
  sessionId: string;
  messages: ConversationMessage[];
  createdAt: string;
}

interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  runId?: string;
  createdAt: string;
}

interface SessionStore {
  createSession(session: Session): Promise<void>;
  getSession(id: string): Promise<Session | undefined>;
  updateSession(id: string, patch: Partial<Session>): Promise<void>;
  createConversation(conv: Conversation): Promise<void>;
  getConversation(id: string): Promise<Conversation | undefined>;
  appendMessage(conversationId: string, msg: ConversationMessage): Promise<void>;
  listConversations(sessionId: string): Promise<Conversation[]>;
}
```

### 5.14 HITL (gateway)

```ts
interface ApprovalRequest {
  id: string;
  runId: string;
  toolName: string;
  toolInput: unknown;
  agentName: string;
  status: "pending" | "approved" | "denied";
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  reason?: string;
}

interface ApprovalStore {
  createRequest(req: ApprovalRequest): Promise<void>;
  getRequest(id: string): Promise<ApprovalRequest | undefined>;
  listPending(runId: string): Promise<ApprovalRequest[]>;
  resolve(id: string, decision: { approved: boolean; resolvedBy?: string; reason?: string }): Promise<void>;
}
```

### 5.15 OAuth (gateway)

```ts
interface OAuthConnection {
  id: string;
  userId: string;
  provider: string;
  accessToken: string;      // encrypted at rest
  refreshToken?: string;    // encrypted at rest
  expiresAt?: string;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
}

interface OAuthStore {
  getConnection(userId: string, provider: string): Promise<OAuthConnection | undefined>;
  upsertConnection(conn: OAuthConnection): Promise<void>;
  deleteConnection(userId: string, provider: string): Promise<void>;
  listConnections(userId: string): Promise<OAuthConnection[]>;
}
```

### 5.16 Workflow (core)

```ts
/** With config. */
function workflow(
  opts: WorkflowOptions,
  handler: (ctx: WorkflowContext) => Promise<unknown>,
): WorkflowDefinition;

/** Handler only — no config, name inferred from directory. */
function workflow(
  handler: (ctx: WorkflowContext) => Promise<unknown>,
): WorkflowDefinition;

interface WorkflowOptions {
  /** Root task timeout in seconds. */
  timeout?: number;
  /**
   * Automatic retries of the root handler on failure. Default 0.
   * Render retries re-execute the WHOLE handler (no deterministic replay), so
   * the default avoids duplicate side effects. Durability comes from child
   * agent.task() runs and Postgres checkpoint/resume, not handler re-runs (§8.7).
   */
  retries?: number;
  /** Plan for the root task container. */
  plan?: RenderPlan;
}

interface WorkflowContext {
  readonly runId: string;
  readonly trigger: string;
  readonly input: unknown;
  /**
   * The project's full AgentSet (every agent in agents/), bound to THIS run.
   * The ONLY supported way to access agents inside a handler — see §5.23 for
   * why a module-level loadAgents() closure must not be used here.
   */
  readonly agents: AgentSet;
  readonly tracer: Tracer;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  /** The user this run belongs to (from the gateway's auth). Undefined for system/cron runs. Propagates to child agent runs and tool contexts. */
  readonly userId?: string;

  /**
   * Memoized deterministic step. The result is persisted by (runId, name); on
   * handler re-execution (resume/retry) the stored result is returned without
   * re-running `fn`. Use this for any side-effecting or non-deterministic work
   * in the handler body (§8.7). Step names must be unique within a workflow.
   */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

interface WorkflowDefinition {
  /** Set at discovery time from `workflows/<dir>` directory name. */
  readonly name: string;
  readonly options: WorkflowOptions;
  dispatch(input: unknown, trigger?: string): Promise<RunRecord>;
}
```

The `workflow()` helper binds **config + handler** into a Render Workflows root `task()`. The name is always inferred from the directory (`workflows/code-review/index.ts` → `"code-review"`) — it is set by the loader at discovery time, not by the author. Config is optional.

```ts
// workflows/code-review/index.ts

// Default config
export default workflow(async (ctx) => {
  const { patches } = ctx.input;
  const findings = await Promise.all(
    ctx.agents.get(["security", "performance"]).map(a => a.task({ patches }))
  );
  return ctx.agents.get("judge").run({ findings });
});

// With config
export default workflow({
  timeout: 600,
  retries: 2,
  plan: "standard",
}, async (ctx) => {
  // ...
});
```

### 5.17 Webhook (core)

```ts
interface WebhookAdapter {
  readonly name: string;
  match(req: Request): WebhookMatch | null;
  parse(req: Request): Promise<unknown>;
}

interface WebhookMatch {
  workflow: string;
  trigger: string;
}
```

### 5.18 Idempotency (core)

Tool calls must be safe to retry. On checkpoint-resume or task retry, the runner must not re-execute tool calls that already produced results.

```ts
/** Deterministic key for deduplicating tool call execution. */
function idempotencyKey(runId: string, toolCallId: string): string;

interface ToolCallRecord {
  id: string;
  runId: string;
  idempotencyKey: string;
  toolName: string;
  input: unknown;
  result?: ToolResult;
  status: "pending" | "completed" | "error";
  startedAt: string;
  finishedAt?: string;
}

interface ToolCallStore {
  /** Returns existing result if the key has been seen, undefined otherwise. */
  checkIdempotency(key: string): Promise<ToolResult | undefined>;
  recordToolCall(record: ToolCallRecord): Promise<void>;
  completeToolCall(id: string, result: ToolResult): Promise<void>;
}
```

The `idempotencyKey` is `SHA-256(runId + toolCallId)`. Before dispatching a tool, the runner checks the store — if a result exists for this key, it short-circuits and returns the stored result. This is what makes checkpoint-resume safe for non-idempotent tools.

> **Two distinct idempotency keys.** This **tool-call key** (`SHA-256(runId + toolCallId)`) dedupes *tool execution* within a run. The separate **dispatch key** (`SHA-256(runId + agentName + callSeq)`, see `DispatchOptions` in §5.23 and §8.6) dedupes *child-task dispatch* so a resumed handler does not re-launch completed `agent.task()` runs. Different layers, different inputs.

### 5.19 Cancellation (core)

Runs must be cancellable from outside the executing process. The gateway sets a cancel flag; the loop polls it cooperatively.

```ts
interface CancelStore {
  /** Set the cancel flag for a run. */
  requestCancel(runId: string): Promise<void>;
  /** Check if a run has been cancelled. Polled each iteration. */
  isCancelled(runId: string): Promise<boolean>;
  /** Clear the cancel flag (on run completion). */
  clearCancel(runId: string): Promise<void>;
}
```

The default implementation checks the `runs` row in Postgres (`status = 'cancelled'`). Cancel checks happen once per loop iteration, between LLM calls that take seconds — the ~5-10ms query overhead is negligible. No KV dependency required.

The loop checks `isCancelled` at the top of each iteration alongside budget checks. On cancellation, the run status is set to `"cancelled"` and the loop exits cleanly. Paused runs (HITL) can be cancelled directly by setting the DB status. The `CancelStore` interface allows swapping in a KV-backed implementation as a future optimization if needed.

### 5.20 Cost Estimation (engine)

Budget enforcement for `maxCostUsd` requires a pricing function that converts token usage to USD.

```ts
interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

/** Known model pricing table. Updated as new models ship. */
const MODEL_PRICING: Record<string, ModelPricing>;

/** Estimate cost in USD for a single LLM call. */
function estimateCost(model: string, usage: TokenUsage): number;
```

The pricing table is a simple record keyed by model string. The `estimateCost` function is called after each `complete()` call, and the result is accumulated on the run's `totalCostUsd`.

**Unknown models** default to `0` cost (cost budget not enforced — not a hard error), but with a **loud warning emitted at load time** (visible in CI), repeated at runtime. The other budgets (`maxIterations`, `maxTokens`, `maxWallSeconds`) still apply regardless, so an unpriced model is never fully unbounded.

**Custom/unlisted model pricing** is supplied by extending the table via `createRuntime({ pricing })` (merged over the built-in `MODEL_PRICING`). Once registered, the model is priced and the cost budget is enforced normally.

**Explicit opt-out:** set `budget.maxCostUsd: null` (or `0`) to deliberately disable the cost ceiling. This silences the unknown-pricing warning for that agent — the choice is then explicit rather than accidental.

### 5.21 Schedules (store)

Scheduled workflow triggers are managed at runtime, not just via Render Cron config.

```ts
interface ScheduleRecord {
  id: string;
  workflow: string;
  cronExpression: string;
  input?: unknown;
  enabled: boolean;
  lastRunId?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleStore {
  createSchedule(schedule: ScheduleRecord): Promise<void>;
  getSchedule(id: string): Promise<ScheduleRecord | undefined>;
  updateSchedule(id: string, patch: Partial<ScheduleRecord>): Promise<void>;
  deleteSchedule(id: string): Promise<void>;
  listSchedules(): Promise<ScheduleRecord[]>;
  listEnabled(): Promise<ScheduleRecord[]>;
}
```

**MVP:** scheduled triggers use Render Cron directly in `render.yaml`. A cron job hits `POST /workflows/:name` on a schedule — no schedules table, no runtime API, no reconciliation needed. The `ScheduleStore` interface and schema above are the contract for runtime-managed schedules in a future sprint.

### 5.22 Connectors (package-contributed webhooks)

Tool packages can contribute inbound webhook endpoints alongside their tools. This is how GitHub, Slack, and Linear integrations register their own webhook receivers.

```ts
interface ConnectorSpec {
  /** Route key: mounted at `/connectors/:key`. */
  key: string;
  /** Human-readable name. */
  name: string;
  /** Handle the inbound webhook request. Returns a workflow dispatch. */
  handle(req: Request, ctx: ConnectorContext): Promise<WebhookMatch | null>;
}

interface ConnectorContext {
  env(name: string): string | undefined;
  readonly logger: Logger;
}
```

Connectors are contributed by tool packages via an optional `connectors` export. The gateway auto-discovers them at startup and mounts each at `/connectors/:key`. User-authored `webhooks/` and package-contributed connectors share the same dispatch mechanism but live in separate namespaces (no collisions).

### 5.23 Runtime & Composition (core)

Agents returned by `loadAgents()` are inert definitions until they are bound to a **runtime** — the composition root that supplies the model client, store, tracer, runner registry, and (in production) the task dispatcher. Both the gateway and the workflow service construct the *same* `AgentRuntime` via `createRuntime()`, so wiring is identical across services.

```ts
interface AgentRuntime {
  readonly store: RunStore;
  readonly tracer: Tracer;
  readonly model: ModelClient;
  readonly runners: RunnerRegistry;
  /** Dispatches agents as Render Workflow tasks. Absent when no workflow server is detected (local fallback to in-process run). */
  readonly dispatcher?: TaskDispatcher;
}

interface RunnerRegistry {
  get(name: string): AgentRunner;
  has(name: string): boolean;
}

interface TaskDispatcher {
  /** Dispatch an agent run as a Render task on the plan-tier matching `plan`. */
  dispatch(agentName: string, input: AgentInput, opts: DispatchOptions): Promise<AgentOutput>;
}

interface DispatchOptions {
  runId: string;
  parentSpanId?: string;
  /** Propagated to the child run so it shares the caller's user/OAuth identity. */
  userId?: string;
  /** Deterministic key — SHA-256(runId + agentName + callSeq) — for idempotent re-dispatch (§8.6). */
  idempotencyKey: string;
  plan?: RenderPlan;
  signal?: AbortSignal;
}

/** Builds a runtime, auto-detecting store, model, and dispatcher from the environment. */
function createRuntime(opts?: CreateRuntimeOptions): Promise<AgentRuntime>;

/**
 * All fields are optional overrides. When omitted, each is auto-detected from
 * the environment per the Auto-detection rules table below.
 */
interface CreateRuntimeOptions {
  store?: RunStore;
  tracer?: Tracer;
  model?: ModelClient;
  /** Custom/unlisted model pricing, merged over the built-in MODEL_PRICING table (§5.20). */
  pricing?: Record<string, ModelPricing>;
  /** Override the default ModelClient retry policy (§5.10). Also configurable via env. */
  retry?: Partial<RetryPolicy>;
  runners?: RunnerRegistry;
  /** Override the auto-wired Render Workflows dispatcher (§8.6). */
  dispatcher?: TaskDispatcher;
}
```

**Binding.** `loadAgents(dir?, runtime?)` accepts an optional runtime. When omitted, the loader lazily builds one with `createRuntime()` (env-driven defaults). Every `Agent` produced by the set closes over this runtime, so `agent.run()` / `agent.task()` already know which model, store, tracer, runner, and dispatcher to use — there is no global singleton and no per-call dependency wiring.

**`loadAgents` is bootstrapping, not in-handler API.** The gateway and workflow service call `loadAgents()` once at startup to build the project AgentSet; the workflow runtime then exposes a run-scoped view of that same set as `ctx.agents` for each run. **Inside a workflow handler, always use `ctx.agents`** — it carries the current run's id, tracer, and parent span so spans nest and dispatch/idempotency keys are correct. Use a module-level `loadAgents()` closure only *outside* a handler (scripts, tests, gateway dispatch); a closure used inside a handler is not run-scoped and will mis-correlate traces. There is exactly one in-handler path (`ctx.agents`).

**Auto-detection rules:**

| Dependency | Default resolution |
|---|---|
| Store | Postgres if `DATABASE_URL` set, else in-memory |
| Model client | Provider inferred from the agent's `model` (or its `apiKeyEnv`) |
| Runner registry | `default` → `DefaultRunner`, plus adapters in `runners/` |
| Dispatcher | Render Workflows dispatcher when `RENDER_SDK_SOCKET_PATH` / `RENDER_USE_LOCAL_DEV` present; otherwise in-process fallback (`.task()` runs as `.run()`) |

---

## 6. Agent Markdown Schema

### 6.1 Format

An agent is a `.md` file under `agents/`. YAML frontmatter declares configuration. The body is the system prompt.

```markdown
---
model: claude-sonnet-4-6
tools: [github, sandbox]
skills: [security-patterns]
permissions:
  requireApproval: [github__push_code, github__merge_pr]
budget:
  maxIterations: 30
  maxTokens: 500000
  maxCostUsd: 2
  maxWallSeconds: 300
output:
  type: object
  properties:
    decision: { type: string, enum: [approve, reject] }
    reasons: { type: array, items: { type: string } }
  required: [decision]
plan: standard
sampling:
  temperature: 0
runner: default
---

You are a security reviewer. Given a set of file patches, analyze each for...
```

### 6.2 Frontmatter fields

| Field | Type | Default | Validated at |
|---|---|---|---|
| `model` | `string` (tier name or model id) | `"medium"` | Load time |
| `provider` | `"anthropic" \| "openai"` | Inferred from model | Load time |
| `tools` | `string[]` | `[]` | Load time (source ids or `sourceId__toolName`) |
| `skills` | `string[]` | `[]` | Load time (resolved against `skills/`) |
| `permissions.requireApproval` | `string[]` | `[]` | Load time |
| `output` | JSON Schema (object) | (none — text only) | Load time (valid JSON Schema) |
| `budget.maxIterations` | `number` | `50` | Load time |
| `budget.maxTokens` | `number` | `1000000` | Load time |
| `budget.maxCostUsd` | `number` | `10` (per agent) | Load time |
| `budget.maxWallSeconds` | `number` | (none) | Load time |
| `plan` | `RenderPlan` (Render instance-type slug) | `standard` | Load time (must be a known plan; `pro_plus`/`pro_max`/`pro_ultra` need workspace access) |
| `sampling.temperature` | `number` | (provider default) | Load time |
| `sampling.topP` | `number` | (provider default) | Load time |
| `sampling.maxOutputTokens` | `number` | (provider default) | Load time |
| `runner` | `string` | `"default"` | Load time (resolved against `runners/`) |

Unknown fields are hard errors at load time.

**Tool reference resolution:** the `tools` array accepts both source ids and individual tool names:

```markdown
# All tools from the github source
tools: [github]

# Only specific tools from a multi-tool source
tools: [github__get_file, github__create_pr]

# Mix: all of one source, specific tools from another
tools: [web_fetch, github__get_file]
```

- A bare source id (`github`) → mount the source, expose all its tools to the model.
- A namespaced tool name (`github__get_file`) → mount the source (if not already), but only expose the named tool. Other tools from the same source are not visible to the model.
- Unknown source id or tool name → hard error at load time.

**`requireApproval` references resolved names.** It matches against the agent's **expanded tool set** — the resolved model-facing names (`github__merge_pr`, or flat `web_fetch` for single-tool sources), not source ids. Listing a bare source id in `tools` (e.g. `github`) expands to all of that source's resolved tool names for matching. Validation runs against this expanded set. There is no allow/deny list: `tools[]` is the sole allowlist, and only declared tools are ever mounted or presented to the model.

### 6.3 Model tiers

| Tier | Provider | Model |
|---|---|---|
| `small` | anthropic | `claude-haiku-4-5` |
| `medium` | anthropic | `claude-sonnet-4-6` |
| `large` | anthropic | `claude-opus-4-6` |

Raw model strings (e.g. `gpt-4o`, `claude-opus-4-6`) are passed through. Provider is inferred from the model name if not set explicitly.

### 6.4 `_shared.md`

If `agents/_shared.md` exists, it provides shared defaults merged into every agent.

**Body merge:** `_shared.md` body + `\n\n` + agent body (prepend; Decision #1).

**Frontmatter merge (deep):** the agent definition is computed by deep-merging `_shared.md` frontmatter with the agent's frontmatter, per field type:

| Field type | Examples | Merge rule |
|---|---|---|
| Nested objects | `budget`, `permissions`, `sampling` | Deep merge per leaf; agent leaf wins on conflict, shared leaves preserved otherwise |
| Arrays | `tools`, `skills`, `permissions.requireApproval` | Union + dedupe (shared ∪ agent) |
| Scalars | `model`, `plan`, `runner`, `version` | Agent wins → falls back to shared → built-in default |

Example: `_shared.md` sets `budget: { maxIterations: 30, maxCostUsd: 10 }` and an agent sets `budget: { maxCostUsd: 2 }`. The merged budget is `{ maxIterations: 30, maxCostUsd: 2 }` — the shared `maxIterations` is preserved.

### 6.5 Validation rules (canonical fail-fast list)

This is the canonical list of hard errors raised at `loadAgents()` time. Other sections reference it rather than restating individual rules.

**Discovery & collisions** (§4, §5.6):

- Two sources resolving to the same key (agent name, tool source id, resolved model-facing tool name, skill, workflow, webhook, or runner) — see the §4 discovery table
- A tool source resolving to a reserved model-facing name (`load_skill`, §8.9)
- An agent references a tool/skill from a directory that does not exist

**Frontmatter & references:**

- Unknown frontmatter fields
- Tool reference not resolvable: source id not found in `tools/`, or namespaced tool name references a source that exists but doesn't contain that tool
- Skill name not found in `skills/` registry
- Model tier or model string not recognized
- `plan` not a known `RenderPlan` slug
- `output` is not a valid JSON Schema
- Runner name not found in `runners/` or not `"default"`
- `requireApproval` references a name not in the agent's **expanded tool set** (see §6.2 for how source ids expand to resolved model-facing names)
- Budget values are non-positive (except `maxCostUsd`, which accepts `null` or `0` to explicitly disable the cost ceiling)
- Empty system prompt body

---

## 7. Public API Surface

### 7.1 `@render-agents/sdk` exports

```ts
// Runtime + agent loading
export function createRuntime(opts?: CreateRuntimeOptions): Promise<AgentRuntime>;
export function loadAgents(dir?: string, runtime?: AgentRuntime): Promise<AgentSet>;

// Workflow definition (2 overloads: opts+handler, handler-only)
export function workflow(
  optsOrHandler: WorkflowOptions | ((ctx: WorkflowContext) => Promise<unknown>),
  handler?: (ctx: WorkflowContext) => Promise<unknown>,
): WorkflowDefinition;

// Tool authoring
export function defineTool(spec: DefineToolSpec): ToolSource;
export function defineMcpSource(spec: DefineMcpSpec): ToolSource;

// Functions
export { idempotencyKey, estimateCost };

// Every type defined in §5 (data models) is re-exported from the package root.
// The §5 definitions are canonical; index.ts re-exports them verbatim, so the
// full list is intentionally not duplicated here.
export type { /* …all §5 types… */ };
```

Beyond the functions above, `@render-agents/sdk` re-exports every type defined in §5 from its package root; those definitions are canonical, so they aren't re-enumerated here. (`RunPaused` is a class, so it is also a runtime export, not type-only.) The `@render-agents/sdk/testing` subpath (§7.4) ships `mockModel` and `createTestRuntime` separately.

### 7.2 `loadAgents` behavior

```ts
async function loadAgents(dir?: string, runtime?: AgentRuntime): Promise<AgentSet>;
```

1. `dir` defaults to `"./agents"` relative to the project root.
2. `runtime` defaults to `await createRuntime()` (env-driven auto-detection — see §5.23).
3. Scans `dir` for `*.md` files (non-recursive). Skips `_shared.md`.
4. Parses each file: extracts YAML frontmatter and body.
5. If `_shared.md` exists, loads it and merges into each definition.
6. Loads `tools/` and `skills/` registries from sibling directories.
7. Validates every frontmatter field. Fails fast on the first error.
8. Resolves model spec (tier or raw string) and `plan` (must be a known `RenderPlan`).
9. Binds every `Agent` to the `runtime` (model, store, tracer, runner registry, dispatcher).
10. Returns an `AgentSet` with `.get()`, `.has()`, `.all()`.

### 7.3 `Agent.run` vs `Agent.task`

| | `agent.run(input)` | `agent.task(input)` |
|---|---|---|
| Execution | In-process | Render Workflow task (isolated container) |
| Use case | Lightweight steps, judges, local dev | Production parallelism, heavy compute |
| Container | Shares the caller's process | Own container on the agent's `plan` |
| Retries | None (caller manages) | Render Workflows retry policy |
| Persistence | Same store as caller | Same store (Postgres in production) |
| Tracing | Same trace context | Spans correlate via `runId` + `parentSpanId` |

Both methods return `Promise<AgentOutput>` with the same shape. Pipeline code composes them freely (inside a handler, via `ctx.agents` — see §5.16):

```ts
const findings = await Promise.all(
  ctx.agents.get(["security", "performance", "ux"])
    .map(a => a.task({ patches }))
);
const decision = await ctx.agents.get("judge").run({ findings });
```

### 7.4 Testing utilities (`@render-agents/sdk/testing`)

Because the runtime is injectable (§5.23), tests run the *real* loop against a mock model and an in-memory store — no network, no Postgres, no Render Workflows. Shipped as a subpath export (no extra package):

```ts
function mockModel(
  handler: (args: CompleteArgs) => CompleteResult | Promise<CompleteResult>,
): ModelClient;

/** In-memory runtime for tests: memory store, provided/mock model, no dispatcher (so `.task()` falls back to `.run()`). */
function createTestRuntime(opts?: Partial<CreateRuntimeOptions>): Promise<AgentRuntime>;
```

```ts
import { loadAgents } from "@render-agents/sdk";
import { mockModel, createTestRuntime } from "@render-agents/sdk/testing";

const model = mockModel((args) => {
  // Assert on args.system / args.tools / args.messages, and script the reply
  // (text, tool_use sequences, or structured output) as a CompleteResult.
  return { content: [{ type: "text", text: '{"decision":"approve"}' }], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: "end_turn" };
});

const runtime = await createTestRuntime({ model });
const agents = await loadAgents("./agents", runtime);

const { data } = await agents.get("judge").run<{ decision: string }>({ findings: [] });
expect(data?.decision).toBe("approve");
```

The programmable handler lets tests assert on what the agent sent and drive multi-turn tool-call flows deterministically. Record/replay of real provider responses is post-MVP.

---

## 8. Execution Model

### 8.1 Loop internals

Before the first iteration, the runner assembles the system prompt (agent body + `_shared.md` + skill catalog, §8.9) and mounts the agent's tools — including the built-in `load_skill` tool when the agent declares any skills. Then it executes this cycle (`load_skill` is dispatched like any other `tool_use` in step 7):

```
[user input]
    │
    ▼
┌─ ITERATE ──────────────────────────────────────┐
│  1. Check cancellation (ctx.isCancelled)        │
│  2. Check budget (iterations, tokens, cost)     │
│  3. Check abort signal                          │
│  4. Call model (LLM span)                       │
│  5. Persist assistant message                   │
│  6. If stop_reason = end_turn → return text     │
│  7. For each tool_use in response:              │
│     a. Check idempotency → short-circuit if hit │
│     b. Check requireApproval → HITL gate        │
│     c. Validate input vs inputSchema            │
│     d. Dispatch tool (tool span)                │
│     e. Record tool call for idempotency         │
│     f. Collect tool_result                      │
│  8. Persist tool message                        │
│  9. Go to 1                                     │
└─────────────────────────────────────────────────┘
```

### 8.2 Budget enforcement

| Budget field | Default | Behavior when exceeded |
|---|---|---|
| `maxIterations` | 50 | Error: "maxIterations reached" |
| `maxTokens` | 1,000,000 | Error: "token budget exhausted" |
| `maxCostUsd` | 10 | Error: "cost budget exhausted" |
| `maxWallSeconds` | (none) | AbortSignal fires via `setTimeout` |

Budgets are **per agent invocation** (the `budget` block is an agent-level field) and are checked at the top of each iteration, before the LLM call. Cost is computed via `estimateCost(model, usage)` after each `complete()` call (pricing rules in §5.20): it is accumulated against the agent invocation's running total for budget enforcement, and also added to the run-wide `RunRecord.totalCostUsd` for reporting/attribution.

### 8.3 Tool dispatch

Tools are dispatched sequentially within a turn. Parallel tool dispatch is a future optimization.

For each `tool_use` block:
1. **Idempotency check** → call `ctx.checkIdempotency(toolCallId)`. If a stored result exists, return it immediately without re-executing. This makes checkpoint-resume and task retries safe for non-idempotent tools.
2. **Approval gate** → if `requireApproval` includes this tool name and the tool call has not been pre-approved, invoke `ctx.requestApproval()`:
   - On approval (`{ approved: true }`): continue to dispatch.
   - On denial (`{ approved: false }`): return error result.
   - On pause (`{ status: "pending" }`, production HITL): write a **placeholder `tool_result`** for all pending `tool_use` blocks in this turn (prevents provider 400 errors on resume, since providers require all `tool_use` blocks to have matching results), set run status to `"paused"`, and throw `RunPaused` carrying the pending approval id(s). The runtime catch boundary marks the run paused and (in a workflow) lets the signal unwind the handler. A `PausedResult` is available to callers that inspect the boundary instead of relying on the throw.
3. **Lookup** → resolve tool by name in the mounted tools map. Error result if unknown (e.g. the model hallucinated a tool not in `tools[]`).
4. **Validate input** → validate the model's input against the tool's `inputSchema` (applies to local *and* MCP-sourced tools, against the MCP-advertised schema). On failure, return an **error `tool_result`** with the validation message so the model can self-correct — the loop does not crash.
5. **Dispatch** → call `tool.invoke(input, ctx)` with the tool context.
6. **Record** → call `ctx.recordToolCall(toolCallId, toolName, input, result)` for idempotency.
7. **Wrap** → return as a `tool_result` content block.

Errors in tool execution are caught and returned as `{ isError: true }` — they do not crash the loop. The model sees the error and can retry or handle it.

### 8.3.1 Replay on resume

When a run resumes after HITL pause or checkpoint:

1. Load persisted messages via `ctx.loadMessages()`.
2. Find the last assistant message. If it contains `tool_use` blocks without matching `tool_result` blocks, these are **pending tool calls**.
3. Re-dispatch pending tool calls through the normal dispatch path. The idempotency check (step 1 above) short-circuits any that already completed before the pause.
4. Continue the loop from the next iteration.

### 8.3.2 In-process approval modes

When an agent runs in-process with no gateway to resolve approvals (local dev, `agent.run()` in a script), `requestApproval` follows the approval mode:

| Mode | Trigger | Behavior on a gated tool |
|---|---|---|
| **Auto-approve** (default) | (default) | Approves the call, but **logs it and emits an `approval.auto` event + sets an `approval.auto = true` span attribute** on the tool span. Never silent — it's auditable in traces. |
| **Strict** | `RENDER_AGENTS_STRICT_APPROVAL` set | Prompts on the terminal (`y/n`) when attached to a TTY. If non-interactive (no TTY), the run errors with `approval required, no resolver available`. |

This keeps local iteration fast by default while making the bypass visible, and lets you exercise real approval gates locally with one env var. The production (gateway) path is unaffected — it always enforces via `ApprovalRequest` + pause.

### 8.4 Message persistence and checkpoint-resume

Per principle #5 ("Workflows orchestrate, Postgres persists"), the runner persists LLM messages to Postgres after each turn:

1. After each model response, the runner writes the assistant message to `run_messages`.
2. After each batch of tool results, the runner writes the tool message to `run_messages`.
3. On HITL pause (`requireApproval`), the run status is set to `"paused"`. The persisted messages capture the exact point of interruption.
4. On resume, the runner replays from these persisted messages and skips already-completed tool calls (mechanics in §8.3.1).

This means: Postgres always answers "what did the model see, what tools ran, what is paused, what can be resumed?" Span records capture the observability view (timing, cost, hierarchy). Run messages capture the execution view (the actual content the model consumed and produced).

When a store is not available (in-memory mode for local dev), messages are held in memory only, and checkpoint-resume is not supported — runs are one-shot. This is a graceful degradation, not a behavioral difference: the loop logic is identical.

### 8.5 Local = production parity

The loop, tool dispatch, permissions, budget enforcement, message persistence, and all observable behavior are identical whether an agent runs via `agent.run()` (in-process) or `agent.task()` (Workflow task). Both write messages, tool calls, and spans to whatever store is available. The only differences are in the execution container:

- `agent.run()`: shares the caller's process, no retries, no container isolation.
- `agent.task()`: own container on the agent's `plan`, Render Workflows retries.

When Postgres is available (production, or local dev with `DATABASE_URL` set), both modes persist to it. When Postgres is not available (local dev without a database), both modes fall back to the in-memory store. The persistence behavior follows the store, not the execution mode.

Pipeline code does not need to know or care which mode is in use. The same agent markdown, the same tool set, the same runner, the same store, the same output shape.

### 8.6 Task dispatch — Render Workflows mapping

`agent.task()` is auto-wired onto Render Workflows (`@renderinc/sdk/workflows`). Authors never write a `task()` definition.

**Registration.** Render binds the instance type (`plan`) to a task at its `task()` definition; the run-trigger API (`startTask` / REST `Run task`) takes only a task identifier + input, so there is no per-run plan override. To get per-agent compute anyway, at workflow-service startup the SDK registers a **bounded set of generic dispatch tasks, one per plan referenced across the loaded agents** (plus the default `standard` plan). `pro_plus` / `pro_max` / `pro_ultra` are only registrable when the workspace has been granted access to them:

```ts
// Registered by the SDK, not the user — one per referenced plan:
//   agent@standard, agent@pro, ...
task({ name: `agent@${plan}`, plan, retry, timeoutSeconds }, agentTaskHandler);
```

Each `agentTaskHandler(agentName, input, dispatchMeta)` reloads the agent from the deployed image by name (only `input` is serialized; definitions are re-loaded, never shipped) and runs it through the default runner.

**Dispatch.** `agent.task(input)` resolves the effective plan from the agent's frontmatter `plan` (or the default) and dispatches `(agentName, input)` to the matching `agent@<plan>` task:

- **Inside a workflow handler** → calls the registered task function directly, which Render executes as a durable **chained run** on its own instance and returns a promise for the result.
- **From the gateway / outside a workflow** → uses the Render client `workflows.runTask(id, input)` (or `startTask` + `result.get()`).
- **No workflow server detected** (`RENDER_SDK_SOCKET_PATH` / `RENDER_USE_LOCAL_DEV` unset) → transparently falls back to in-process `.run()`.

**Render Workflows is a hard production requirement.** The in-process fallback above is a **local-dev convenience only** (and the basis for the testing runtime in §7.4) — it is not a production degraded mode. A deployed workflow/gateway service is expected to have the Render Workflows dispatcher available; production parallelism, container isolation, and retries depend on it.

**Serialization.** Task input and output must be JSON-serializable. Non-serializable input throws at dispatch time.

**Idempotent dispatch.** Each dispatch carries a deterministic key `SHA-256(runId + agentName + callSeq)`. On handler re-execution (resume, or a manual retry), re-dispatch returns the existing child run's result instead of starting a new run. The `callSeq` is the per-handler dispatch ordinal, so control flow must be deterministic (see §8.7).

### 8.7 Workflow handler replay & determinism

Render's durability is **per task**, not Temporal-style deterministic replay: a task runs once, returns a value, and is deprovisioned; on failure (no return) the *whole task re-runs* from the top with no memoization. The `workflow()` handler is itself the root task, so:

1. **Root handler `retries` default to 0.** A failed handler is not silently re-executed (which would duplicate side effects). The run is marked `failed`; durability and resumption come from child `agent.task()` runs plus Postgres checkpoint state, not from blind handler re-runs.
2. **Deterministic, side-effecting, or non-deterministic work goes in `ctx.step(name, fn)`.** Step results are memoized to Postgres by `(runId, name)`. On any handler re-execution (HITL resume, explicit retry), completed steps short-circuit to their stored result. Plain function calls in the handler body are *not* memoized and will re-run.
3. **`agent.task()` dispatches are memoized** via the deterministic key in §8.6 — completed child runs are not re-dispatched on re-execution.
4. **HITL pause is a deliberate re-execution.** When a child agent pauses for approval, the runner throws `RunPaused`, which bubbles out of the handler; the runtime marks the run `paused`. On approval, the run resumes by re-executing the handler: prior `ctx.step` results and completed `agent.task()` dispatches replay from storage, and the previously-paused agent now returns its completed result.

**Author guidance (documented contract):**

- Handler control flow must be deterministic (the dispatch/step ordinals depend on it).
- All side effects must be wrapped in `ctx.step()` or performed inside an `agent.task()`.
- Do not read wall-clock time, randomness, or external mutable state directly in the handler body — wrap such reads in `ctx.step()` so they are captured once.

```ts
export default workflow(async (ctx) => {
  const patches = await ctx.step("prepare-diff", () => prepareDiff(ctx));

  const findings = await Promise.all(
    ctx.agents.get(["security", "performance"]).map(a => a.task({ patches }))
  );

  const decision = await ctx.agents.get("judge").run({ findings });

  return ctx.step("post-review", () => postReview(ctx, decision));
});
```

**Resume semantics (you always get the result before downstream code).** A paused `agent.task()` does *not* resolve with a partial or empty value. The `await` either resolves with the real result or throws `RunPaused`, which unwinds the handler — nothing after the paused `await` runs on that execution. The *Render task instance* is deprovisioned during the pause (so we don't pin compute waiting on a human), but from the handler's perspective the call simply hasn't returned yet. On approval the run resumes by re-executing the handler with completed work replayed from storage, so execution fast-forwards to the exact paused point — now with its answer — and continues. This is the same "resume at the await via replay" technique durable engines use; there is no code-visible state where control flow proceeds without a needed response.

```ts
const [sec, perf] = await Promise.all([
  ctx.agents.get("security").task({ patches }),    // completes
  ctx.agents.get("performance").task({ patches }), // pauses for approval → throws RunPaused
]);
// Nothing below runs until BOTH resolve.
// On resume: security replays from store (not re-run); performance returns its approved result.
const decision = await ctx.agents.get("judge").run({ sec, perf });
```

### 8.8 Structured output

When an agent declares an `output` JSON Schema, the runner returns validated structured data in `AgentOutput.data` in addition to `text`:

1. On the final model turn, the runner sets `CompleteArgs.responseFormat = { type: "json_schema", schema }`. Providers with native structured output (e.g. OpenAI `response_format`, Anthropic tool/JSON modes) enforce it directly; providers without it fall back to a JSON instruction appended to the system prompt.
2. The returned content is parsed and validated against the schema. On success, `AgentOutput.data` is populated (and `text` holds the raw JSON). On validation failure, the runner retries up to a small bounded number of times (feeding the validation error back to the model); if it still fails, the run errors.
3. Agents **without** an `output` schema are unchanged: `data` is `undefined` and only `text` is returned.

Typed access is via the generic parameter:

```ts
type Decision = { decision: "approve" | "reject"; reasons?: string[] };
const { data } = await ctx.agents.get("judge").run<Decision>({ findings });
if (data?.decision === "approve") { /* ... */ }
```

The schema is part of the agent markdown, so structured output is portable and declared in one place — composing agents pass typed `data` rather than parsing each other's prose.

### 8.9 Skill loading

Skills use **progressive disclosure**: the model is told which skills exist and when to use them, but a skill's full `content` only enters the context window when the model explicitly loads it. This keeps the base system prompt small and pushes per-skill token cost to the runs that actually need it.

**1. Catalog in the system prompt.** During prompt assembly, for each skill in `AgentDefinition.skills` the runner appends a compact catalog entry — `id`, `name`, `description`, `whenToUse` — **not** the body. An agent with no declared skills gets no catalog and no skill tool.

**2. Built-in `load_skill` tool.** When an agent declares ≥1 skill, the runner auto-mounts a built-in tool alongside the agent's declared tools:

```ts
// Auto-mounted only when the agent declares skills. Not authored by the user.
const loadSkill: Tool = {
  name: "load_skill",
  description: "Load the full instructions for a declared skill by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Skill id from the catalog" } },
    required: ["id"],
  },
  // invoke → returns the resolved skill's `content` as the tool_result
};
```

**3. On-demand load.** When the model decides a skill applies (guided by `whenToUse`), it calls `load_skill({ id })`. The runner looks the id up in the agent's resolved `skills` set and returns that skill's `content` as the `tool_result`, so the instructions land in the conversation like any other tool output and inform subsequent turns.

**4. Constrained to declared skills.** `load_skill` resolves **only** ids in the agent's declared `skills`. An undeclared or unknown id returns an **error `tool_result`** (the model can recover); it is not a crash. There is no way to load a skill the agent didn't declare.

Because `load_skill` is an ordinary tool, it inherits the dispatch path in §8.3 for free — input validation, a `tool` span (§9.2), and idempotency (loading the same skill twice in a run short-circuits to the stored result). Skills are read-only instruction content and never have side effects.

**Reserved name.** `load_skill` is a reserved model-facing tool name. A user tool source that resolves to `load_skill` is a load-time collision (§6.5).

---

## 9. Observability Model

### 9.1 Span hierarchy

Every execution unit is a span. The hierarchy mirrors the execution tree:

```
workflow run (trace root)
├── step: prepareDiff (deterministic)
├── agent: security (task)
│   ├── llm: turn 0
│   │   └── tool: github__get_file
│   ├── llm: turn 1
│   │   └── tool: sandbox__run_test
│   └── llm: turn 2 (final)
├── agent: performance (task, parallel)
│   └── ...
├── agent: ux (task, parallel)
│   └── ...
├── agent: judge (in-process)
│   └── llm: turn 0 (final)
└── step: postReview (deterministic)
```

### 9.2 Span attributes

| Unit | Span kind | Required attributes |
|---|---|---|
| Workflow run | `workflow` | workflow name, trigger type, input summary |
| Deterministic step | `step` | step name |
| Agent invocation | `agent` | agent name, **agent version**, model, final token usage, iteration count |
| LLM call | `llm` | model, input tokens, output tokens, stop reason, latency ms |
| Tool call | `tool` | tool name, latency ms, success/error |

The built-in `load_skill` tool (§8.9) appears as an ordinary `tool` span — tool name `load_skill`, with the loaded skill `id` in attributes — so skill usage is visible in the trace without a dedicated span kind.

Attributes follow OTel semantic conventions where applicable (`gen_ai.*` namespace for LLM spans). Postgres is the source of truth. Export to external collectors (Datadog, Honeycomb, Grafana) is via an optional OTel exporter — not required for full visibility.

### 9.3 Cost attribution

Each LLM span carries `inputTokens`, `outputTokens`. Cost is computed from the model's pricing table and accumulated in the agent span. The workflow run's total cost is the sum of its agent spans.

---

## 10. Store — Postgres Schema

### 10.0 Migration order & application

Migrations are applied by `RunStore.init()` under a Postgres advisory lock (ported from the harness), in a single canonical **dependency order** so all foreign keys resolve:

1. `sessions`
2. `conversations` (FK → `sessions`)
3. `runs` (FK → `conversations`)
4. `spans`, `tool_calls`, `run_messages`, `workflow_steps`, `approval_requests`, `schedules` (FK → `runs`)
5. `messages` (FK → `conversations`, `runs`)
6. `oauth_connections` (no FKs)

The numbered subsections below document each table for reference; **they are not the application order** (the proposal's `001_runs, 002_spans, 003_sessions` numbering is superseded — creating `runs` before `conversations` would violate the FK). Each `CREATE TABLE` uses `IF NOT EXISTS` and is idempotent.

### 10.1 `runs` table

```sql
CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  workflow        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  input           JSONB,
  result          JSONB,
  error           TEXT,
  trigger         TEXT,
  total_cost_usd  NUMERIC NOT NULL DEFAULT 0,
  cursor          JSONB,
  conversation_id TEXT REFERENCES conversations(id),
  user_id         TEXT,
  agent_version   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX idx_runs_workflow ON runs(workflow);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_conversation ON runs(conversation_id);
CREATE INDEX idx_runs_user ON runs(user_id);
```

### 10.2 `spans` table

```sql
CREATE TABLE spans (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  parent_id   TEXT,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',
  input       JSONB,
  output      JSONB,
  error       TEXT,
  attributes  JSONB,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX idx_spans_run_id ON spans(run_id);
```

### 10.3 `tool_calls` table

Idempotent tool call records. The runner checks this table before dispatching a tool — if a result exists for the idempotency key, it short-circuits.

```sql
CREATE TABLE tool_calls (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  idempotency_key TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  input           JSONB,
  result_content  TEXT,
  result_is_error BOOLEAN DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'pending',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_tool_calls_idempotency ON tool_calls(run_id, idempotency_key);
CREATE INDEX idx_tool_calls_run_id ON tool_calls(run_id);
```

### 10.4 `run_messages` table

Persists the full LLM message history per agent invocation within a run. This is the backbone of principle #5 ("Workflows orchestrate, Postgres persists") — it answers "what did the model see, what tools ran, what can be resumed?"

```sql
CREATE TABLE run_messages (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  agent_name  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  content     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_run_messages_run_agent ON run_messages(run_id, agent_name, seq);
```

The runner writes a row after each assistant turn and tool-result batch. On checkpoint-resume, the runner loads persisted messages and resumes iteration from where it left off — non-idempotent tool calls are not re-executed.

### 10.5 `sessions` table

```sql
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT,
  metadata       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 10.6 `conversations` table

```sql
CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversations_session ON conversations(session_id);

-- At most one active (pending/running/paused) run per conversation.
-- Prevents concurrent turns from corrupting message history.
CREATE UNIQUE INDEX idx_runs_conversation_active
  ON runs(conversation_id)
  WHERE status IN ('pending', 'running', 'paused');
```

### 10.7 `messages` table

```sql
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  run_id          TEXT REFERENCES runs(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id);
```

### 10.8 `approval_requests` table

```sql
CREATE TABLE approval_requests (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  tool_name    TEXT NOT NULL,
  tool_input   JSONB,
  agent_name   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  TEXT,
  reason       TEXT
);

CREATE INDEX idx_approvals_run_id ON approval_requests(run_id);
CREATE INDEX idx_approvals_status ON approval_requests(status);
```

### 10.9 `oauth_connections` table

```sql
CREATE TABLE oauth_connections (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  provider      TEXT NOT NULL,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    TIMESTAMPTZ,
  scopes        TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider)
);
```

### 10.10 `schedules` table

```sql
CREATE TABLE schedules (
  id              TEXT PRIMARY KEY,
  workflow        TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  input           JSONB,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  last_run_id     TEXT REFERENCES runs(id),
  last_run_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 10.11 `workflow_steps` table

Memoized results of `ctx.step(name, fn)` calls. The workflow runtime checks this table before running a step — if a result exists for `(run_id, name)`, it short-circuits. This is what makes handler re-execution (HITL resume / retry) safe for side-effecting steps (§8.7).

```sql
CREATE TABLE workflow_steps (
  run_id     TEXT NOT NULL REFERENCES runs(id),
  name       TEXT NOT NULL,
  result     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, name)
);
```

### 10.12 Retention

Span records accumulate fast. Default retention policy:

- Span records: 30 days, configurable via `SPAN_RETENTION_DAYS`
- Run messages: 30 days, follows span retention (same lifecycle)
- Workflow step records: 30 days, follows run-message lifecycle
- Tool call records: 30 days, follows span retention
- Run records: 90 days, configurable via `RUN_RETENTION_DAYS`
- Sessions/conversations: no automatic expiry (user data)
- Approval requests: follows run retention
- Schedules: no automatic expiry (configuration data)

A background cleanup job runs daily (or on a Render Cron trigger).

---

## 11. Gateway — Web Service

### 11.1 Routes

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/workflows/:name` | Dispatch a workflow run |
| `GET` | `/runs` | List runs (keyset pagination) |
| `GET` | `/runs/:id` | Run details + messages |
| `GET` | `/runs/:id/spans` | Span tree for a run |
| `GET` | `/runs/:id/tool-calls` | Tool calls + results for a run |
| `GET` | `/runs/:id/stream` | SSE stream of run events |
| `POST` | `/runs/:id/cancel` | Cancel a running or paused run |
| `POST` | `/runs/:id/input` | HITL resume (approval or user input) |
| `POST` | `/sessions` | Create a session |
| `POST` | `/sessions/:id/messages` | Send a message (triggers workflow) |
| `GET` | `/sessions/:id/conversations` | List conversations |
| `GET` | `/sessions/:id/conversations/:cid/stream` | SSE stream (cross-run, stays open) |
| `GET` | `/approvals` | List pending approvals |
| `POST` | `/approvals/:id/resolve` | Approve or deny a tool call |
| `POST` | `/webhooks/:name` | Inbound webhook dispatch (user-authored) |
| `POST` | `/connectors/:key` | Inbound webhook dispatch (package-contributed) |
| `GET` | `/oauth/:provider/authorize` | OAuth initiation |
| `GET` | `/oauth/:provider/callback` | OAuth callback |
| `DELETE` | `/oauth/:provider` | Revoke + delete OAuth connection |
| `GET` | `/health` | Health check |

### 11.2 Authentication

- API key bearer auth (`Authorization: Bearer <key>`) for programmatic access.
- Session-based auth for multi-turn conversations.
- Per-user OAuth connections injected into tool context.

### 11.3 SSE streaming

Run progress is streamed via Server-Sent Events over Postgres `LISTEN/NOTIFY`.

**Payload strategy:** NOTIFY payloads are pointer-sized (`{ runId, kind, messageId }`), not full records. The SSE handler receives the notification, fetches the full row by ID, and serializes it to the client. This keeps NOTIFY payloads small and avoids Postgres payload size limits.

**Channel:** A single NOTIFY channel (`agent_runs`) carries all run-related events. The SSE handler filters by `runId` or `conversationId`.

**Events:**

- `run.started`, `run.completed`, `run.failed`, `run.paused`, `run.cancelled`
- `agent.started`, `agent.completed`
- `tool.called`, `tool.completed`
- `text.delta` (token-level streaming output — **post-MVP**; requires `ModelClient.stream`. Until implemented, text is delivered per-turn as a full `agent.completed`/message event)
- `approval.requested`, `approval.resolved`, `approval.auto` (auto-approved in-process; also recorded as an `approval.auto` span attribute)

**Conversation streams** stay open across runs — a new turn creates a new run, and the stream picks up events from the new run automatically.

---

## 12. Deployment Model

### 12.1 Target architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Trigger surfaces                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐   │
│  │ Webhooks │  │   Cron   │  │  HTTP/Chat requests  │   │
│  └────┬─────┘  └────┬─────┘  └──────────┬───────────┘   │
│       │              │                   │              │
│       ▼              ▼                   ▼              │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Web Gateway (Hono)                   │  │
│  │  Sessions, HITL, OAuth, SSE, webhook dispatch    │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                               │
│                         ▼                               │
│  ┌──────────────────────────────────────────────────┐   │
│  │          Render Workflows (orchestration)        │   │
│  │  ┌────────┐  ┌────────┐  ┌────────┐  ┌───────┐   │   │
│  │  │security│  │  perf  │  │   ux   │  │ judge │   │   │
│  │  │ (task) │  │ (task) │  │ (task) │  │ (run) │   │   │
│  │  └────────┘  └────────┘  └────────┘  └───────┘   │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                               │
│                         ▼                               │
│  ┌──────────────────────────────────────────────────┐   │
│  │        Postgres (runs, spans, sessions,          │   │
│  │          conversations, approvals, OAuth)        │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 12.2 `render.yaml`

A production deployment consists of:

- **Web service** — the gateway (Hono), webhook ingress, SSE, HITL
- **Workflow service** — workflow definitions + agent tasks
- **Postgres** — all durable state
- **Cron** (optional) — scheduled workflow triggers
- **Private services** (optional) — MCP servers, custom tool backends

### 12.3 Configuration

There is no project-level config file. Each concern has its own home:

- **Agent defaults** (model, budget, permissions) → `agents/_shared.md` frontmatter
- **Project metadata** (name, version) → `package.json`
- **Deploy config** (services, databases) → `render.yaml`
- **Secrets and connection strings** → `.env` / Render environment variables
- **Retention policy** → `SPAN_RETENTION_DAYS`, `RUN_RETENTION_DAYS` env vars
- **Gateway port** → `PORT` env var
- **Auth** → `WORKFLOW_API_KEY` env var
- **Local strict approvals** → `RENDER_AGENTS_STRICT_APPROVAL` env var (§8.3.2)

This avoids a dedicated config file that duplicates things already expressed in markdown frontmatter, `package.json`, or environment variables.

---

## 13. Non-Functional Requirements

| Requirement | Target |
|---|---|
| Node version | 20+ |
| Module system | ESM only |
| TypeScript | Strict mode, declaration emit |
| Local dev without Postgres | In-memory store, full functionality |
| Agent load + validation | < 500ms for 20 agents |
| LLM loop overhead per turn | < 10ms (excluding model latency) |
| Span write latency | < 5ms (async, non-blocking) |
| SSE delivery latency | < 100ms from span write to client |
| Zero external dependencies for observability | Postgres is sufficient |
| Package size (`@render-agents/sdk`) | < 100KB minified |


---

## Future Considerations

### Sandboxes (code execution & development)

[Render Sandboxes](https://render.com/) (forthcoming) are isolated, long-lived execution environments for code generation, testing, and interactive development. The goal is to let an agent check out a repo, run commands, start servers, and iterate — locally identical to production.

**Design principle: a Sandbox is a stateful resource, not a stateless tool.** It is exposed to the *model* as tools, but backed by a runtime-managed resource with an explicit lifecycle. Two orthogonal "compute" concepts must stay distinct:

- **Agent compute** — the container the agent *loop* runs in → already handled by `plan` / `agent.task()` (§8.6).
- **Sandbox** — the workspace the agent *operates on* (filesystem, exec, ports) → a separate resource driven via tools.

A coding agent runs its loop in a task container but checks out a repo and runs builds *inside a Sandbox*. Different lifetimes, different scaling.

**Proposed seam — `SandboxProvider` on `AgentRuntime`** (optional, env-detected, mirroring `dispatcher`):

```ts
interface AgentRuntime {
  // ...existing...
  readonly sandboxes?: SandboxProvider;
}

interface SandboxProvider {
  acquire(opts: SandboxAcquireOptions): Promise<Sandbox>;
}

interface SandboxAcquireOptions {
  scope: "ephemeral" | "run" | "session";
  /** Key for reattaching a session-pinned sandbox (conversationId/sessionId). */
  key?: string;
  /** Optional snapshot to restore from. */
  snapshotId?: string;
  plan?: RenderPlan;
}

interface Sandbox {
  readonly id: string;
  exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  exposePort(port: number): Promise<{ url: string }>;   // preview URLs
  snapshot(): Promise<{ snapshotId: string }>;
  dispose(): Promise<void>;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

**Model-facing surface — a built-in sandbox tool source.** Declared with the existing authoring model (`tools: [sandbox]` → `sandbox__exec`, `sandbox__write_file`, `sandbox__read_file`, `sandbox__expose_port`). It is a `ToolSource` whose `resolve(env)` acquires the sandbox and whose `ResolvedSource.close()` disposes it — so it inherits permissions/HITL (`requireApproval: [sandbox__exec]`), input validation, tracing, and idempotency for free, and is MCP-mirrorable for the Python SDK.

**Context handle.** `ctx.sandbox()` on `ToolContext`/`RunContext` so deterministic `ctx.step()`s and custom tools can use the same sandbox the model is driving (e.g. a `prepare-repo` step clones; the agent then operates on it).

**Scope model:**

| Scope | Lifetime | Use case |
|---|---|---|
| Ephemeral | per tool call | one-off `exec` |
| Run-scoped (default) | acquired on first use, disposed at run end | code review running tests |
| Session-pinned | persisted handle, reattaches across runs | a *development* agent with a durable workspace |

Run-scoped reuse falls out of the `ResolvedSource` lifecycle. Session-pinned requires new state: store the sandbox id (and last snapshot) keyed by `conversationId`/`sessionId` in Postgres so the next run reattaches instead of starting clean.

**Sketch:**

```markdown
---
model: claude-sonnet-4-6
tools: [github, sandbox]
permissions:
  requireApproval: [sandbox__exec]
budget:
  maxSandboxSeconds: 1800
---

You are a coding agent. Clone the repo, implement the change, run the tests...
```

### 17.2 Open questions (Sandboxes)

| # | Question | Options / notes |
|---|---|---|
| S1 | Replay/resume when a sandbox was deprovisioned during a pause | Tool idempotency already prevents re-`exec` on resume, but workspace state may be gone. Use `snapshot()`/restore on resume? Auto-snapshot on pause? |
| S2 | Budget & cost attribution for Sandbox minutes | Add `budget.maxSandboxSeconds` + a sandbox cost line in attribution (Render bills Sandbox minutes). Pricing source? |
| S3 | Secrets/OAuth injection into the sandbox env | How do per-user tokens (`ToolContext.connection`) reach processes running inside the sandbox, safely? |
| S4 | Tracing granularity | Dedicated `sandbox` span kind vs sandbox attributes on `tool` spans (sandbox id, command, exit code). |
| S5 | Cleanup guarantees | Dispose on run completion, cancel, and failure; reconcile orphaned sandboxes (TTL sweeper). |
| S6 | Session-pinned persistence model | Where the reattach handle/snapshot lives (sessions table vs a `sandboxes` table); eviction policy. |
| S7 | Sandbox plan vs agent plan | Does the sandbox get its own `RenderPlan`, independent of the agent's task plan? |
| S8 | Relationship to the `Environment` abstraction (§5.8) | Keep distinct, or unify sandbox handle under `Environment`? |

These are deferred until Render Sandboxes is available; the `SandboxProvider` seam and the sandbox tool-source convention are the only commitments needed now to keep MVP work unblocked.

---

*This document is the source of truth for all Render Agents SDK technical decisions. Sprint specs implement subsets of this contract. Changes to contracts defined here require updating this document first.*
