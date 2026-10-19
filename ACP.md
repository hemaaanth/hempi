# Harness-independent delegates

Hempi controls delegates through ACP v1 using the official TypeScript SDK. Agent profiles describe the assignment; each invocation may select its execution harness. The primary conversation remains Pi. Nanocodex is not included.

| Harness | Implementation | Default permission mode |
| --- | --- | --- |
| `pi` | Local Pi SDK session behind an in-process ACP adapter | Exact profile tool grants |
| `omp` | Native `omp acp` | `default` |
| `claude` | Pinned `@agentclientprotocol/claude-agent-acp` | `default` (manual) |
| `codex` | Pinned `@agentclientprotocol/codex-acp` | `workspace-write` |
| `fx` | Native `fx acp` | `ask` |

Pi uses its existing broker, model roles, fallback policy, request budget, and native tool implementation. It does not need an extra CLI process or a Pi fork. The other harnesses run as child process groups with their own credentials, tools, settings, and resource discovery. Those are **not OS sandboxes**.

## Getting started

Run `npm install` in this package when installing from a checkout. The Claude and Codex ACP adapters are local, pinned dependencies; delegation never runs `npx` or installs packages on demand. OMP and fx must already be on `PATH`. Each external harness needs its normal authentication configured. Pi extension-only providers and model aliases are not automatically exported to external harnesses. The Codex adapter uses its bundled compatible Codex by default; `harnesses.codex.env.CODEX_PATH` can select another binary at your own compatibility risk.

Reload Pi with `/reload` after updating the package. No default profile changes are required:

```text
/agent-runs start worker --harness omp Inspect the current diff and report findings
/agent-runs start worker --harness claude Inspect the current diff and report findings
/agent-runs start worker --harness codex Inspect the current diff and report findings
/agent-runs start worker --harness fx Inspect the current diff and report findings
/agent-runs
```

These commands start real model work and may incur usage charges. All four external harnesses currently require a **writer-capable profile**, even if the task asks only for review. Exact Pi read-only tool grants are not portable across these ACP servers, so combining a read-only profile with an external harness is rejected before launch. A read-only primary cannot launch a writer. Use `scout`, `planner`, or `reviewer` on Pi for enforced read-only delegation.

## Profile configuration

Existing profiles default to Pi. Add fields to an agent in `hempi.json`, or use the same fields in agent Markdown frontmatter:

```json
{
  "version": 1,
  "agents": {
    "worker": {
      "harness": "claude",
      "acpModel": "sonnet"
    }
  }
}
```

`acpModel` is an exact model value advertised by that ACP server, not a Pi `provider/model` selector. If omitted, the external harness selects its configured default and Hempi reports the advertised model when available. Pi model roles, tiers, token settings, and `maxRequests` apply to Pi children only; they are not external spending or request limits. External profile instructions are passed as a user handoff, not as a portable system-prompt override.

`acpMode`, if provided, must equal that harness's default permission mode in the table. Permission-bypassing modes are deliberately rejected. Manual permission requests are shown with the agent, harness, operation, and available input details. Requests are denied without a UI, on cancellation, or after two minutes without an answer. Hempi does not automatically choose an approval option. The harness may perform operations its selected mode already permits; `workspace-write`, for example, allows Codex to edit workspace files without asking for each edit. External `tools` lists classify permission intent/writer scheduling; they are **not exact external tool allowlists**.

Trusted configuration can override an external launcher:

```json
{
  "harnesses": {
    "fx": { "command": "fx-acp", "args": [] }
  }
}
```

Launchers support `command`, literal `args`, and an `env` object. They run without a shell. Parent Pi session/storage environment variables are stripped to avoid accidental attachment to the parent; ordinary environment credentials are inherited. Do not put credentials in command arguments. Launcher overrides are trusted executable configuration, not a security boundary. The existing trusted-project configuration rule applies.

`/agent NAME` changes the primary Pi persona only; it rejects external-only profiles. `/agents` lists profiles and harness defaults.

## Model tools

Blocking delegation stays compatible with existing calls:

```json
{"tasks":[{"agent":"worker","harness":"codex","task":"Investigate the failing test"}]}
```

Background delegation returns run IDs immediately:

```json
{"tasks":[{"agent":"worker","harness":"omp","task":"Investigate the failing test"}],"background":true}
```

Use `agent_run` afterward:

```json
{"action":"list"}
{"action":"status","id":"RUN_ID"}
{"action":"wait","id":"RUN_ID"}
{"action":"cancel","id":"RUN_ID"}
{"action":"followup","id":"RUN_ID","task":"Check the proposed fix"}
```

Followup requires an idle/terminal independent run; workflow-owned runs cannot be followed up under their old phase. Busy steering is not implemented. Cancelling a foreground `delegate` cancels its owned runs. Cancelling an `agent_run` wait only stops waiting; explicitly cancel the run to stop background work. Chains remain sequential and cannot be combined with `background`.

