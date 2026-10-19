# hempi

A local Pi package integrating OMP-style **model roles, specialized agents, ACP harness-independent delegation, isolated configuration profiles, native-prefix BTW conversations, a watchdog advisor, and opt-in OptChat memory**. The extension uses Pi's public SDK/broker APIs, not private session state. A small, separately tested downstream Pi patch stack supplies otherwise unavailable UI behavior; its build/update tooling also lives here. Copied/adapted components and their licenses are listed in `NOTICE.md`.

## Installation

Public-alpha verification target: **Linux x86-64, Node 26.10.0, npm 11.19.1, stock Pi 1.0.0**. CI pins Node and the lockfile pins the dependency graph; the four Pi development packages are pinned to 1.0.0. Other Node/Pi versions are not claimed compatible. The host-provided Pi peers remain `*` per Pi package conventions, not as a tested compatibility range. Node 22.19 is Pi's own minimum, **not Hempi's verified development runtime**: our test scripts execute TypeScript directly with Node and use Node's test runner without a transpiler.

Clone this repository into a directory of your choice, select Node 26.10.0, then run:

```sh
cd hempi
npm ci --ignore-scripts
# Uses the pinned stock Pi development dependency, without a global installation:
./node_modules/.bin/pi install .
```

Start with `./node_modules/.bin/pi` (or plain `pi` if you separately installed the verified version); there is no separate Hempi executable. The local-path installation keeps using this checkout, so retain it and its dependencies. This alpha is installed from source, not a published npm release. Run `/reload` if Pi is already open. Choose one installation method: do not load both a manual extension shim and the package extension. If you use a shim, update its import when moving the checkout.

The extension uses your existing Pi configuration; it does not copy credentials, sessions, or memory. The optional downstream Pi runtime has its own prerequisites and setup in [pi/README.md](pi/README.md). See [SECURITY.md](SECURITY.md) before sharing configuration or publishing changes.

Empty TUI branches show a centered, static **HΠ** emblem in restrained sage Unicode Braille dots. No animation or replay controls. Draft text temporarily hides it; submitted input and incoming messages dismiss it. Resumed conversations and non-TUI modes stay quiet. The decorative watermark area does not start text selection in fullscreen mode; conversation selection is unchanged. Small terminals use a compact `HΠ` fallback. Regular-mode and terminal-forced selection remain controlled by the terminal.

## Commands

| Command | Purpose |
| --- | --- |
| `/model-role` | Searchable inline role picker |
| `/model-role smol` | Activate its model and thinking preset |
| `/model-role list` | Inspect role assignments |
| `/model-role set smol` | Inline model + thinking configuration |
| `/model-role set slow provider/model high` | Save an exact assignment |
| `/agents` | List specialized agents, harness defaults and grants |
| `/agent-runs` | Full delegate monitor; start, inspect, cancel and follow up runs |
| `/agent-runs panel` | Expand/collapse the floating activity list attached to the input's status row |
| `/workflows` | Inspect workflow phases/tasks; `list`, `show ID`, `cancel ID` also work over RPC |
| `/settings` | Native Pi settings, including the saved Chat-only transcript toggle |
| `/agent reviewer` | Change the **primary** persona, model preset and tool loadout |
| `/agent reset` | Restore the original primary tools and default preset |
| `/advisor on\|off\|status\|retry` | Explicitly control the independent watchdog |
| `/btw QUESTION` | New independent, tool-free side question |
| `/btw` or `/btw history` | Reopen saved topics without another request |
| `/btw followup QUESTION` | Explicitly continue the selected topic |
| `/btw branch` | Promote one completed answer into a new session without inference |
| `/hempi status\|usage\|reload` | Inspect integration, reported costs, or reload configuration |
| `/optchat` | OptChat profiles, settings, models, agents, instructions, browser and import |

Native `/model` and `/models` are not overridden. `pi --role slow` selects a configured preset at startup. Default role aliases use the current model with different thinking; they deliberately do **not** invent provider/model assignments. Configure distinct models with `/model-role set ...`.

Model-facing `delegate` accepts:

