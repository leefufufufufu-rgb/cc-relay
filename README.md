# cc-relay

A small cross-platform launcher that fetches a short-lived token from a broker you control,
injects it into the environment, and runs your target CLI — with automatic account rotation.
One codebase for macOS / Windows / Linux.

## How it works

```
shim (~/.cc-relay/bin, prepended to PATH)
  └─ node cli.js
       ├─ resolve the real target CLI (excluding our own shim, to avoid recursion)
       ├─ fetch a lease from the broker → inject credentials into the child env
       ├─ interactive: spawn(real, { stdio: 'inherit', env })   ← real terminal, correct TTY
       ├─ -p / --print: spawn + tee output, rotate + retry on rate-limit
       └─ subcommands: enroll / status / switch / install / uninstall / _hook
```

- The client only fetches short-lived leases; the token is injected into the child process and
  is never used to call upstream from here.
- Never sets `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` (those would disable the OAuth path).
- Rotation: a fresh account per launch (round-robin), plus a `Stop` hook that marks an account
  when it hits a rate-limit so the next launch skips it — no manual `switch` needed.

## Install

Requires Node ≥ 18.

```bash
npm i -g git+https://<your-git-host>/<you>/cc-relay.git
cc-relay install --control-plane <your-broker-url> --enroll <code>
# update later:  npm update -g cc-relay
```

`npm i -g` fetches the package; `cc-relay install` only does local setup (shims, PATH, settings
hook) and contacts your broker to enroll. The broker URL is supplied at install time and stored
in `~/.cc-relay/control-plane` — it is **not** hard-coded in the package.

## Usage

```bash
claude                  # interactive session
claude -p "hi"          # one-shot, args passed through
claude enroll <code>    # enroll this device
claude status           # enrollment + current account + lease test
claude switch           # manually switch to the next account
cc-relay uninstall      # remove PATH entry + restore settings.json + delete ~/.cc-relay
```

## Configuration

Environment overrides: `CC_RELAY_CONTROL_PLANE` (broker URL), `CC_RELAY_DIR` (data dir,
default `~/.cc-relay`), `CC_RELAY_SETTINGS` (settings path, default `~/.claude/settings.json`).

## Platform notes

| Platform | shim | target resolution | PATH |
|---|---|---|---|
| Windows | `~/.cc-relay/bin/*.cmd` → `node cli.js` | native `claude.exe` preferred | user PATH (registry; broadcast on change) |
| macOS / Linux | `~/.cc-relay/bin/*` (`exec node cli.js`, 0755) | first `claude` on PATH | `export PATH` appended to `.zshrc` / `.bashrc` / `.profile` |

## Notes

- Interactive mode uses `spawn(stdio:'inherit')` so the child inherits the real terminal handles
  (correct TTY on every platform).
- `settings.json` is edited with `JSON.parse` / `JSON.stringify`; existing hooks are preserved
  and the operation is idempotent.
- Shims and the hook use the absolute `node` path (`process.execPath`) for robustness.
