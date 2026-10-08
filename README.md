# issue-tracker

A Claude Code mod that shows the GitHub issues of the project the session works in, in a pane
beside the transcript.

Each issue is a card: its number, its title, its status with the color the project gives it, and
a bar for how far it is. The pane docks at the right in a fullscreen terminal at least 110 columns
wide.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install issue-tracker --marketplace mrtsvr-techloop/claude-issue-tracker
```

Answer `y` to add the marketplace, then pick a scope.

To run it from a clone instead: `claude --plugin-dir <path to the clone>`.

## GitHub access

The mod asks for no login. It uses what the machine already holds, in this order:

1. the `gh` CLI, with whatever account it is logged in as;
2. a token in `GH_TOKEN` or `GITHUB_TOKEN`, else the one git's credential helper stores.

With neither, nothing is fetched and no pane opens. SSH keys alone reach the code, not the issues
API.

## The project

The mod attaches to the repository the session starts in. Started outside a repository, it offers
the working copies in the folders beside it and attaches to the first one the session touches.

The button at the top left names the project shown; a click leads to the project selection.

## The list

- **Search**: narrows the loaded issues as you type; Enter asks GitHub.
- **Filters**: `Open`, `Closed`, `All`, `Assigned` (to the account in use), `Pinned`, and `Status`,
  which steps through the statuses in the list. A filter is blue while on.
- **Lazy loading**: 20 issues at a time; the next page loads when the scroll nears the end.
- **Refresh**: every minute while the pane is open, and at the end of each turn.
- **Pin**: the dot at the left of a card. A pinned issue leads the list, has a dark blue header and
  passes every filter but the search text. Pins are kept per repository across sessions.
- **Working**: the issues the session names in a prompt, a command or its branch (`feat/242-x`)
  come right after the pinned ones, marked `working`.
- **Status**: click it to change it. An issue on a project board takes the board's statuses; any
  other is opened, closed or closed as not planned. The change is written to GitHub.

## Progress

The bar of a card comes from the first of these the issue has:

1. closed: 100%;
2. sub-issues: completed over total;
3. task-list items in the body (`- [ ]`, `- [x]`): checked over total, shown as `criteria`.

An issue with none of them has no bar.

## The issue

A click on a title opens the issue in the pane: its status, assignees, labels in their GitHub
colors, its progress, a link that opens it on GitHub, and its text. `Back` returns to the list;
the project button leaves at once.

## Commands

- `/issues` opens the pane and refreshes it.
- `/issues attach <path or owner/name>` shows another repository.
- `/issues close` closes the pane.

## Mod Signals

The mod follows [Mod Signals](https://github.com/mrtsvr-techloop/mod-signals), a standard for mods
to hear each other without knowing each other. It accepts `open`, `close` and `toggle`, and emits `opened`, `closed` and `notify`. Another mod, such as a
dock of buttons, can open and close it with nothing added here.

The standard travels in `hooks/mod-signals`, a `git subtree` of its repository: the files are
committed here and are not edited here. A newer version is pulled with

```
git subtree pull --prefix hooks/mod-signals git@github.com:mrtsvr-techloop/mod-signals.git main --squash
```

## Develop

```
claude plugin validate .
claude plugin test .
```

Architecture: ports and adapters. `hooks/model.ts` is the pure issue model. `hooks/ports.ts` names
what the adapters need of the machine (processes, HTTP, environment, files); `hooks/github.ts` and
`hooks/project.ts` are the adapters over those ports, for GitHub's GraphQL API and for git.
`hooks/register.tsx` binds the ports to Claude Code, holds the hooks on its events and draws the
pane. `types/index.d.ts` is the state contract.

TypeScript, as Claude Code mods are.
