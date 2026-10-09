# Vision

## The gap

Git tells you **what code changed**.

Nothing tells the next developer **what that change means for them**.

That gap is normally filled by a brief message, a stand-up, a PR description nobody
reads, or a 40-minute call. It is filled badly, late, or not at all — and now there is a
second audience that is even worse served by it: the coding agent sitting next to every
developer.

An agent that helped build a change understands it deeply. An agent on the other side of
that change — in the mobile app, the web client, the SDK — understands nothing about it.
It will happily write code against an API contract that stopped being true yesterday.

## The idea

**Agents Handoff is a handoff protocol for software changes.**

One developer's agent writes a short, structured `HANDOFF.md`. Another developer's agent
reads it and knows exactly what to do.

```
software change → understanding → structured Markdown → export → receiving agent → implementation
```

The artifact is a Markdown file. Markdown, because:

- humans can read it with no tooling at all
- every coding agent already reads it well
- it is a complete, portable file that any developer can open and any agent can consume
- it is diffable, greppable, and reviewable

The top of the file is YAML frontmatter, so machines get a stable contract before they
read a single word of prose.

## What Agents Handoff is not

Agents Handoff is not a documentation generator. A documentation generator answers *"what does
this code do?"*. Agents Handoff answers a different and much narrower question:

> **"You are a different developer, working in a different codebase. What do you have to
> change, and why?"**

Agents Handoff is also not project management or a transport service. Its responsibility
starts when a change is finished and ends when the receiving agent knows what to implement. Everything after that belongs to the
tools that already exist.

## Principles

1. **Agent-first, human-readable.** The primary consumer is a coding agent. The secondary
   consumer is a human in a hurry. Both are served by the same file.
2. **Local-first and private by default.** Agents Handoff reads your repository and writes a file.
   It validates and exports the complete Markdown, with a local path the developer can
   review and use.
3. **Deterministic core, intelligent edges.** Everything that can be computed from Git and
   the filesystem is computed by plain, testable code. Only judgment — what matters, what
   breaks, what the other team must do — is left to a model.
4. **The agent that did the work writes the handoff.** It already has the repository and
   the conversation. Asking a second model to re-derive that from a diff is slower, more
   expensive, and worse.
5. **Signal over completeness.** A handoff that dumps the diff has failed. If it takes
   longer than a few minutes to read, it has failed.
6. **`Required Actions` is the point.** The receiving agent needs to know what to *do*,
   not merely what happened.
7. **Agent-independent.** Claude Code is the first adapter, not the architecture.
8. **Boring to install, boring to remove.** One directory, one config file, no service.

## Where this goes

Long term, the interesting object here is not the tool — it is the format.

`AGENTS.md` became a lightweight convention for telling an agent how to work *inside* a
repository. There is no equivalent convention for telling an agent what changed *outside*
it. `HANDOFF.md` is a candidate for that: a small, stable, vendor-neutral document that
any agent can emit and any agent can consume.

The tool exists to prove the format is worth having.

## The question we are actually testing

> Does generating and transferring structured software-change handoffs meaningfully
> improve developer-to-developer and agent-to-agent collaboration?

Everything in this repository is in service of answering that, cheaply and quickly. If the
answer is no, the format costs nothing to abandon. If the answer is yes, the format
matters far more than the implementation.
