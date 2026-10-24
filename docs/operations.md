# Operations

Use this guide after completing the [Quickstart](quickstart.md).

## Follow a run

While a task is running, its issue or pull request has `factory:working`. The
factory's status comment shows progress, the current run ID, and final links.

Find that run under `factory-workflows` in the Render Dashboard to inspect
logs, inputs, and its result.

Every task run ends with a `run.finished` JSON line, and every agent run with
an `agent.finished` line, in the `factory-workflows` logs. Search for them, or
send them to a log stream:

```bash
render logs -r <factory-workflows id> --text agent.finished
```

`run.finished` carries the task, state, outcome, and duration. `agent.finished`
carries the agent, model, turns, token usage, reported cost, and, when an agent
is stopped, why. A run stopped by a newer run or by `/factory cancel` gets its
`run.finished` line from whatever stopped it, because Render kills a cancelled
run before it can write one. Task state remains in Render Workflows; GitHub remains the
source of truth for issues, specifications, pull requests, and reviews.

## Cancel or restart

To cancel, post this as the first line of an issue or pull request comment:

```text
/factory cancel
```

The commenter must have `minimumPermission`. Cancellation stops the run the
status comment names and terminates its Sandbox. Render kills a cancelled run
within about a second. If the comment still says "running" for a run that
already stopped, for example one Render killed for exceeding its timeout,
`/factory cancel` marks it cancelled and removes `factory:working`.

To restart a task, remove its trigger label and apply it again.

## Check a deployment

From a configured local checkout, this checks the credentials and services
named by your local `.env`:

```bash
npm run doctor
```

It does not inspect environment variables stored only on Render. To verify
the gateway's actual environment, run `doctor` from its Render Shell:

```bash
npm run doctor -- --service gateway
```

A Workflows service has no Shell, because Render starts a short-lived
instance for each task run. Check it locally instead, with its values and its
deployed `RENDER_WORKFLOW_SLUG` in `.env`, as the
[setup runbook](runbooks/setup.md#phase-9-verify-the-deployed-services)
describes:

```bash
npm run doctor -- --service workflows
```

`doctor` is read-only, does not print secret values, and exits nonzero when a
required check fails.

## Understand snapshots

Each configured repository has a dependency-installed Sandbox snapshot. A
push to its base branch refreshes that snapshot. If no snapshot exists, the
first task to run builds one inline.

Configuration and code changes take effect at different times:

- `factory.config.ts`, application code, and prompt changes require a deploy.
- `app/runner/` and `sandbox/` changes require a snapshot refresh.
- A changed `install` command triggers reinstallation when a Sandbox opens;
  the next base-branch push bakes it into a new snapshot.
- Added repositories and renamed labels require `npm run setup:github`.
- GitHub permission or event changes require updating the App and rerunning
  `doctor`.

Snapshot refresh keeps the previous usable version when a new build fails.

### Refresh a snapshot by hand

Start the `refresh-snapshot` task with the repository, its App installation,
and the base branch's head commit:

```bash
git ls-remote https://github.com/<owner>/<name>.git refs/heads/<base branch>
echo '[{"repo": "<owner>/<name>", "installationId": <id>, "sha": "<commit>"}]' > input.json
render workflows tasks runs start <workflow slug>/refresh-snapshot --input-file input.json
```

The installation ID is the number at the end of the App installation's
settings URL (`https://github.com/settings/installations/<id>`, or the
organization's equivalent).

## Troubleshoot

### No status comment

Open the GitHub App's **Advanced** settings and find the delivery under
**Recent Deliveries**. If there is none, confirm the webhook is active and its
URL ends in `/webhooks/github`.

The gateway's response says what happened. `202` means a task started; look
for it under `factory-workflows`. A `200` with `{"ignored": "<reason>"}` names
why nothing started:

- `unconfigured repo`: the repository isn't in `factory.config.ts`.
- `unhandled label`: the label doesn't match a configured trigger label.
- `issue not in triage`: a comment arrived on an issue without the Triage
  label.
- `bot sender`: bots, including the factory itself, can't start runs.
- `pull request not open` or `not base branch`: the event targets something
  the factory skips.

If a task started but the status comment says the run "did not run", the
triggering actor lacks `minimumPermission`.

### Webhook delivery returns 401

`GITHUB_WEBHOOK_SECRET` differs between GitHub and `factory-gateway`.

### Webhook delivery returns 422

The delivery was authenticated but produced an invalid task input. The
gateway logs `authenticated delivery produced an invalid task input` with the
reason; this usually points to a routing bug.

### Webhook delivery returns 502

The gateway could not start the task. Its logs show `could not start task`
with the underlying error. Check `RENDER_API_KEY`, `RENDER_WORKFLOW_SLUG`, and
the Workflows service.

### Snapshot build fails

Inspect the `refresh-snapshot` run or the first task run. Common causes are:

- an invalid install command;
- installation changing tracked files;
- a missing App installation; or
- a Sandbox verification failure.

### Agent submitted an invalid result

The status comment says an agent "submitted an invalid result" when it was
rejected three times for not matching its output schema. The `agent.finished`
log line records why, with the last attempt's schema problems and the field
names it sent:

```bash
render logs -r <factory-workflows id> --text invalid_submission
```

A misspelled or extra field appears among the submitted names. Problems that
recur for one issue usually point to the agent's prompt.

### Status comment stuck on "running"

The run stopped without finishing, for example after hitting its timeout.
Post `/factory cancel` to clear the status and terminate any Sandbox it left,
or reapply the trigger label to start a fresh run.

### Agent cannot start

Check the selected provider key in `factory-workflows`, then run:

```bash
npm run doctor -- --service workflows
```

### Publishing refuses a change

Inspect task logs for rejected workflow files, unsafe paths, symlinks,
submodules, file-count or size limits, branch ownership, or a tree-SHA
mismatch.

## Capacity, cost, and risk

- Sandbox API calls share the workspace's request limit. Expect a few
  concurrent tasks rather than dozens.
- The factory has no dollar budget. Use a dedicated, provider-capped model
  key.
- Anyone with `minimumPermission` can start model spend.
- PR Reviewer executes the labeled PR's configured verification commands.
- Sandboxes use allow-all egress.
- Local filesystem writes on Render services are ephemeral; durable state
  belongs in GitHub, Workflows, or Sandbox snapshots.

Review [Architecture](architecture.md#residual-risks) before using private
code or untrusted pull requests.