```json
{"tasks":[{"agent":"scout","task":"Find the relevant entry points"},{"agent":"reviewer","task":"Check error-path coverage"}],"mode":"parallel"}
```

Up to four jobs execute concurrently; up to eight tasks per call. `mode: "chain"` runs sequentially and substitutes `{previous}` with the preceding answer. Worker **tasks** are serialized within the shared workspace. A read-only primary cannot delegate to a writer. Pi children retain their native conversations, tools, compaction/retry state and UUIDs; they cannot recursively load the root extensions or spawn delegates. This is workspace sharing, **not** worktree/container isolation or an OS sandbox.

Every delegate is controlled through ACP. Select `pi`, `omp`, `claude`, `codex`, or `fx` with each task's optional `harness` field or a profile default. Add `background: true` to return run IDs immediately, then use `agent_run` to list, inspect, wait, cancel, or follow up. `/agent-runs` provides the human-facing live roster and controls. External harnesses currently require writer-capable profiles: exact read-only grants are not portable and fail closed. Reported token counts appear when the backend supplies them; unknown counts are shown as unknown, not zero. External costs remain unknown. The right-aligned Agents control shares a single row with working/thinking, directly against the input line. It lists ACP delegates and owned OptChat children, with names/task titles, state, reported tokens, and elapsed time. It is collapsed by default; click the header in fullscreen mode or use `/agent-runs panel` (`expand`/`collapse` are also accepted). The bordered expanded popup floats upward over the conversation without shifting text, painting a colored background, taking editor focus, or modifying drafts. Regular mode shows details inline because terminal scrollback owns the screen. Background runs stop with their parent session/process; they are not durable services.

See **[ACP setup, configuration, permissions, recovery and limitations](ACP.md)** before enabling external delegates. Claude/Codex use pinned local ACP adapters; OMP/fx use their native ACP modes. These backends are optional: their CLIs, authentication and any model charges are separate prerequisites. CI exercises fake ACP processes, not authenticated Claude/Codex/OMP/fx sessions, and does not establish backend-version compatibility. Nanocodex is not included.

## Phased workflows

The model-facing `workflow` tool runs ordered phases, with each phase's tasks in parallel:

```json
{"action":"start","title":"Review and fix","phases":[{"title":"Investigate","tasks":[{"agent":"scout","label":"Entry points","task":"Find relevant entry points"},{"agent":"reviewer","label":"Risk review","task":"Check error paths"}]},{"title":"Implement","tasks":[{"agent":"worker","label":"Apply fixes","task":"Implement fixes based on these findings:\n{previous}"}]}]}
```

`start` returns an `id` immediately. Use `{"action":"status","id":"..."}` for prompt-free phase/task metadata, or add `phaseId` to inspect one phase's bounded answers. `list` returns compact summaries; `wait` waits for termination. Aborting `wait` only stops waiting; `cancel` actually stops queued/running tasks. Existing `delegate` parallel/chain behavior is unchanged.

Set `open:true` at start to keep the workflow waiting after its supplied phases drain. `append` accepts `id` and more `phases`, even while a phase runs. `seal` closes the workflow and completes after all phases drain. Every task in a start/append batch is preflighted before that batch can launch anything. A failed or cancelled task cancels siblings and prevents later phases. Workflow-owned runs cannot be followed up under their old phase; start a new task instead.

Workflows share the existing global four-run scheduler, serialized writer lease, harness rules and primary trust/tool grants. Limits: four live workflows, 40 retained histories, 16 phases, eight tasks per phase, 64 total tasks, 120-character titles/labels and 128,000-character task prompts (including expansion). `{previous}` inserts the preceding phase's labelled answers, capped at 16,000 characters total; retained phase answers are capped at 4,000 characters per task. Inspect the attached run/transcript for larger output. An oversized expanded task fails rather than silently dropping prompt instructions.

