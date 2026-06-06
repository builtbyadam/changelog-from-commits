<div align="center">

# 📝 changelog-from-commits

**Turn your conventional commits into a changelog — and open a PR instead of force-pushing your history.**

Generate release notes from `feat:`/`fix:`/`feat!:` commits without hand-editing a changelog.

<br>

[![Marketplace](https://img.shields.io/badge/Marketplace-changelog--from--commits-2088FF?logo=githubactions&logoColor=white)](https://github.com/marketplace/actions/changelog-from-commits)
[![CI](https://github.com/builtbyadam/actions/actions/workflows/test-changelog-from-commits.yml/badge.svg)](https://github.com/builtbyadam/actions/actions/workflows/test-changelog-from-commits.yml)
[![Release](https://img.shields.io/github/v/release/builtbyadam/changelog-from-commits?sort=semver)](https://github.com/builtbyadam/changelog-from-commits/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/builtbyadam/changelog-from-commits?style=social)](https://github.com/builtbyadam/changelog-from-commits/stargazers)

</div>

> 🪞 **This is a generated mirror** of [`builtbyadam/actions`](https://github.com/builtbyadam/actions). Issues and PRs are welcome there.

---

## The problem

Hand-written changelogs drift from reality, and fully-automated release bots that commit straight to `main` feel risky. You want the generation automated but the merge reviewed.

## What it does

Parses conventional commits between two refs, groups them into sections (Features, Bug Fixes, Breaking Changes…), prepends a new section to your changelog file, and opens a PR for you to review and merge. It never pushes to the default branch directly and never force-pushes.

## Usage

```yaml
on:
  push:
    tags: ["v*"]

jobs:
  changelog:
    runs-on: ubuntu-latest
    permissions:
      contents: write        # commit the file onto a new branch
      pull-requests: write   # open the PR
    steps:
      - uses: actions/checkout@<sha>
        with:
          fetch-depth: 0     # REQUIRED — see Safety
      - uses: builtbyadam/changelog-from-commits@v1
        with:
          from-ref: ""             # auto: latest tag, else root commit
          to-ref: HEAD
          output-file: CHANGELOG.md
          open-pr: "true"
```

To generate the changelog without opening a PR (e.g. to inspect the output), set `open-pr: "false"`. The file is still written and the section is emitted on the `changelog` output — and only `contents: read` is needed.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `from-ref` | | `""` | Start of the commit range (exclusive). Empty → latest tag via `git describe --tags --abbrev=0`, falling back to the repository root commit when there are no tags. |
| `to-ref` | | `HEAD` | End of the commit range (inclusive). |
| `output-file` | | `CHANGELOG.md` | Changelog file to create or prepend to (relative to `working-directory`). |
| `open-pr` | | `"true"` | `"true"` to open a PR with the change, `"false"` to only write the file locally. Requires `github-token` when `"true"`. |
| `branch-name` | | `changelog/update-{run}` | Branch created for the PR. `{run}` is replaced by `GITHUB_RUN_ID` (`local` fallback). If the branch already exists, a short suffix is appended. |
| `commit-types` | | see below | JSON object mapping conventional-commit type → changelog section heading. Types not listed are ignored. |
| `working-directory` | | `.` | Directory git runs in and that `output-file` is resolved against. |
| `github-token` | | `${{ github.token }}` | Token used to open the PR when `open-pr` is `"true"`. Needs `contents` + `pull-requests` write. |

Default `commit-types`:

```json
{"feat":"Features","fix":"Bug Fixes","perf":"Performance","refactor":"Refactoring","docs":"Documentation","chore":"Chores"}
```

## Outputs

| Output | Description |
|---|---|
| `entries-count` | Number of conforming conventional commits included (`"0"` when nothing to do). |
| `pr-url` | URL of the opened PR, or `""` when no PR was opened. |
| `changelog` | The rendered new changelog section (markdown); `""` when nothing to do. |

## How it works

The conventional-commit subject grammar `type(scope)!: subject` is parsed in pure code. Commits are grouped by type using `commit-types`; **breaking changes get a "Breaking Changes" section first** — triggered by either the `!` bang marker or a `BREAKING CHANGE:`/`BREAKING-CHANGE:` footer — and still appear under their own type section. Non-conforming subjects and merge commits (`Merge …`) are skipped gracefully.

The rendered section is **prepended** to `output-file` (created if missing). An existing top-level `# Changelog` title is preserved; the new section is inserted below it and above prior entries — existing content is never overwritten.

When `open-pr` is `"true"` and a token is present, the action creates a branch from the default branch's current HEAD, commits the updated file onto it via the GitHub API (`repos.createOrUpdateFileContents` — no `git push` credentials needed), and opens a PR titled `docs: update <output-file>` against the default branch.

When there are zero conforming commits (or none match the configured `commit-types`), the action logs "Nothing to do", emits `entries-count: "0"` and `changelog: ""`, and skips both the file write and the PR.

## Safety

- **Requires `fetch-depth: 0` on `actions/checkout`.** The default shallow checkout truncates history, so the commit range can't be resolved. The action detects a shallow clone and fails early with a clear message telling you to set `fetch-depth: 0`.
- The existing changelog is prepended to, never overwritten; the action never force-pushes and never writes to the default branch directly.
- `working-directory` controls where git runs and where the file is written; it does **not** change the GitHub repository the PR is opened against (that always comes from the workflow context).

## License

[MIT](LICENSE)
