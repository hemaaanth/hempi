# Security and privacy

Hempi is a local agent extension, not a sandbox. Native workers and external harnesses can access the files and credentials their process/user permissions allow. Chat-only display hides activity; it does not remove stored history or make tool execution safer. Advisor requests redact known credentials and recognized token literals, including text from file tools and broker-resolved credential environment values, before sending model context. Requests stop before provider dispatch if credential inventory fails or redaction would alter a signed replay block. This is not a general data-loss prevention system: unknown secrets, images, and encoded data may still disclose private information, and stored sessions retain their original content.

## Files that must remain local

Do not commit credentials, environment files, agent settings, OptChat memory, session transcripts, recordings, or screenshots containing conversations. Generated Pi sources/binaries, verification manifests, config backups, and audit reports belong under ignored `.pi-runtime/`. Dependencies belong under ignored `node_modules/`. Keep API keys in the appropriate local credential store or environment, not command arguments or checked-in configuration.

The ignore rules are preventive, not proof that a file is safe. Git still includes files that were tracked before an ignore rule was added, and `git add -f` bypasses ignores. Review the exact staged file list before every push.

## Before sharing changes

1. Run `npm run test:privacy` and the normal test suite. The privacy check independently inspects exact indexed Git blobs/modes and current working/untracked source. It rejects unexpected files, symlinks, common data/credential filenames, and literal home-directory paths without printing matching file contents. It does not scan history or detect every secret.
2. Scan both Git history and the exact candidate/staged tree with a trusted secret scanner such as Gitleaks. Enable complete redaction in scanner logs/reports; keep reports outside the published source tree. Do not suppress findings until each is reviewed.
3. Inspect changed configuration and URLs for private endpoints, hostnames, account identifiers, or copied conversation content that automated patterns can miss.
4. Use a GitHub noreply commit address if you do not want your personal email in new commits.
5. Verify the intended GitHub owner, remote, and visibility before pushing. Treat pushes to a public repository as immediate publication. Do not change visibility or rewrite history as a side effect of a normal update.

Review the complete publication tree and commit metadata, not only changed files. Deleting sensitive content in a later commit does not remove earlier copies from Git history.

No scanner can guarantee the absence of private information. If a real credential is found in history, revoke/rotate it first and review remediation before pushing or changing visibility. Do not post the credential in an issue, commit message, chat transcript, or audit summary.

## Attribution and redistribution

Keep `NOTICE.md`, all third-party licenses (including `UNIICHAT-LICENSE`), and `THIRD_PARTY_NOTICES.md`. Hempi-owned code is MIT; the recipe-origin prompt text has separate Apache-2.0 provenance from Victor Taelin's UniiChat, with pinned source correspondence and modification notices in `NOTICE.md`. Attribution alone is not a license for any new third-party material: verify its terms before incorporating or distributing it.

## Reporting

For a suspected leak or security issue, contact the repository owner privately. Do not include credentials, private transcripts, or machine configuration in public issues. Hempi's downstream Pi patches remain in this project; they are not submitted upstream as part of maintenance.