The `workflow` tool groups delegates into ordered phases with a barrier between phases. Tasks within a phase share the same four-run scheduler and serialized writer lease; workflows do not enable concurrent writers. Use short task-specific `label` values for readable tables. `{previous}` supplies bounded labelled answers from the preceding phase. Start/append preflight all supplied tasks, including primary read-only restrictions; failure, cancellation, or parent lifecycle changes prevent later phases. Restored workflow histories are interrupted, not executable scripts or automatic replays. See [Phased workflows](README.md#phased-workflows) for limits and inspection commands.

## Monitoring

A small right-aligned activity card appears just above the input when ACP delegates or owned OptChat children are active. It is collapsed by default; click its header in fullscreen mode or use `/agent-runs panel`, `/agent-runs panel expand`, or `/agent-runs panel collapse`. Expansion is saved on the current session branch. There is no new shortcut or focus-stealing overlay. Body text remains selectable, and an overflowing expanded card scrolls with the mouse wheel. In regular terminal mode use the commands instead of mouse clicks.

The expanded card shows each agent's name, a bounded task title, state/backend, reported consumed tokens, and elapsed wall time. Queued/starting rows show wait time; approval waits remain labelled; paused rows freeze their clock. Tokens update when authoritative reports arrive—Pi reports after each model response, not by estimating streaming output. Context-window occupancy, if available, is separately labelled `ctx` and is never counted as consumed tokens. Unknown counts display an em dash. Newly finished rows remain briefly (six seconds), then disappear; paused rows remain visible without an idle refresh timer.

OptChat rows include only children owned by this parent session, including its nested children. They expose metadata, not private child transcripts or tools. Use `/optchat agents` for their inspector. External harnesses' internal/nested agents are still not individually projected by this integration.

`/agent-runs` remains the full ACP roster in the TUI, or prints a snapshot in other modes:

- Up/down: select; Enter: details.
- Details show progress, final output, errors, model, usage, and transcript path.
- Up/down or PageUp/PageDown scroll details.
- `x`: cancel the selected run, not the parent.
- `f`: enter a followup for an idle run.
- Esc: return to the roster, then close. Closing the panel does not cancel work.

Commands also work explicitly:

```text
/agent-runs list
/agent-runs show RUN_ID
/agent-runs cancel RUN_ID
/agent-runs followup RUN_ID Check the proposed fix
```

Four jobs can execute concurrently. Writer assignments share the existing workspace mutation lease, so external writers normally run serially. Cancelling a queued/lease-waiting job prevents it from launching. External cancellation first uses ACP, then terminates the process group if it does not settle promptly. Already completed file writes, deployed changes, and detached external effects are not rolled back.

## Persistence and recovery

Run metadata is stored as branch-local `hempi.run` entries. Persistent ACP logs are private JSONL files beside child artifacts, created with mode `0600`. Progress retains the latest 4,000 characters; returned answers retain about 50,000. Full received notifications are in the log. Native child sessions retain their own complete histories/tool results; ACP tool previews may be bounded. Transcripts may contain sensitive prompts, output, and file contents.

On parent resume, previously live records become `interrupted`; nothing automatically relaunches or resubmits the old prompt. An explicit followup loads the saved backend session when supported. Pi restores the child history at the parent record's saved leaf. External ACP history cannot be portably rewound, so an out-of-branch checkpoint rejects resuming an external session that advanced after the selected parent checkpoint. Start a new run instead. Missing/legacy external checkpoints also fail closed.

Changed profiles, model-role configuration, launchers, or parent constraints can invalidate followup compatibility. Sessions are never silently transplanted between harnesses. Up to 200 run records and 16 idle peers are retained; evicted peers close and can subsequently be loaded from persistent sessions. In-memory Pi children cannot be reloaded after eviction.

Background jobs are owned by the parent process/session. Shutdown, reload, tree navigation, and session replacement stop them. This is not Pi Durable or an independent daemon. No cross-top-level-agent messaging is installed.

With `--no-session`, Hempi writes neither its ACP logs nor checkpoint sidecars and keeps Pi child history in memory. **External harnesses can still retain their own native sessions**; generic ACP does not disable their persistence.

## Current boundaries and checks

External costs are currently **unknown**, not zero. External consumed token counts are shown only when the backend explicitly reports them; many servers provide only context occupancy while running, so live consumption can remain unknown. Nested agents created inside an external harness are not separately monitored or controlled by this integration. Image prompts, busy steering, automatic restart, worktree isolation, arbitrary tool-grant translation, and portable session forks are not implemented.

`npm run test:acp` exercises fake ACP peers/processes, permission handling, cancellation races, checkpoints, profile validation, and the monitoring UI. `npm run test:workflows` checks phase orchestration and lifecycle boundaries. `npm run test:runtime` exercises the real Pi SDK/tools with fake providers, including phased workflows, bounded handoffs, read-only grants, lifecycle cancellation, cold resume and parent rewind. The managed native promotion gates include both workflow engine tests and this SDK integration regression. Neither performs paid model requests. Real OMP/fx/Claude/Codex initialization, session creation, and safe-mode/model negotiation were smoke-tested separately; live paid task execution and real terminal interaction still need validation.
