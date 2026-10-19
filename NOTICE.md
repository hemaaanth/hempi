# Third-party attribution

Hempi's original code is licensed under the MIT license in `LICENSE`. That grant covers only rights held by Hempi's contributors; third-party material retains the licenses described below. Retain the following notices and upstream licenses.

OMP components adapted from https://github.com/can1357/oh-my-pi at tag v18.4.2, commit 4620bb8. Licensed under MIT; the complete upstream license is in OMP-LICENSE.

- src/emission-guard.ts: copied packages/coding-agent/src/advisor/emission-guard.ts.
- prompts/advisor.md: copied packages/coding-agent/src/prompts/advisor/system.md; runtime supplies the note budget and Pi capability restrictions.
- src/safety.ts: output-only hazard/provenance checks adapted from advisor/runtime.ts.
- src/ui.ts: rounded inline panel adaptation originally developed against OMP's overlay-box, ask-dialog and BTW panel, using Pi TUI components.

Hempi's original runtime integration, broker delegation, configuration/profiles, lifecycle handling and tests use public Pi APIs. This package is not OMP and does not claim binary or configuration compatibility with all OMP features.

## Downstream Pi patches

`pi/patches/` contains modifications and context from https://github.com/earendil-works/pi, initially based on v1.3.0 at commit `71023aec1546d6d677a65669c5665c0927ce0dd0`. Upstream Pi is MIT licensed, Copyright (c) 2025 Mario Zechner. The complete license is retained in `PI-LICENSE`. Generated source checkouts and build artifacts are not part of this source distribution.

## OptChat

`src/optchat/` is copied and adapted from https://github.com/jonaslsaa/pi-optchat at commit `924e61f97543383e72691442c944e12dbd14b9d7`. The original implementation code is MIT licensed. The complete upstream license is in `OPTCHAT-LICENSE`.

The OptChat memory design and adapted prompt text in `src/optchat/prompts.ts` come from Victor Taelin's publicly shared recipe: https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449.

### Prompt-text license

The recipe-origin prompt wording is also published by Victor Taelin in [UniiChat](https://github.com/VictorTaelin/uniichat/tree/0500bf6a8ea4bf0ce047488562022b1b6532cc30), commit `0500bf6a8ea4bf0ce047488562022b1b6532cc30`, under Apache-2.0. Copyright 2026 Higher Order Company. The complete license and copyright notice are retained in `UNIICHAT-LICENSE`.

The licensed source correspondence is:

- `prompt.txt`: the shared introduction, memory-view explanation, main-agent instructions and compaction guidance used in `COMPACT`, `MASTER` and `VIEW_DOC`.
- `Tools.ts` (`SUB_HEAD`, `VIEW_DOC`): subagent instructions and memory navigation guidance used in `SUBAGENT` and `VIEW_DOC`.
- `Memory.ts` (`LEAF`, `MERGE`, `over`): the compaction tasks and shortening retry used in `compaction` and `tooLong`.

These passages have been modified by pi-optchat and Hempi: agent/message names and report markers differ, the shared instructions are split into separate prompts, unsupported computer controls are omitted, and downstream instructions refine summarization, delegation, search and continuity. pi-optchat's original additions remain covered by `OPTCHAT-LICENSE`; Hempi's original additions are covered by `LICENSE`. The recipe-origin portions retain Apache-2.0; they are not relicensed by either MIT grant. No blanket license is asserted for unrelated material in the linked gist.

`THIRD_PARTY_NOTICES.md` preserves the reference made by the unmodified upstream `OPTCHAT-LICENSE`.