Custom `hempi.workflow` session entries retain phase metadata and bounded results, never task prompts. Session switch/fork/tree navigation/shutdown stops workflows. Restored active histories become **interrupted**; writer effects are never automatically replayed. Open workflows are parent-session jobs, not durable services. The Agents popup shows a Phases sidebar with completion counts and the selected phase's agent table. Completed phases and tasks remain visible while the workflow is active; independent agents remain listed separately. Click a phase to inspect it, or wheel over either pane to scroll. Narrow terminals stack the phase summary above tasks (click the summary to cycle phases) and omit optional columns. The default phase follows progress until you select one explicitly. Labels, not prompts or paths, appear in tables; delegate tasks accept an optional `label` too.

`/workflows` opens the full retained inspector: `[`/`]` choose a workflow, Left/Right select a phase, Up/Down select a task, Enter opens that run's details on demand, and Esc returns/closes. Lowercase `x` explicitly cancels the selected run; uppercase `X` cancels the selected workflow. Use `/workflows list`, `/workflows show ID`, or `/workflows cancel ID` without custom UI in RPC. Multiple workflows are counted in the dock and selectable in the inspector. The dock never takes editor focus; existing OptChat controls and `/agent-runs` details/followups remain available. Unknown metrics display `—`; no tool counts or inferred costs are shown.

## Downstream Pi runtime

Stock Pi supports the extension's roles, agents, ACP delegation, BTW, advisor, OptChat and watermark. **Chat-only transcript/settings, compact user-message strips, the fullscreen agent-status dock and jump-to-latest border placement require the downstream patches**; stock Pi uses its native layout and the extension's fallback widgets. Installing the package does not install these patches or select a managed binary. The channel separately targets upstream Pi 1.3.0 and gates each candidate; the stock 1.0.0 CI job does not certify a downstream build.

**[The Pi channel](pi/README.md)** keeps small local patches on top of upstream releases, builds and tests candidates, and promotes only verified builds. Plain `pi` remains the executable; stock installations and user data stay intact. `npm run pi:status` shows provenance and update failures; `npm run pi:update` updates; `npm run pi:stock` returns to the original channel. Daily update checks use user systemd units defined in this repo.

The downstream default is a **chat-only transcript**: your inputs and final replies, plus an activity indicator. Open **`/settings` → Chat-only transcript**: `true` hides intermediate activity—including failed internal tool attempts and recovered retries—while `false` shows it. Permission requests and genuine request-ending errors remain visible. Changes apply immediately and are saved per Pi configuration profile. The transcript shortcut can be left unbound to avoid terminal conflicts; **Ctrl+T** keeps its normal thinking toggle in detailed view. Your messages use a compact strip with a `›` marker and a blank line between turns. The optional `hempi` palette in `pi/theme/hempi.json` supplies the charcoal coloring when separately installed and selected through Pi's theme configuration. Package installation and channel setup do not install or select that theme; otherwise your current theme determines the colors. Detailed activity retains the original message layout. Session/model history is unchanged. Changes remain strictly downstream, with no upstream proposals.

## Native Pi configuration profiles

The custom launcher and profile-creation/listing helpers have been removed. Existing profile directories and their data remain unchanged. Select them with Pi's native `PI_CODING_AGENT_DIR` environment variable, set **before Pi starts**:

```sh
ls "$HOME/.pi/profiles"
env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR="$HOME/.pi/profiles/work/agent" pi
env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR="$HOME/.pi/profiles/personal/agent" pi --role slow
```

Plain `pi` continues using the normal `~/.pi/agent` directory unless you already set an override in your environment. Each configuration profile has its own settings, `hempi.json`, fast preference, credentials, sessions and local agent files. Shared extensions/themes must be referenced explicitly in that profile's settings. Run `/login` separately in each profile if needed. The commands above clear an inherited session-directory override so sessions stay profile-local; an explicit `sessionDir` setting or `--session-dir` still takes precedence.

These are native config directories, not OptChat memory profiles or OS sandboxes. Environment API keys and explicitly shared resources remain shared by normal Pi rules. `/hempi status` reports the actual agent directory, without launcher-specific environment variables.

## OptChat memory

