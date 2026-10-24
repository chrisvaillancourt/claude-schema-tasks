# schema-tasks

A Claude Code mod (function-hook plugin). Replace this paragraph with what the mod does and why, in two or three sentences.

> This repository is also the template for new mods: `scripts/new-mod.sh <mod-name>` creates `../claude-<mod-name>` with every `schema-tasks` renamed, a fresh git history and one commit. Delete this note in the new repo.

## Behavior

- What the mod does, when, and to which conversations (main only, or subagents too).
- What it costs (model calls, tokens) and how the options bound it.
- What it never does.

## Command

`/schema-tasks [on|off|status]`: show or set whether the mod is on for this session.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Turn the mod on for new sessions. `/schema-tasks on|off` overrides it per session. |

## Install

```sh
claude plugin marketplace add chrisvaillancourt/claude-schema-tasks
claude plugin install schema-tasks@schema-tasks --scope user
```

Or from inside Claude Code: `/plugin install schema-tasks --marketplace chrisvaillancourt/claude-schema-tasks`.

To work on it locally, add your clone as the marketplace instead (`claude plugin marketplace add <path to clone>`). The plugin is read from that folder; after editing, run `/reload-plugins`.

## Update

```sh
claude plugin marketplace update schema-tasks
claude plugin update schema-tasks@schema-tasks
```

Then restart Claude Code.

## Develop

```sh
scripts/check.sh
```

It runs `claude plugin validate .`, `claude plugin test .` and a TypeScript check. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

MIT. See [LICENSE](LICENSE).
