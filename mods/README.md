# Claude Code mods for Brian's workflow

Nine small [mods](https://code.claude.com/docs/en/plugins/mods/overview) (Claude Code ≥ 2.1.287; written and tested against 2.1.294).
Each is one folder: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.ts[x]`, a `tests/` file, and a `types/` contract where it keeps session state.
No mod makes a network call. The only file a mod reads unasked is `Cargo.toml` (rust-deny-guard, once, at session start).

| Mod | What it does | Commands | Why it exists |
| :- | :- | :- | :- |
| `limits-band` | One line above the prompt: context %, 5-hour %, 7-day %, session $, last turn (seconds · tools · agents). Toast at 85 % / 95 % of any window. A **Compact** button appears past 70 % context. | `/limits` show/hide | Two sessions died on limits in Aug (xav 08-13, dubbing 08-27). The figures were always there, just not on screen. |
| `park` | `/park stopped \| next \| loop` saves a park block per project (`$.store`). Next session: the band shows `↩ next: …` until the first prompt, and that prompt carries a hidden context line telling Claude to open on it. | `/park`, `/unpark` | "Downhill parking" and "Re-entry first" from your instructions, made mechanical instead of hoping memory holds. |
| `trigger-router` | Matches a prompt against playbook triggers T1–T10 (PLAN-IT, YOU-CALL-IT, PARK-IT …) and appends a one-line routing hint only Claude reads. Logs firings. | `/triggers`, `/triggers clear` | The TRIGGERS section of STATE-claude-playbook as code, so a phrasing routes the same way every session and firings are countable for the distill loop. |
| `correction-log` | When a prompt reads as a correction ("no, I meant…", "wrong file", "undo that") it logs date, project, your words and the first line of the answer being corrected. | `/corrections [n]`, `/corrections clear` | T13 correction-capture (ratified 09-02). Output lines paste straight into STATE-trigger-observations. |
| `rust-deny-guard` | In a crate whose `Cargo.toml` has `unwrap_used = "deny"`, refuses an Edit/Write of a `.rs` file containing `.unwrap()`, `.expect(`, `panic!`, `unreachable!`, `dbg!`, `eprintln!`, `"lit".to_string()`, `as _`, `mem::forget`, naming the clippy lint and the fix. | `/deny-guard on\|off\|auto` | xav denies ~90 lints with `warnings = "deny"`; a build is minutes. Catching the seven commonest at edit time saves the round trip. |
| `guard-paths` | Refuses Edit/Write (and Bash writes) to a skills `manifest.json`, `.env*`, `.credentials.json`. Fails closed. | `/guard-paths` | Playbook R1: manifest.json is sync-owned, never hand-edit. |
| `written-files` | Tracks files Claude edited/wrote. A dim `● written-files: changed a, b` line after each turn; `/written` lists the session total. | `/written`, `/written clear` | Facts for the park block and the "log path + purpose to state" rule, instead of reconstructing from scrollback. |
| `bg-run` | `/bg cargo build --release` runs a long job without a Claude turn: status line while it runs, toast on exit with code and seconds, `/bg-log` for the last 60 lines. One job at a time. | `/bg`, `/bg-log` | xav builds, Vship, renders: start it, keep working, get told when it ends. |
| `agent-cap` | Caps subagents started per turn (default 6); the 7th is refused with a reason Claude reads. Persists across sessions. | `/agent-cap <n\|off\|status>` | The 09-02 fleet review spent 3.4 M subagent tokens in one go. A cap turns "fan out" into a decision you make with `/agent-cap 20`, not a surprise. |

Mods that draw (limits-band, park) only draw in a terminal or the Desktop app's Code tab. Everywhere else (VS Code chat panel, `claude -p`, cloud sessions) the hooks still run but nothing is drawn.

Anthropic's own samples cover three more asks without writing anything: `blast-radius` (hold a risky `rm -rf` / force-push and show what it touches), `token-weather`, `replay-theater`. See the mods overview page.

## Try one for a session

```bash
git clone https://github.com/qunewsguy16/xav -b claude/lucid-gauss-1hq1uq ~/src/xav-mods
claude --plugin-dir ~/src/xav-mods/mods/limits-band --plugin-dir ~/src/xav-mods/mods/park
```

`/plugin` → a dim line under the tabs reads `2 mods active · limits-band, park`. The folder is watched: edit a file, the mod reloads at the end of the turn.

## Install for every session

This repository is a marketplace (`.claude-plugin/marketplace.json`). From a terminal session:

```text
/plugin marketplace add qunewsguy16/xav
/plugin install limits-band@xav-mods
```

Repeat the install line per mod. Pick the **user** scope when asked so it loads in every project. To install from your local clone instead (edits take effect with `/reload-plugins`, no reinstall):

```text
/plugin marketplace add ~/src/xav-mods
```

## Turn one off

- **One mod**: `/plugin` → **Installed** tab → select it → disable (or uninstall). Or `claude plugin uninstall <name>@xav-mods`.
- **All mods, one session**: `claude --safe-mode`.
- **All mods, every session**: `"disableAllHooks": true` in `~/.claude/settings.json` (also stops your settings hooks and status line).

Where each mod keeps data: `~/.claude/plugins/store/` (one JSON file per plugin). `park`, `trigger-router`, `correction-log` and `agent-cap` write there; delete the file to reset.

## Check what a mod does before loading it

```bash
claude plugin validate mods/<name>    # hooks: and calls: lines
claude plugin test mods/<name>        # its tests, no session or network
```

Written and verified with Claude Code 2.1.294: every mod passes `claude plugin validate`, its tests, and `tsc` against the build's declarations.
