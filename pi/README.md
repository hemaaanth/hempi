# Downstream Pi channel

This directory owns Hempi's downstream Pi patch stack and maintenance pipeline. All changes stay downstream: do not open upstream issues/PRs, propose hooks, or suggest upstreaming them.

The `pi` command remains an actual Pi native executable, not a launcher. Stock mise installations are never edited. Generated sources, logs, immutable releases, and current/previous pointers live under ignored `../.pi-runtime/`. Only the mise selection and installed systemd unit copies live outside this repository.

## Patches

`channel.json` lists the exact patches and selected offline upstream tests. The initial base is Pi **1.3.0**, commit **71023aec1546d6d677a65669c5665c0927ce0dd0**.

1. `0001-chat-only-view.patch`: presentation-only chat transcript. The default shows user input and final replies, with the existing activity indicator. The optional `app.transcript.toggle` keybinding action remains available, and can be left unbound to avoid terminal conflicts. **Ctrl+T** still controls thinking in detailed view. Errors, permission dialogs, and project-trust warnings stay available. Full session/model/RPC history is retained.
2. `0002-managed-update-channel.patch`: a local `hempi-channel.json` marker routes `pi update` and the self-update part of `pi update --all` to this channel. Package/model updates remain native. Missing markers preserve stock behavior; malformed channels fail closed.
3. `0003-chat-only-settings.patch`: a native **Chat-only transcript** row in `/settings`, saved as `chatOnlyTranscript` per agent directory. `true` means user inputs and final replies only; `false` restores full activity. It applies immediately, survives restart/reload, and is independent of thinking visibility.
4. `0004-chat-only-internal-errors.patch`: failed internal tool calls and recovered provider/compaction attempts stay in full activity only, including replayed history. Permission requests, explicit user-command failures, and genuine terminal request failures/cancellations remain visible. This distinction changes presentation, not the stored messages or error results.
5. `0005-compact-chat-inputs.patch`: chat-only user messages have no colored vertical padding, a `›` role marker, and one uncolored gap before the next input. Wrapped lines align after the marker. Detailed mode restores the original layout; Markdown source, session content, and terminal prompt markers stay intact.

6. `0006-agent-status-dock.patch`: docks `hempi.agent-panel` beside the native working/thinking indicator on one row against the input border. Expanded details float upward without layout reflow or editor focus changes. Hempi's detail component draws a right-aligned border (at most 68 columns) with fully padded rows, masking underlying text using the terminal's default background rather than a colored panel fill; the summary stays outside the frame on the dock. Border rows share the detail wheel-scroll target. Actual fullscreen layout bounds keep the panel attached during wrapping, resize, and constrained-height allocation. Passive details stay behind dialogs and preserve transcript selection outside their rectangle. Regular mode keeps details inline above the dock; unrelated widgets retain their existing placement.

7. `0007-jump-to-latest-editor-border.patch`: fullscreen's clickable **Jump to latest message** hint is centered on the editor input's top border, below the Working/agent-status dock and above-editor widgets, not at the transcript bottom. Uses current-frame layout bounds during multiline input, resize, and constrained-height allocation; unavailable or clipped borders and overlapping status text hide the hint. Click and configured jump shortcut retain native follow-to-end behavior. Regular mode is unchanged. Offline regression tests cover docked/standalone status, resize, clipping, click targets, and keyboard jump.

The optional `hempi` palette uses a stronger neutral charcoal `userMessageBg`. Its source is `theme/hempi.json`; install and select it separately using Pi's theme configuration if desired. Neither package installation nor channel setup installs or selects it automatically. Other panel colors are unchanged. Palette tests check text/marker contrast and the strip's separation from its intended background. Theme files can hot-reload; native layout changes require restarting Pi.

None of these patches changes provider requests or makes model calls in tests.

## Commands

Run these from the Hempi repository:

```sh
npm run pi:update                     # latest stable upstream, apply patches, test, promote
npm run pi:update -- --version 1.3.0   # explicit stable release
npm run pi:update -- --force          # rebuild even if inputs are unchanged
npm run pi:status                     # selected build, previous build, pause/failure state
npm run pi:setup                      # select a verified build in mise and enable daily checks
npm run pi:rollback                   # previous verified build; pause scheduled updates
node pi/channel.mjs resume            # resume scheduled checks after investigating
npm run pi:stock                      # disable timer and restore original mise selection
```

