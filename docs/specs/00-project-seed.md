# 00 — Technical Specification: render-agents SDK

**Author:** Jacob Prall <jacob@render.com>  
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
│   │   │   ├── agents.ts              # loadAgents, AgentSet
│   │   │   ├── workflow.ts            # workflow() helper
│   │   │   ├── tool.ts                # defineTool, defineMcpSource
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

All directories are optional. Missing directories are silently skipped unless an agent references a tool/skill from a missing directory (which is a load-time error).

Collisions (two sources resolving to the same key) are always hard errors.

---

## 5. Data Models

All types below are the canonical contracts. Implementations must conform exactly. Types are defined in `@render-agents/sdk` and re-exported from the package root.

### 5.1 Agent

```ts
interface AgentDefinition {
  name: string;
  version?: string;
  model: ModelSpec;
  systemPrompt: string;
  tools: string[];
  skills?: SkillMetadata[];
  sampling?: SamplingParams;
  budget?: Budget;
  permissions?: Permissions;
  compute?: ComputeSpec;
  runner?: string;
}

interface Permissions {
  allowedTools?: string[];
  deniedTools?: string[];
  requireApproval?: string[];
}

interface ComputeSpec {
  cpu?: number;
  memory?: string;   // e.g. "4GB"
}

type AgentInput = string | Record<string, unknown>;

interface AgentOutput {
  text: string;
  usage: TokenUsage;
}
```

### 5.2 Agent Set

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
  run(input: AgentInput, opts?: RunOptions): Promise<AgentOutput>;
  task(input: AgentInput, opts?: TaskOptions): Promise<AgentOutput>;
}

interface RunOptions {
  signal?: AbortSignal;
  runId?: string;
  parentSpanId?: string;
}

interface TaskOptions extends RunOptions {
  compute?: ComputeSpec;
}
```

### 5.3 Model

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
  maxCostUsd?: number;
  maxWallSeconds?: number;
}
```

### 5.4 Messages

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

### 5.5 Tool

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
  /** Per-user OAuth connection for the given provider (injected by gateway). */
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

### 5.6 Tool Authoring

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

Cross-source collisions on the final model-facing name are hard errors at load time.

### 5.7 Skill

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

### 5.8 Environment

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

### 5.9 Runner

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
  env(name: string): string | undefined;

  mountTools(toolIds: string[]): Promise<MountedTools>;

  /** HITL: pause execution and wait for approval. No-op in-process. */
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
  | { approved: false; reason?: string };

type RunEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; result: ToolResult }
  | { type: "status"; status: string };
```

The `RunContext` is the full platform contract a runner must interact with. It carries HITL, budget, tracing, streaming, and tool mounting — not just the prompt. Custom runners that skip these hooks degrade gracefully (the in-process context stubs them), but production runners must honor them.

### 5.10 Model Client

```ts
interface ModelClient {
  complete(args: CompleteArgs): Promise<CompleteResult>;
}

