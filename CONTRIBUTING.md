# Contributing

Thanks for considering a contribution. This is a small, single-maintainer project, so the
process is lightweight — but a few conventions matter, and a patch that ignores them will get
sent back for changes.

## Before you start

- **Open an issue first for anything structural.** Bug fixes and small improvements can go
  straight to a PR. New features, dependency additions, or changes to the layering deserve a
  short discussion first — it is cheaper than reviewing code that will not be merged.
- **Check `probe.js` before blaming this project for a broken UI.** dsh is pre-1.0 and changes
  its RPC shapes. A surprising number of "nothing renders" reports turn out to be an upstream
  protocol change.

## Development setup

No build step, no bundler, no framework.

```bash
git clone https://github.com/leetp2001-cmd/dsh-android-apk.git
cd dsh-android-apk

./start.sh          # generates a passphrase and starts the service
./doctor.sh         # 7 checks; run this first when something looks wrong
```

The only runtime dependency is `ws`, and it is usually already present if dsh is installed. If
it is not:

```bash
npm install
```

## The layering rules

These are not style preferences — they are what keeps the codebase navigable. A PR that violates
them will be asked to change.

| Rule | Why |
|---|---|
| `src/config.js` is the **only** module that reads `process.env` | One place to see every knob; no hidden configuration |
| Views do not import from `src/dsh/` directly | Views take plain data; the RPC layer stays replaceable |
| `src/lib/` holds no domain knowledge | If it needs to know what a session is, it goes elsewhere |
| `server.js` does assembly only | It wires things and listens — no logic |
| Frontend files are numbered and loaded in order | No bundler; the order is the dependency graph |
| New frontend modules go before `18-preferences.js` | `19-main.js` is always the last, single startup sequence |

## Testing

The suite runs against a **live instance** and reads `.passphrase` from the directory it is
executed in.

```bash
./start.sh                                   # terminal 1
NODE_PATH="$(npm root -g)" \
  BASE=http://127.0.0.1:8760 node test/test-list-page20.js
```

- `BASE` selects the instance.
- `NODE_PATH` lets the tests resolve `ws`.
- Run files one at a time; each is standalone and prints its own count.

> **Common trap:** pointing tests at an instance whose `.passphrase` differs from the one in your
> working directory yields a wall of 401s that look like regressions. They are not. Check the
> HTTP status before reading the assertions.

Before opening a PR:

1. `./doctor.sh` — all checks should pass (tunnel and push are optional and may be absent).
2. The `test/*.js` files relevant to what you touched.
3. `node --check` on every `.js` you modified, `bash -n` on every `.sh`.

## Style

- **Comments explain *why*, not *what*.** `// increment counter` is noise. A comment earns its
  place by recording a constraint, a workaround, or a non-obvious trade-off.
- **Chinese comments are fine** — most of the existing code is commented in Chinese. Do not
  translate existing comments to English in a change that is otherwise unrelated.
- **No new dependencies without justification in the PR description.** The one-dependency
  property is deliberate.
- Match the surrounding formatting. There is no formatter configuration; consistency with the
  file you are editing wins.

## Commits and PRs

- One logical change per commit. Commit messages: a short imperative subject, then a body
  explaining the *why* and any behaviour change a reviewer should check.
- Describe how you tested. "Works on my machine" is not a test description; a command and its
  output is.
- If you touch the streaming path, state the dsh version you tested against.

## Reporting bugs

Include:

- what you expected, what happened, and the exact steps
- the output of `./doctor.sh` (it contains no secrets, but review it anyway)
- Node version, OS, and dsh version (`dsh --version`)
- browser and whether you are using the PWA or the APK

Please redact your passphrase, tunnel URL, and push keys before pasting.

## Security issues

Do not open a public issue for a vulnerability. Contact the maintainer privately first; a
coordinated disclosure is preferred over a public report with no fix available.