OptChat is part of this root package. Do not install or discover a second nested extension.
The source comes from pi-optchat commit `924e61f97543383e72691442c944e12dbd14b9d7`.
See `OPTCHAT-LICENSE` for pi-optchat's MIT implementation license and `UNIICHAT-LICENSE` for the Apache-2.0 recipe-origin prompt text published in Victor Taelin's UniiChat. `NOTICE.md` records the pinned sources and adaptations. Hempi's own code remains MIT.

Without `--optchat-profile`, startup leaves OptChat off in every mode, even when the Pi session has a saved OptChat binding.
It adds no active tools, memory prompt, profile picker, status, cache policy or compaction veto.
Explicit `/optchat` commands remain available. In interactive Pi, use `/optchat profile` to choose a memory profile; startup flags below work directly with `pi`, independently of config-directory profiles. You can combine the two, for example `PI_CODING_AGENT_DIR="$HOME/.pi/profiles/personal/agent" pi --optchat-profile personal-memory --optchat-create` (clear any inherited session-directory override as above).

```sh
# Create if missing, then bind in TUI, print, JSON or RPC mode.
pi --optchat-profile work-memory --optchat-create

# RPC owner; caller-managed instructions refresh on every bind.
pi --mode rpc --optchat-profile agent-reviewer --optchat-create \
  --optchat-instructions ./reviewer-instructions.md

# Import a plain Pi session only if this launch creates the profile.
pi --optchat-profile thread-example --optchat-create \
  --optchat-import-session ./old-session.jsonl

# Interactive profile picker, explicitly opted in.
pi --optchat-profile ""
```

New profiles use `openai-codex/gpt-6-luna` with low thinking for the compactor.
Their subagents use `openai-codex/gpt-6-sol` with medium thinking.
Memory search is on.
These models are independent of the primary Pi model and Hempi model roles.
Configure them through `/optchat model`, `/optchat agents model`, or the profile's `config.json`.
There are no Anthropic model defaults.

`OPTCHAT_HOME` defaults to `~/.optchat`.
Each profile lives under `profiles/NAME`, with its instructions in `AGENTS.md`.
Without an instructions file, creation writes a one-line placeholder.
With `--optchat-instructions FILE`, every successful owner bind replaces differing instructions before the first turn.
Identical text is not rewritten.
Import does not repeat for an existing profile.
Imported requests remain historical records, not new tasks.

One process owns each profile.
On Linux, the ownership lock is a hashed abstract Unix socket.
It disappears with its process, without stale-file cleanup.
This prevents a false connection-refused probe in Pi's Bun runtime from admitting a second writer.
Connected windows still use a private filesystem socket.
Other systems retain upstream filesystem sockets or named pipes.

Non-TUI startup failures exit before accepting a prompt:

| Code | Stderr line |
| --- | --- |
| 75 | `optchat: profile busy: NAME (owner pid PID)` |
| 66 | `optchat: profile not found: NAME` |
| 65 | `optchat: import failed: REASON` |
| 73 | `optchat: profile NAME requires remote memory recovery. Retained copy: ...` |

RPC emits one ready `notify` message starting with `OptChat ` after a successful bind.
RPC and JSON never join another owner.
Print-mode connections remain available through an explicit `--optchat-connect auto` or `join`.
Unlike upstream, the default is `off`, so an ordinary busy print run also exits 75.
TUI connected windows, profile selection and `/optchat` commands retain their upstream UI.

External remote-memory integrations can place `remote-pending.json` inside a primary profile before a remote turn. Those integrations are not included in Hempi.
Hempi checks it under the profile's native lock, before loading memory or refreshing instructions.
The marker survives a remote worker crash and prevents plain Pi from binding stale central memory.
The refusal names the profile, remote host and retained directory.
Restore the connection to the named host and resume the profile through the remote-memory integration that created the marker. If that integration is unavailable, contact its operator for recovery rather than bypassing the guard.
Do not delete the marker to bypass recovery.
An unreadable or corrupt marker also blocks binding.


When bound, OptChat keeps originals and a summary tree across fresh Pi sessions.
It exposes `zoom`, `date`, optional `search`, `spawn` and `tell`.
Hempi persona/reset and role switches preserve those profile tools.
OptChat manages main-agent history and cancels native main-agent compaction.
Unbound runs and child sessions retain native Pi compaction.
OptChat's own summary tree and long-turn refresh are still lossy summaries, not unlimited verbatim context.

