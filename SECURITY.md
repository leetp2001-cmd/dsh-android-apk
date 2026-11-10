# Security Policy

## The honest summary

This project has **one authentication factor**: a 10-character hex passphrase generated on
first run. It is designed to keep casual scanners out of a service you run on your own machine.
It is **not** designed to resist a targeted attack.

If you need more than that, do not harden this layer — put the whole thing behind something
that actually does authentication (Cloudflare Access, Tailscale, WireGuard, an authenticated
reverse proxy). That is a better use of your time and a better security boundary.

## What it protects

| Asset | Where it lives | Protection |
|---|---|---|
| Access passphrase | `.passphrase`, mode 600 | File permissions |
| Session cookie | Browser, `HttpOnly` + `SameSite=Lax` | Not readable by JavaScript |
| dsh credentials | Server-side only, never sent to the phone | The phone never holds your dsh token |
| Push keys | `.push.json`, mode 600 | File permissions; plaintext at rest |
| Tunnel URL | `.tunnel-url` | Obscurity only — treat it as public |

Everything above is gitignored. If you fork this and commit any of those files, rotate the
credentials — `git rm --cached` does not remove them from history.

## Known limitations

Stated plainly, because you should know them before exposing this to the internet:

- **No per-device revocation.** One passphrase for every device. Changing it logs everyone out.
- **No brute-force lockout beyond rate limiting** on the login endpoint. There is no global
  per-IP throttle.
- **Plain HTTP on the LAN.** Tunnels terminate TLS; same-Wi-Fi traffic does not.
- **Push credentials are stored in plaintext** (mode 600). They are device tokens rather than
  account passwords, but treat the file accordingly.
- **No audit trail.** Access is not logged beyond what the process prints.
- **Not security-audited.** This is a personal tool published in case it is useful.

## Supported versions

Only the latest commit on `main` receives fixes. There are no maintained release branches.

## Reporting a vulnerability

**Do not open a public issue.**

Contact the maintainer privately — via the email on the commit history, or by opening a
[security advisory](../../security/advisories/new) on GitHub, which stays private until
disclosure.

Please include:

- what the issue allows an attacker to do
- the steps to reproduce it
- the version or commit you tested
- whether the service was reachable over a tunnel at the time

Expect an acknowledgement within a few days. This is a single-maintainer project, so a fix may
take longer — you will be told if that is the case rather than left waiting.

## If you believe you have been compromised

1. Stop the service.
2. Regenerate the passphrase: `rm .passphrase && ./start.sh`
3. Rotate push tokens: delete `.push.json`, re-enter them in the settings panel.
4. If your dsh credentials were exposed, rotate those too — that is outside this project's
   control and matters more than anything above.
5. Check `.tunnel-url` and assume the tunnel address is known; ngrok lets you rotate the domain.
