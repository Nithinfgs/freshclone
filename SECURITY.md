# Security policy

## What freshclone does

freshclone **executes the shell commands found in a Markdown file** on your machine,
inside a temporary copy of the repository with an empty `HOME` and a scrubbed
environment. That isolation exists to find hidden assumptions; it is **not a security
sandbox**. Commands still run as your user, can reach the network, and can touch any
absolute path.

- Run `freshclone --dry-run` to review what would run.
- Only run it on Markdown files you trust, or inside a container or CI runner.
- By default it skips `sudo`, global installs, and publish/deploy commands. This is a
  best-effort filter, not a guarantee.

## Reporting a vulnerability

Please report security issues privately through
[GitHub private vulnerability reporting](https://github.com/Nithinfgs/freshclone/security/advisories/new)
rather than opening a public issue. Include the version, a minimal reproduction, and the
impact you expect. You should get a first response within a week.

Examples of in-scope reports: the safety filter being bypassed by an ordinary-looking
command, temporary files created with unsafe permissions, the clean room leaking
environment variables it should have scrubbed, or report output executing script.

## Supported versions

Only the latest release receives fixes.