## Configuration

`<getAgentDir()>/hempi.json` is profile-local. Trusted projects may override it with `.pi/hempi.json`; untrusted project configuration is not loaded. Precedence: builtins → user agent Markdown → user JSON → trusted project agent Markdown → trusted project JSON. Sparse configuration saves use an exclusive lock, file/directory fsync and atomic rename. A stale `.lock` is reported, never automatically deleted.

```json
{
  "version": 1,
  "roles": {
    "smol": {"model": "provider/small-model", "thinkingLevel": "low"},
    "slow": {"model": "provider/strong-model", "thinkingLevel": "high"},
    "advisor": {"model": "@slow", "tier": "standard", "maxTokens": 8192},
    "btw": {"model": "@default", "thinkingLevel": "low"}
  },
  "advisor": {"enabled": false, "maxCost": 5, "maxNotesPerUpdate": 4, "maxRequestsPerReview": 12, "immuneTurns": 3, "syncBacklog": 0},
  "btw": {"role": "btw", "maxTokens": 4096, "maxContextBytes": 8388608}
}
```

Selectors are exact `provider/model`, `@role`, optionally `:thinking`. Aliases inherit settings and reject cycles. Thinking is clamped through Pi's native model capability helper. Advanced role policy: `tier: inherit|standard|priority|flex`, `maxTokens`, `temperature`, `fallbacks: ["@other-role", "provider/model"]`. Output/temperature limits govern **side/child** requests; primary presets select model/thinking and tier without replacing Pi's native foreground sampler. Priority/flex eligibility depends on provider/account. The advisor defaults to **standard** even when global `/fast` is enabled.

Add `agents/NAME.md` under the profile directory, or trusted `.pi/agents/NAME.md`:

```markdown
---
name: database-reviewer
description: Review transaction and migration correctness
role: slow
tools: read, grep, find, ls
maxRequests: 24
---
Inspect evidence before reporting concrete transaction or migration risks.
```

`model: provider/model` and `thinking`/`thinking-level` may replace `role`. Unknown frontmatter fields are reported rather than silently pretending to support OMP-only capabilities. JSON agents can set `description`, `role`, `tools`, `instructions`, `maxRequests`, `harness`, `acpModel`, and `acpMode`. The three ACP fields also work in Markdown frontmatter. `maxRequests`, role settings, and exact tool grants govern Pi children only; external harnesses retain their own tools and permission policies. Builtins: scout, planner, reviewer (read-only), worker (read/bash/edit/write). Agent grants are explicit; they do not inherit third-party foreground permission extensions. Choose read-only agents for investigation, and do not treat workers as permission-isolated sandboxes.

## BTW behavior

- Full native prompt/tool/history prefix, finalized turns and live **partial text**; images already in the main conversation are retained. Incomplete thinking signatures/tool arguments are not replayed; pending calls receive explicit snapshot placeholders.
- Cache keys may match the main prefix, while transport UUIDs and SSE remain independent. Each new question is independent; only explicit follow-ups include side history.
- Docked rounded panel, no focus stealing or previews. Empty editor: `f` inline follow-up, `c` copy, `b` promotion. `Ctrl+Alt+↑↓` scroll. First Escape cancels while retaining partial text; next closes.
- Durable initial/terminal checkpoints and usage entries are **custom entries**, never main model messages. Interrupted histories reopen as cancelled. Session/tree changes abort requests before rebinding; tree histories follow the selected branch.
- Promotion is conservative: one successful untruncated side turn, asked while idle, unchanged resolved main context/model/thinking. It copies the resolved model transcript into `newSession.setup` and appends cached question/answer. This is not an exact UI-log fork, particularly across compaction/shell-only entries.

Pi's Codex transport does not send `maxTokens` to the server. For Codex/explicitly uncapped models, hempi instead caps visible UTF-8 text/thinking-summary/tool-argument **bytes** at the configured value and aborts the stream. It never executes clipped tool arguments. Every side/child request has a 120-second wall-time guard. These are **client guards, not hard server-side billing/reasoning-token limits**; invisible reasoning and cancelled requests can be billed without reported usage. Other native providers receive normal output/thinking limits.

