# Hempi maintenance

- Pi customizations stay downstream in this repository. Do not propose upstream hooks, open upstream issues/PRs, or suggest upstreaming these changes.
- Keep the managed Pi source patch stack, update/build scripts, compatibility checks, and documentation here. Generated sources/builds belong under ignored `.pi-runtime/`.
- Never modify the stock mise-installed Pi binary in place. Promote a candidate only after its checks pass; retain the previous working build and a stock rollback route.
- Preserve user settings, credentials, sessions, and unrelated working-tree changes. Do not run paid model tests without permission.
