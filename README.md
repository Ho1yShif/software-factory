# software-factory

software-factory turns GitHub issues into specifications and verified draft
pull requests. It also reviews pull requests. Labels start the three main
tasks; comments and base-branch pushes handle cancellation, follow-up Triage,
and snapshot refresh. The factory never approves or merges code.

It runs in your Render workspace as a web service, a Workflows service, and
short-lived Render Sandboxes.

## How it works

```text
issue --factory:triage--> specification
specification --factory:spec-approved--> draft pull request
pull request --factory:pr-review--> COMMENT review
```

- **Triage** reads the issue, discussion, and repository. It asks questions,
  writes a specification, or declines the request.
- **Spec-to-PR** implements the approved specification, runs your verification
  commands, and opens a draft pull request.
- **PR Reviewer** runs verification and reviews security, correctness,
  performance, and tests. It posts a non-approving GitHub COMMENT review.

GitHub holds the discussion, labels, specifications, pull requests, and
reviews. Render Workflows runs the tasks. Sandboxes contain the checkout,
agent loop, and model-directed tools.

## Set up

Start by
[forking this repository](https://github.com/render-examples/software-factory/fork).
Deploy from your fork: its `factory.config.ts` defines the repositories the
factory may access.

The recommended setup is agent-guided:

1. Check the prerequisites in the [Quickstart](docs/quickstart.md).
2. Ask a coding agent to follow the
   [Setup runbook](docs/runbooks/setup.md).
3. Complete the GitHub, secret, and paid-resource checkpoints when the agent
   asks.

The runbook configures the fork before deployment, creates a GitHub App,
deploys the Render Blueprint, connects the webhook, verifies both services,
and runs one Triage smoke test.

## Security

- Model-directed code and tools run inside Sandboxes, not on the Workflows
  host.
- GitHub write credentials never enter a Sandbox.
- Clone and fetch credentials are read-only and removed before repository code
  or agents run.
- Models propose typed results and file trees. Code in the Workflows service
  chooses every repository, ref, branch, issue, pull request, and write target.
- Publishing rejects unsafe paths and modes, workflow files, symlinks,
  submodules, oversized changes, and branches with human commits.
- GitHub must reproduce the candidate tree SHA before the factory publishes
  it.

Sandboxes use allow-all egress, and the model key exists in runner memory
during a call. Read the [trust boundaries](docs/architecture.md#trust-boundaries)
and [residual risks](docs/architecture.md#residual-risks) before using private
code or untrusted pull requests.

## Limits

- Main tasks do not chain. Labels, comments, commands, and base-branch pushes
  start work through the gateway.
- Verification runs shell commands; browser testing is not built in.
- Turn limits and timeouts bound execution, but the factory has no hard dollar
  budget.
- Anyone with `minimumPermission` can start model spend.
- PR Reviewer runs configured commands against the labeled pull request.
- Sandbox API calls count against the Render workspace's request limit.

## Documentation

- [Quickstart](docs/quickstart.md) — what you need and how to start setup.
- [Setup runbook](docs/runbooks/setup.md) — agent protocol for the first
  deployment.
- [Configuration](docs/configuration.md) — settings, logs, run control,
  deployment checks, and snapshots.
- [Architecture](docs/architecture.md) — execution, state, coordination, and
  trust boundaries.
- [Extension runbook](docs/runbooks/extend.md) — add agents, Workflows tasks,
  and GitHub triggers.
- [Contributing](CONTRIBUTING.md) — local development and verification.

## License

MIT. See [LICENSE](LICENSE).
