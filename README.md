# chromadock — the aurora sidebar for Claude Code

A slim, rainbow-tinted sidebar docked on the right of Claude Code's fullscreen terminal. One glance shows where you are, how much room you have left, what you have spent, and what is running for you.

```
◆ my-project  ⎇ main            ✓ · 2h 41m
❯ Refactor the billing worker      4f1c9a02


▍ USAGE ─────────────────────────────────

5h    ▰▰▰▰▰▱▱▱▱▱▱▱▱▱                  42%
      resets in 2h 13m

week  ▰▰▱▱▱▱▱▱▱▱▱▱▱▱                  18%
      resets in 3d 4h

fable unlimited                         ∞


▍ CONTEXT ─────────────── Opus 5.5 · 1M

302k of 1M                            30%
███████████▊─────────────────────────────


▍ SPEND ──────────────────────── October

Opus 5.5    ███████████       $3,277.75
Sonnet 5.5  ▌                   $150.18
this session                     $12.26

total                         $3,440.19
30 sessions · API prices
```

While Claude works, the colours drift and a glint runs along the context bar. Sections for **ultracode**, a running **workflow** (each agent with its model and time) and live **subagents** (task, tool count, current tool) appear only while they apply.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install aurora --marketplace zivkong/chromadock
```

Answer `y` to add the marketplace, then press Enter for the user scope. From a shell instead:

```
claude plugin install aurora --marketplace zivkong/chromadock
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `zivkong/chromadock`, then Add plugin.

## Use

- The sidebar docks on the right in Claude Code's **fullscreen** mode. It opens by itself on a terminal at least 144 columns wide; `/aurora` opens it at any width.
- It asks the dock for 42 columns. A width you drag the dock to wins.

## What the figures mean

- **Limits** come from Claude Code's own rate-limit readings. A window it does not report shows `∞`: that means *no reading*, not a guaranteed absence of a cap. `/usage` shows your account's real limits.
- **Spend** sums the session totals Claude Code saves in your local transcripts (`~/.claude/projects`), plus the open session's live cost. Figures are at **API prices**: on a subscription they are a usage value, not your bill. A session still open in another window counts once it ends; a session that spans two months counts in the month it ends.
- **Ultracode** is shown when the session's reasoning effort is `xhigh` or `max`.

## Requirements

- Claude Code with mod support, in fullscreen mode, for the docked sidebar.
- `python3` and `git` on your `PATH` (spend totals, session title, branch state).

The spend script keeps its progress in `~/.cache/aurora/month-spend.json` and reads only new transcript lines after its first run.

## License

MIT — see [LICENSE](LICENSE).