After setup, ordinary `pi update` uses the same tested pipeline. Do not re-enable the official self-updater over the patched executable, edit installed binaries, or add a shell alias/wrapper around `pi`. To temporarily inspect stock Pi without changing the selected channel, use an explicitly installed version, for example `mise exec pi@1.3.0 -- pi --version`.

Setup verifies that `mise exec -- pi --version` can run the selected executable before enabling its timer. A new terminal may be needed for an already-activated shell's PATH to pick up the initial mise selection change; subsequent promotions use the same installation path. Existing running Pi processes remain on their old executable and assets; restart Pi to use a newly promoted build. `--version` deliberately remains the upstream version; use `pi:status` for patch hashes and exact provenance.

## Validation and promotion

1. Query the latest non-prerelease GitHub release, or validate an explicit `X.Y.Z` version.
2. Resolve and record the exact tag commit; enforce the bootstrap pin for 1.3.0.
3. Clone a fresh source tree. Install pinned dependencies with `npm ci --ignore-scripts`.
4. Strictly check/apply every listed patch. No three-way fallback or ignored rejects.
5. Hydrate provider data from the immutable model-catalog revision pinned in that upstream tag's `nix/model-catalog.json`, verify its SHA-256, then build production packages offline, run upstream `npm run check`, and run the explicit upstream test list.
6. Build a native linux-x64 executable and copy its matching assets/native helpers.
7. Check native version/startup; run Hempi typechecks, downstream tests, ACP and UI tests.
8. Run real-candidate Pi SDK/RPC and OptChat compatibility tests with fake providers. `HEMPI_PI_TEST_BINARY` and a candidate-first PATH prevent npm's local development Pi from masking the candidate.
9. Recheck local inputs, write the verified manifest and binary checksum, then atomically promote `current`. Preserve the previous verified release.

A filesystem lease serializes updates, with heartbeat/stale recovery. Failed builds never replace `current`; logs and failure status are retained privately. Logs do not record the environment. All local source/tests, scripts, configuration and selected patches are hashed, including uncommitted files. Changing them during a build blocks promotion.

The verification gate intentionally uses explicit offline tests, not upstream's full e2e suite, which can activate real endpoints from ambient credentials. The hash-pinned model catalog keeps code and generated model types aligned; generating data from a newer live catalog instead can break old release tests. Full upstream static checks are gated alongside production builds and the selected tests.

## Automatic updates and recovery

`pi:setup` points global mise `pi` at `path:<repo>/.pi-runtime/install`. This is a real Aqua-compatible directory containing a native-executable symlink through `current`, not a launcher. Native Pi resolves its executable to the immutable release directory, so running processes keep the correct assets after updates. It saves the original selection and a private config backup, then installs the templates in `systemd/` as user units. The timer checks daily with up to one hour of random delay; it does not run a build for each invocation of Pi. Failed scheduled checks leave the previous executable selected and attempt a desktop notification.

```sh
systemctl --user list-timers hempi-pi-update.timer
systemctl --user status hempi-pi-update.service
journalctl --user -u hempi-pi-update.service
```

Rollback pauses scheduled updates so the next timer does not undo the rollback. Manual updates remain available while paused. With only one verified downstream build, use `pi:stock` instead of rollback. No fallback to stock happens automatically after failed patching or tests.

Old builds are not automatically pruned: running processes may still need their assets. Work trees and build logs also remain available for inspection and can consume substantial disk space. Inspect `pi:status` and stop old Pi processes before manually removing retired directories; never remove `current` or `previous` targets.

If this checkout moves, its absolute installation references must be repaired and the build revalidated before re-running setup. Do not delete `.pi-runtime/` while the patched channel is selected. Stock recovery does not delete user credentials, settings, sessions, OptChat memory, or Hempi source.

## Maintenance

Edit patches against the disposable source checkout, run focused tests, and regenerate only the intended diff paths. Keep each behavioral change in its own patch. New upstream releases that conflict stay blocked until the downstream stack is repaired. For now the builder supports **Linux x86-64 only**, and requires Node **26.10.0** (Hempi's pinned alpha check runtime), npm, Bun, git, bash, mise and a user systemd manager. Upstream Pi's Node >=22.19 minimum does not certify Hempi's directly executed TypeScript test scripts on Node 22. The public CI uses stock Pi 1.0.0 and does not build/promote the native downstream channel; each 1.3.0-based candidate still needs the complete build and compatibility gates above. No macOS, Windows, ARM or authenticated external ACP backend compatibility is certified by that CI.
