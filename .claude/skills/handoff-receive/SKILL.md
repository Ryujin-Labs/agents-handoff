---
name: "handoff-receive"
description: "Read a HANDOFF.md another team sent, work out what it means for this repository, and plan the work. Use when the developer shares a handoff file (often in Downloads) or pastes one, or asks what a teammate's handoff needs here."
argument-hint: "<path-to-handoff.md> [--as target]"
allowed-tools: "Bash(handoff *) Bash(npx --yes agents-handoff *) Read Grep Glob"
---

# Receive a handoff

Another developer's agent wrote a `HANDOFF.md` describing a change in **their** codebase. Your job is to work out what it means for **this** one.

Arguments: `$ARGUMENTS` — a path to the handoff file, optionally followed by `--as <target>` naming which consumer this repository is.

If the `handoff_*` MCP tools are available in this session — the plugin brings them — use them instead of the commands below. They only read files inside this project, and a handoff someone sent usually sits in Downloads, so step 1 says how to pass it. Do not copy the file into the project.

## 1. Parse it

Do not skip this by reading the document yourself. This step is what narrows `Required Actions` to this repository's target — a handoff for mobile and web carries both sets of instructions — reports validation problems, and files a copy under `.handoff/inbox/`.

With the `handoff_*` MCP tools: read the file, then call `handoff_receive` with its contents as `markdown` and `as` set to this repository's target. Pass `file_path` only for a file inside this project.

Without them:

```
handoff receive <path> --as <target>
```

If the developer pasted the handoff into the conversation rather than giving you a file, pass it as `markdown`, or write it to a temporary file for the command.

The result is the document reordered for someone who has to act: whether it concerns this repository, then `Required Actions` narrowed to your target, then the rest.

If validation reports errors, still read the document, but treat its claims with proportionate caution and say so in your report.

## 2. Establish whether it actually applies

Use Grep and Glob over this repository.

Before planning any work, find out whether this repository consumes the thing that changed.

Search for the concrete nouns in the handoff: the endpoint paths, the type names, the environment variables, the event names.

Three honest outcomes, all of them fine:

- **It applies.** You found the calling code. Continue.
- **It does not apply.** Nothing here touches that surface. Say so plainly and stop. Do not invent work to justify the handoff.
- **You cannot tell.** The integration may be dynamic, generated, or in another repository. Say exactly what you searched for and what you found, and ask.

## 3. Compare current behaviour against the new contract

For each item in `Required Actions`, find the code that implements the old behaviour and state the specific difference. Be concrete: file, function, and what it does today versus what the handoff says it must do.

Where the handoff is ambiguous or contradicts what you find in this codebase, note it. A contract mismatch is information the sender needs, and it is far cheaper to raise now than after the implementation.

## 4. Respect the sender's constraints

`Instructions for Receiving Agent` is written by someone who knows their change but not this codebase. It usually tells you what *not* to do — most often, not to build a second implementation of something that already exists here.

Honour that. Extend the existing module. Do not introduce a parallel client, a second token store, or a new HTTP layer because it is easier than reading the current one.

## 5. Present a plan, then wait

Report:

1. Whether this handoff applies here, with the evidence.
2. The specific changes needed: file by file, in this repository's terms.
3. Anything in the handoff that does not match reality here.
4. What you will verify afterwards, based on the handoff's `Verification` section adapted to this codebase.

Then stop and wait for the developer, unless they have already told you to implement directly.

## 6. Implement, if asked

Follow this project's existing conventions, not the sender's. Their repository's patterns are not evidence about yours.

Afterwards run this project's own checks, and report anything that did not line up with what the handoff promised. Give that back to the developer in a form they can forward to the sender.
