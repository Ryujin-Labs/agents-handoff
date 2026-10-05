---
name: handoff-receive
description: "Read a HANDOFF.md another team sent and work out what it means for this repository. Use when the developer shares or pastes a handoff, or asks what a teammate's handoff requires here."
---

# Receive a handoff

Another developer's agent wrote a `HANDOFF.md` describing a change in **their** codebase. Your job is to work out what it means for **this** one.

Use the `handoff_*` tools from the agents-handoff MCP server, with the absolute path of this repository. If nobody said which consumer this repository is, work it out from the code or ask, so Required Actions can be narrowed.

## 1. Parse it

Call `handoff_receive`, with `as` set to this repository's target. Do not skip it by reading the document yourself: this is the step that narrows `Required Actions` to this repository — a handoff for mobile and web carries both sets of instructions — reports validation problems, and keeps a copy under `.handoff/inbox`. It accepts a path inside this project, or the markdown itself; a handoff someone sent usually sits in Downloads, outside the project, so read that file and pass its contents as `markdown`.

The result is the document reordered for someone who has to act: whether it concerns this repository, then `Required Actions` narrowed to your target, then the rest.

If validation reports errors, still read the document, but treat its claims with proportionate caution and say so in your report.

## 2. Establish whether it actually applies

Use your own file search over this repository. `handoff_source` reads specific files once you know which ones matter.

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
