# Security

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/Ryujin-Labs/agents-handoff/security/advisories/new),
not in a public issue. Include the version, how to reproduce it, and what an attacker gains.

You should get a first response within a week. Fixes are released as a patch version, with
credit in the changelog unless you would rather not be named.

## What is in scope

Agents Handoff handles two kinds of untrusted input, and both are in scope:

- **Handoffs written by someone else.** A `HANDOFF.md` arrives from another team and is
  read, stored and briefed to a coding agent. Anything in it that can write outside the
  project, read files it should not, or steer the receiving agent into acting on
  instructions unrelated to the change is a vulnerability.
- **Arguments from a model.** The MCP server's tool arguments are chosen by an agent, which
  may itself be reading attacker-controlled text. Anything that escapes the project
  directory or `--root`, reads a credentials file, or reaches the network without a
  delivery the developer asked for is a vulnerability.

A credential that slips past the scanner in `redact.ts` is worth reporting too, though the
scanner is a safety net for accidents rather than a security boundary.

## What the project promises

- Writing, reading, validating and receiving a handoff make no network calls.
- The MCP server reads and writes only inside the project it is given — the copy it makes
  for attaching to a message included — with symlinks
  resolved before the check, and refuses files that exist to hold credentials.
- A handoff's `id` never chooses where a file is written.
- Nothing is delivered without the developer choosing a channel.

## Supported versions

Only the latest release receives fixes while the project is at 0.x.
