# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-02

### Added
- Extract shell blocks from Markdown (fenced, tilde, indented, `$`-prompted and language-less blocks).
- Clean-room runner: a copy of the repo with only the files a fresh clone would contain
  (committed modes included), an empty `HOME`, and a scrubbed environment.
- State carried between blocks (working directory and exported variables).
- Failure diagnosis: gitignored files, missing executable bit, undocumented environment
  variables, missing tools, git identity, network, runtime versions.
- Directives: `skip`, `expect`, `exit`, `timeout`, `background`, `ready`.
- Safety: skips `sudo`, global installs, publish/deploy commands, placeholders (override with `--allow-unsafe`).
- Terminal, HTML, JSON and Markdown reports.
- GitHub Action (`action.yml`) with a job summary.
- `freshclone --demo`: a before/after walkthrough on a generated sample project.
