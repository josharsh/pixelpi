# Security Policy

## Supported versions

pixelpi is pre-1.0. Security fixes land on the latest published minor of each package
(`pixelpi`, `@josharsh/pixelpi-ai`, `@josharsh/pixelpi-core`, `@josharsh/pixelpi-cdp`). Older versions are not patched —
upgrade to the latest release.

| Version       | Supported |
| ------------- | --------- |
| latest        | yes       |
| anything else | no        |

## Reporting a vulnerability

Report privately. Do not open a public issue for a security problem.

- Preferred: open a [GitHub Security Advisory](https://github.com/josharsh/pixelpi/security/advisories/new) on this repo.
- Or email harsh.joshi.pth@gmail.com.

Include what you did, what happened, and how to reproduce. We'll acknowledge and work a fix.
There is no bug-bounty program.

## Threat model — read this before you run it

pixelpi is a browser-agent harness. By design it runs **model-generated JavaScript in a real
Chrome browser** via `eval`, and — when you opt into eval host mode — it can run code **on the
host machine** too. That is the point of the tool, and it is also the risk.

Consequences:

- A model can read and act on whatever the controlled browser can: open tabs, logged-in
  sessions, cookies, autofill, and any page it navigates to.
- Prompt injection from a visited page can steer the agent. Treat page content as untrusted input.
- Host eval mode hands code execution to the model on your machine. Only enable it when you
  understand and accept that.

How to run it safely:

- Run pixelpi only against sites and credentials **you trust** and are willing to expose to the model.
- **Isolate it.** Use a disposable Chrome profile (the default launch uses a fresh profile —
  don't point it at your everyday profile via `userDataDir`).
- Keep host eval mode off unless you have a specific, contained reason to turn it on.
- Don't run untrusted tasks against authenticated production accounts.