## Advisor

Off by default; no advisor model role is invented. Configure `/model-role set advisor`, then `/advisor on`. On/off is session-local and journaled; `advisor.enabled` supplies the configuration default.

The advisor has a persistent private native SDK conversation while running, coalesces append-only main transcript updates, receives visible reasoning, tools and image references/content, uses workspace-confined read-only tools, honors trusted `WATCHDOG.md`, and redacts known credentials/common token literals. On process restart/compaction it re-primes from the main transcript rather than blindly reusing an incompatible child.

OMP's admission guard suppresses noise/repeats, supports real severity escalation and rank-aware pending-note displacement. Assistant-turn quarantine happens **before tool dispatch**, including mixed valid advice/ungranted mutations and output-only destructive directives. Recovery, requests per review, costs and auto-resume immunity are bounded. Native SDK retry/compaction stay private. Configured fallback models are explicit; quota/errors pause with `/advisor retry`.

Blockers can steer at Pi's next boundary or resume a normally completed main once eligible. This is **not** a permission gate capable of reversing an already executing tool. Partial-review nits/concerns wait for a final boundary; late concerns do not restart work. Intentionally interrupted work is never automatically awakened, and dialogs defer delivery. Advice is fallible peer context, not a user instruction. Held notes and emission state persist across resume/tree navigation. The advisor is intentionally read-only in this integration.

Native child JSONL files live beside the parent session in `SESSION.hempi/agent-NAME/` and `SESSION.hempi/advisor/`. `--no-session` keeps children in memory. `/hempi usage` is a supplemental breakdown, **not additive** to native foreground/delegate cost statistics; prices/usage are reported library estimates, not an account spending limit.

## Development/checks

```sh
npm run test:ci  # full suite + clean public-path install smoke, disposable settings
# Or, using your current environment:
npm test
# Individual checks:
npm run typecheck
npm run test:model-route
npm run test:downstream
npm run test:runtime
npm run test:acp
npm run test:optchat
npm run test:optchat-activity
```

Offline tests require system `ripgrep` (`rg`) and `fd` (`fd` or `fdfind`) on PATH; on Ubuntu, install them with `sudo apt-get install ripgrep fd-find`. GitHub Actions installs these prerequisites, runs a clean `npm ci --ignore-scripts` on Ubuntu 24.04, then runs `npm run test:ci`. The isolated runner clears ambient credentials, uses temporary HOME/Pi/OptChat/XDG directories, forces offline mode, and selects the stock Pi in `node_modules`, never `.pi-runtime` or a personal binary. The install smoke copies only public package inputs to a fresh directory, repeats `npm ci --ignore-scripts`, runs `pi install .`, and checks registered commands through offline RPC without an explicit extension override. Registry access is needed for installation; model tests use fake providers and require no credentials. Offline mode disables Pi's automatic network activity; this is not an OS-level network sandbox.

Runtime checks run in a real Pi host with fake provider streams, actual SDK sessions and actual file tools: no paid requests. Renderer tests cover regular/fullscreen layouts and narrow terminals. Set `HEMPI_PI_TEST_BINARY` to test a specific Pi executable instead of the development dependency.

OptChat contract tests launch real Pi RPC processes with fake providers for both the primary and compactor.
They cover inactive startup and saved bindings, native compaction versus the profile veto, creation defaults, persona/role tool retention, contention after a turn, simultaneous binds, crashed-owner recovery, print-only connections, missing profiles, import-on-create, import errors and instruction refresh.
The native runtime harness also verifies valid and corrupt remote-memory guards, retained-copy guidance, lock release after refusal and binding after recovery.
Run `node --test tests/optchat.test.mjs` outside npm as well when the managed Pi uses a different runtime from `node_modules/.bin/pi`.

No diff annotations, image cards, focus-stealing BTW overlays, unmanaged Pi binary replacement, private session-field access or advisor auto-enablement.