interface CompleteArgs {
  model: ModelSpec;
  system: string;
  tools: ToolSchema[];
  messages: Message[];
  sampling?: SamplingParams;
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
```

### 5.11 Tracing

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

### 5.12 Store

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

### 5.16 Workflow

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
  /** Number of automatic retries on failure. */
  retries?: number;
  /** Compute profile for the root task container. */
  compute?: ComputeSpec;
}

interface WorkflowContext {
  readonly runId: string;
  readonly trigger: string;
  readonly input: unknown;
  readonly agents: AgentSet;
  readonly tracer: Tracer;
  readonly logger: Logger;
  readonly signal: AbortSignal;
}

interface WorkflowDefinition {
  /** Set at discovery time from `workflows/<dir>` directory name. */
  readonly name: string;
  readonly options: WorkflowOptions;
  dispatch(input: unknown, trigger?: string): Promise<RunRecord>;
}
```

The `workflow()` helper binds **config + handler** into a Render Workflows root `task()`. The name is always inferred from the directory (`workflows/code-review/index.ts` → `"code-review"`) — it is set by the loader at discovery time, not by the author. Config is optional when defaults are fine.

```ts
// workflows/code-review/index.ts

// Default config
export default workflow(async (ctx) => {
  const { patches } = ctx.input;
  const findings = await Promise.all(
    agents.get(["security", "performance"]).map(a => a.task({ patches }))
  );
  return agents.get("judge").run({ findings });
});

// With config
export default workflow({
  timeout: 600,
  retries: 2,
  compute: { cpu: 1, memory: "2GB" },
}, async (ctx) => {
  // ...
});
```

### 5.17 Webhook

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

### 5.18 Idempotency

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

### 5.19 Cancellation

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

### 5.20 Cost Estimation

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

The pricing table is a simple record keyed by model string. The `estimateCost` function is called after each `complete()` call, and the result is accumulated on the run's `totalCostUsd`. Unknown models default to `0` cost (no enforcement, not an error) with a logger warning.

### 5.21 Schedules

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
  requireApproval: [push_code, merge_pr]
  deniedTools: [delete_repo]
budget:
  maxIterations: 30
  maxTokens: 500000
  maxCostUsd: 2
  maxWallSeconds: 300
compute:
  cpu: 2
  memory: 4GB
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
| `permissions.allowedTools` | `string[]` | (all tools) | Load time |
| `permissions.deniedTools` | `string[]` | `[]` | Load time |
| `permissions.requireApproval` | `string[]` | `[]` | Load time |
| `budget.maxIterations` | `number` | `50` | Load time |
| `budget.maxTokens` | `number` | `1000000` | Load time |
| `budget.maxCostUsd` | `number` | (none) | Load time |
| `budget.maxWallSeconds` | `number` | (none) | Load time |
| `compute.cpu` | `number` | (platform default) | Load time |
| `compute.memory` | `string` | (platform default) | Load time |
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

### 6.3 Model tiers

| Tier | Provider | Model |
|---|---|---|
| `small` | anthropic | `claude-haiku-4-5` |
| `medium` | anthropic | `claude-sonnet-4-6` |
| `large` | anthropic | `claude-opus-4-6` |

Raw model strings (e.g. `gpt-4o`, `claude-opus-4-6`) are passed through. Provider is inferred from the model name if not set explicitly.

### 6.4 `_shared.md`

If `agents/_shared.md` exists, its body is prepended to every agent's system prompt. The shared file may have frontmatter for default values; per-agent frontmatter overrides it field-by-field.

Merge order: `_shared.md` body + `\n\n` + agent body.

Frontmatter merge: shallow merge, agent wins on conflict.

### 6.5 Validation rules

The following are hard errors at `loadAgents()` time:

- Unknown frontmatter fields
- Tool reference not resolvable: source id not found in `tools/`, or namespaced tool name references a source that exists but doesn't contain that tool
- Skill name not found in `skills/` registry
- Model tier or model string not recognized
- Runner name not found in `runners/` or not `"default"`
- `requireApproval` references a tool name not in the agent's `tools` list
- `allowedTools` and `deniedTools` are both set (mutually exclusive)
- Budget values are non-positive
- Empty system prompt body

---

## 7. Public API Surface

### 7.1 `@render-agents/sdk` exports

```ts
// Agent loading
export function loadAgents(dir?: string): Promise<AgentSet>;

// Workflow definition (2 overloads: opts+handler, handler-only)
export function workflow(
  optsOrHandler: WorkflowOptions | ((ctx: WorkflowContext) => Promise<unknown>),
  handler?: (ctx: WorkflowContext) => Promise<unknown>,
): WorkflowDefinition;

// Tool authoring
export function defineTool(spec: DefineToolSpec): ToolSource;
export function defineMcpSource(spec: DefineMcpSpec): ToolSource;

// All types (re-exported)
export type {
  Agent,
  AgentDefinition,
  AgentInput,
  AgentOutput,
  AgentRunner,
  AgentSet,
  ApprovalResult,
  Budget,
  CancelStore,
  CompleteArgs,
  CompleteResult,
  ComputeSpec,
  ConnectorContext,
  ConnectorSpec,
  ContentBlock,
  DefineToolSpec,
  DefineMcpSpec,
  Environment,
  Logger,
  Message,
  MessageRole,
  ModelClient,
  ModelPricing,
  ModelSpec,
  ModelTier,
  MountedTools,
  OAuthTokens,
  Permissions,
  ResolvedSource,
  RunContext,
  RunCursor,
  RunEvent,
  RunMessageRecord,
  RunOptions,
  RunRecord,
  RunStatus,
  RunStore,
  SamplingParams,
  ScheduleRecord,
  ScheduleStore,
  SkillMetadata,
  SkillRegistry,
  SpanInfo,
  SpanKind,
  SpanOutcome,
  SpanRecord,
  SpanStatus,
  TaskOptions,
  Tool,
  ToolCallRecord,
  ToolCallStore,
  ToolContext,
  ToolRegistry,
  ToolResult,
  ToolSchema,
  ToolSource,
  TokenUsage,
  Tracer,
  WebhookAdapter,
  WebhookMatch,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowOptions,
};

// Functions
export { idempotencyKey, estimateCost };
```

### 7.2 `loadAgents` behavior

```ts
async function loadAgents(dir?: string): Promise<AgentSet>;
```

1. `dir` defaults to `"./agents"` relative to the project root.
2. Scans `dir` for `*.md` files (non-recursive). Skips `_shared.md`.
3. Parses each file: extracts YAML frontmatter and body.
4. If `_shared.md` exists, loads it and merges into each definition.
5. Loads `tools/` and `skills/` registries from sibling directories.
6. Validates every frontmatter field. Fails fast on the first error.
7. Resolves model spec (tier or raw string).
8. Returns an `AgentSet` with `.get()`, `.has()`, `.all()`.

### 7.3 `Agent.run` vs `Agent.task`

| | `agent.run(input)` | `agent.task(input)` |
|---|---|---|
| Execution | In-process | Render Workflow task (isolated container) |
| Use case | Lightweight steps, judges, local dev | Production parallelism, heavy compute |
| Container | Shares the caller's process | Own container with `compute` spec |
| Retries | None (caller manages) | Render Workflows retry policy |
| Persistence | Same store as caller | Same store (Postgres in production) |
| Tracing | Same trace context | Spans correlate via `runId` + `parentSpanId` |

Both methods return `Promise<AgentOutput>` with the same shape. Pipeline code composes them freely:

```ts
const findings = await Promise.all(
  agents.get(["security", "performance", "ux"])
    .map(a => a.task({ patches }))
);
const decision = await agents.get("judge").run({ findings });
```

---

## 8. Execution Model

### 8.1 Loop internals

The default runner (`@render-agents/engine`) executes this cycle:

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
│     b. Check permissions (allowed/denied)       │
│     c. Check requireApproval → HITL gate        │
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

Budgets are checked at the top of each iteration, before the LLM call. Cost is computed via `estimateCost(model, usage)` after each `complete()` call and accumulated on `RunRecord.totalCostUsd`.

### 8.3 Tool dispatch

Tools are dispatched sequentially within a turn. Parallel tool dispatch is a future optimization.

For each `tool_use` block:
1. **Idempotency check** → call `ctx.checkIdempotency(toolCallId)`. If a stored result exists, return it immediately without re-executing. This makes checkpoint-resume and task retries safe for non-idempotent tools.
2. **Permissions** → check `deniedTools` / `allowedTools`. Error result if denied.
3. **Approval gate** → if `requireApproval` includes this tool name and the tool call has not been pre-approved, invoke `ctx.requestApproval()`:
   - On approval: continue to dispatch.
   - On denial: return error result.
   - On pause (production HITL): write a **placeholder `tool_result`** for all pending `tool_use` blocks in this turn (prevents provider 400 errors on resume, since providers require all `tool_use` blocks to have matching results). Set run status to `"paused"`. Return `{ status: "paused", reason: "awaiting_approval" }`.
4. **Lookup** → resolve tool by name in the mounted tools map. Error result if unknown.
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

### 8.4 Message persistence and checkpoint-resume

Per principle #5 ("Workflows orchestrate, Postgres persists"), the runner persists LLM messages to Postgres after each turn:

1. After each model response, the runner writes the assistant message to `run_messages`.
2. After each batch of tool results, the runner writes the tool message to `run_messages`.
3. On HITL pause (`requireApproval`), the run status is set to `"paused"`. The persisted messages capture the exact point of interruption.
4. On resume (approval received), the runner loads persisted messages from `run_messages`, skips already-completed tool calls, and continues iteration.

This means: Postgres always answers "what did the model see, what tools ran, what is paused, what can be resumed?" Span records capture the observability view (timing, cost, hierarchy). Run messages capture the execution view (the actual content the model consumed and produced).

When a store is not available (in-memory mode for local dev), messages are held in memory only, and checkpoint-resume is not supported — runs are one-shot. This is a graceful degradation, not a behavioral difference: the loop logic is identical.

### 8.5 Local = production parity

The loop, tool dispatch, permissions, budget enforcement, message persistence, and all observable behavior are identical whether an agent runs via `agent.run()` (in-process) or `agent.task()` (Workflow task). Both write messages, tool calls, and spans to whatever store is available. The only differences are in the execution container:

- `agent.run()`: shares the caller's process, no retries, no container isolation.
- `agent.task()`: own container with `compute` spec, Render Workflows retries.

When Postgres is available (production, or local dev with `DATABASE_URL` set), both modes persist to it. When Postgres is not available (local dev without a database), both modes fall back to the in-memory store. The persistence behavior follows the store, not the execution mode.

Pipeline code does not need to know or care which mode is in use. The same agent markdown, the same tool set, the same runner, the same store, the same output shape.

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
| Agent invocation | `agent` | agent name, model, final token usage, iteration count |
| LLM call | `llm` | model, input tokens, output tokens, stop reason, latency ms |
| Tool call | `tool` | tool name, latency ms, success/error |

Attributes follow OTel semantic conventions where applicable (`gen_ai.*` namespace for LLM spans). Postgres is the source of truth. Export to external collectors (Datadog, Honeycomb, Grafana) is via an optional OTel exporter — not required for full visibility.

### 9.3 Cost attribution

Each LLM span carries `inputTokens`, `outputTokens`. Cost is computed from the model's pricing table and accumulated in the agent span. The workflow run's total cost is the sum of its agent spans.

---

## 10. Store — Postgres Schema

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

### 10.11 Retention

Span records accumulate fast. Default retention policy:

- Span records: 30 days, configurable via `SPAN_RETENTION_DAYS`
- Run messages: 30 days, follows span retention (same lifecycle)
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
- `text.delta` (streaming text output)
- `approval.requested`, `approval.resolved`

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

## 14. Sprint Roadmap

This spec is implemented across focused sprints. Each sprint has its own spec that references this document for contracts and data models.

| Sprint | Spec | Scope | Depends on |
|---|---|---|---|
| 01 | `01-kernel.md` | Package scaffolding, `loadAgents`, `defineTool`, `defineMcpSource`, default runner, `agent.run()`, local dev CLI, in-memory store | — |
| 02 | `02-workflows.md` | `agent.task()` backed by Render Workflows, `workflow()` helper, compute isolation, retries | 01 |
| 03 | `03-observability.md` | OTel spans, Postgres store, tracer, span retention, trace UI | 01, 02 |
| 04 | `04-gateway.md` | Web gateway, webhook discovery, SSE streaming, runs API | 02, 03 |
| 05 | `05-sessions-hitl.md` | Sessions, conversations, HITL approval enforcement, multi-turn | 04 |
| 06 | `06-oauth-multitenancy.md` | Per-user OAuth, multi-tenant isolation, budget enforcement | 05 |
| 07 | `07-scaffolder.md` | `create-render-agent`, templates, Deploy-to-Render blueprints | 01–06 |

---

## 15. Open Questions

These require resolution before or during implementation. Sprint specs should reference the decisions made here.

| # | Question | Options | Decided |
|---|---|---|---|
| 1 | `_shared.md` merge strategy | (a) Prepend body (b) Append body (c) Named sections | (a) Prepend  |
| 2 | Ship model tier aliases? | (a) Yes: small/medium/large (b) Require explicit model strings | (a) Yes |
| 3 | Parallel tool dispatch in default runner | (a) Sprint 01 (b) Defer to later sprint | (a) |
| 4 | `render-agents.yaml` vs `package.json` config | (a) Dedicated file (b) `package.json` field (c) No config file | (c) No config file — `_shared.md` for agent defaults, env vars for infra |
| 5 | MCP tool namespacing | (a) `sourceId__toolName` for multi-tool (b) Flat for single-tool (c) Configurable | (a+b) Namespace multi-tool sources, flat for single-tool sources |
| 6 | Frontmatter validation library | (a) Zod (b) Custom (c) JSON Schema | (a) Zod |
| 7 | Gateway framework | (a) Hono (b) Express (c) Fastify | (a) Hono — matches template |
| 8 | Cancel store backend | (a) Render KV only (b) Postgres flag fallback (c) Both with auto-detect | (b) Postgres only — cancel checks happen between LLM calls, 5-10ms is noise |
| 9 | Default `maxCostUsd` | (a) $10 per harness (b) $5 (c) No default (explicit only) | (a) $10 — matches harness |
| 10 | Connector contributed webhooks namespace | (a) `/connectors/:key` separate from `/webhooks/:name` (b) Merged under `/webhooks/` | (a) Separate — avoids collisions |
| 11 | Schedule backend | (a) Render Cron in render.yaml (b) Runtime API (c) pg-boss cron | (a) Defer runtime schedules — static Render Cron for MVP |
| 12 | Operator UI in MVP? | (a) Dev-mode trace UI only (from template) (b) Port harness operator UI (c) Defer entirely | (a) Trace UI only — lightweight, solves debugging |
| 13 | `workflow()` naming | (a) Keep `workflow()` (b) `pipeline()` (c) `defineWorkflow()` (d) Bare export, no helper | (a) Keep — carries config, matches directory/route naming |

---

## 16. Code Provenance — Lift-and-Shift Map

This section maps each area of the spec to the existing implementation that should be ported, adapted, or used as reference. The two source repos are:

- **H** = `render-agent-harness`
- **T** = `agent-workflows-template`

### 16.1 From `agent-workflows-template` (orchestration kernel)

The template is the closer starting point for the SDK's core architecture. Its engine is small, clean, and already structured around the authoring and execution model we're building.

| Spec area | Template source | Adaptation |
|---|---|---|
| **Markdown agent loading + validation** | `src/engine/parse-agents.ts` | Extend frontmatter schema (add `compute`, `runner`, `permissions.requireApproval`). Add `_shared.md` merge. Wire Zod validation for fail-fast. |
| **Agent types** (`AgentDefinition`, `AgentSet`, `AgentTask`) | `src/engine/types/agent.ts` | Rename `AgentTask` → `Agent`. Add `.task()` alongside `.run()`. Add `ComputeSpec`, `runner` field. |
| **Tool system** (`defineTool`, `defineMcpSource`, `ToolSource`) | `src/engine/tool.ts`, `types/tool.ts` | Direct lift. Add `ConnectorSpec` support. |
| **Skill system** (`SkillMetadata`, `loadSkills`, `load_skill` tool) | `src/engine/skills.ts`, `types/skill.ts` | Direct lift. |
| **LLM loop** (`runLoop`) | `src/engine/loop.ts` | Extend with: cancellation check, idempotency, HITL pause (placeholder tool_result), message persistence, cost accumulation. Core iterate/call/dispatch structure stays. |
| **Model client + tiers** | `src/engine/model.ts`, `model-tiers.ts` | Direct lift. Add `estimateCost`. |
| **Environment** (tool registry, mount/dispose) | `src/engine/environment.ts`, `types/environment.ts` | Direct lift. |
| **Tracing** (`Tracer`, `SpanInfo`) | `src/engine/store/tracer.ts`, `types/trace.ts` | Direct lift. Add `"workflow"` and `"step"` span kinds. |
| **Store** (RunStore, memory + Postgres) | `src/engine/store/` | Extend schema: add `tool_calls`, `total_cost_usd`, `cursor`, `conversation_id`, `user_id`. Add `run_messages` table. |
| **Workflow composition** | `src/workflows/code-review/index.ts` | Reference for `workflow()` helper design. The code-review pipeline becomes the scaffolder's default example. |
| **Gateway + webhooks** | `src/main.ts`, `src/server/` | Adapt to Hono. Add sessions, HITL, OAuth, schedule routes (from harness). |
| **Trace UI** | `src/ui/` | Direct lift as dev-mode trace viewer. |

### 16.2 From `render-agent-harness` (platform substrate)

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

### 16.3 Not ported (intentionally dropped)

| Harness module | Why |
|---|---|
| **Four runtime adapters** (`runtime-web`, `runtime-worker`, `runtime-cron`, `runtime-workflows`) | Replaced by one model: `agent.run()` (in-process) + `agent.task()` (Workflow). Cron and webhooks are trigger types, not runtimes. |
| **Capability packs** (`definePack`, namespace mangling) | Replaced by convention-discovered tools with flat names and hard-error collisions. The `ConnectorSpec` covers the inbound-webhook contribution packs provided. |
| **`render-harness.yaml`** config schema | Replaced by `render-agents.yaml` + markdown frontmatter. Agent identity lives in the agent file, not a config registry. |
| **YAML agent definitions** | Replaced by markdown-first authoring. |
| **Gallery / registry index** | Deferred. The scaffolder generates projects directly; a registry of templates is a future concern. |
| **Operator UI** (`@render-harness/ui`) | Deferred to post-MVP. The trace UI from the template serves as the initial dev-mode viewer. |
| **pg-boss queue** | Replaced by Render Workflows for job dispatch. The gateway dispatches workflows directly; no intermediate queue. |
| **Valkey for cancel** | Replaced by `CancelStore` interface — implementations can use Render KV, Postgres flag, or in-memory. |

### 16.4 Porting principles

1. **Port contracts, not code.** The harness is callback-heavy and config-driven. Extract the logic, implement it against our interfaces.
2. **Flatten the dependency graph.** The harness has 10+ packages with complex cross-deps. Our monorepo has 4 packages with a clean tree.
3. **Delete the YAML layer.** Every place the harness reads from `render-harness.yaml` or `AgentDefinition` built by `defineFromConfig`, we read from markdown frontmatter or `render-agents.yaml`.
4. **Keep the SQL.** The harness's migration patterns (advisory lock, idempotent `CREATE TABLE IF NOT EXISTS`, index naming) are production-proven.
5. **Test against the harness's edge cases.** The harness handles: concurrent conversation turns, mid-loop crashes, OAuth token races, SSRF via DNS rebinding, budget overflow on the last turn. These are the test cases we must not lose.

---

*This document is the source of truth for all Render Agents SDK technical decisions. Sprint specs implement subsets of this contract. Changes to contracts defined here require updating this document first.*
