# Security policy

Sessions Desk can read the screen and the transcripts of Claude Code sessions and type into their terminals. A
flaw in it can therefore expose secrets or run commands on the machine. Reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead: on this repository, open the
**Security** tab and choose **Report a vulnerability**.

Tell us what you found, how to reproduce it, and what an attacker gains. A proof of concept helps.

## What to expect

This project is shared as-is by a small team, without a support commitment. We read every report and aim to
answer within two weeks. There is no bug bounty.

## Scope

In scope: the server (`server/`), the Windows driver (`driver/`) and the page.

Known limits, documented in the README and not considered vulnerabilities:

- There is no local authentication: the tool is meant for single-user machines, and any local process can call
  its API.
- Remote access is designed for `tailscale serve` inside your own tailnet. Exposing the server any other way —
  `tailscale funnel`, a reverse proxy, a port forward — is unsupported.
