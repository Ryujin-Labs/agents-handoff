---
name: "handoff"
description: "Write a HANDOFF.md about a software change the developer finished, for another team and their coding agent. Use when the developer asks to write, create or send a handoff, or to tell another team (mobile, web, frontend, backend, sdk, devops...) about a change; never on your own initiative."
argument-hint: "[target] [note]"
allowed-tools: "Bash(handoff *) Bash(npx --yes agents-handoff *) Bash(git diff *) Bash(git log *) Read Grep Glob Write"
---

# Write a handoff

You are producing a `HANDOFF.md`: a short structured document that tells **a different developer, working in a different codebase, what they must change and why**.

Arguments: `$ARGUMENTS`

If the `handoff_*` MCP tools are available in this session — the plugin brings them — use them instead of the commands below: `handoff_write` stores a finished, validated document in one call, with every fact taken from git. The method is the same either way.

Interpret the argument as follows. It is optional and may be either form, or both:

- A short word or comma-separated list (`mobile`, `web`, `mobile,web`, `frontend`, `sdk`, `devops`) is the **target**: who has to act.
- Anything longer and sentence-like (`"tell the frontend team about the new auth rules"`) is a **note**: the developer telling you what this handoff is about. Extract the target from it if one is named, and keep the rest as the note.
- Nothing at all: infer the target from the change itself and say which you chose. If you genuinely cannot tell, target no one specific and write for any consumer.

If the developer provided no note or feature name, and the repository has changes touching multiple areas or features, do not guess: ask which feature or change they want to share before writing.

## 1. Collect the deterministic context

Run this first:

```
handoff context --target <target> --note "<note>"
```

If `handoff` is not on PATH, use `npx --yes agents-handoff context ...`. If neither works, tell the developer to run `npm i -g agents-handoff` — or to connect the MCP server, which needs no install — and stop.

Useful flags when the work is not simply "this branch":

| Situation | Flag |
|---|---|
| Compare against a different branch or tag | `--base main` |
| Describe the last N commits | `--commits 5` |
| Describe something from a while ago | `--since "3 weeks ago"` |
| Only what is uncommitted right now | `--working` |

The result is a **context brief**: the revision, the changed files, and pattern-matched signals about routes, auth guards, contracts, migrations, environment variables and dependencies. Read all of it.

It is raw material, not a handoff. It reports what moved; it cannot say what any of it means to another team.

## 2. Add what only you know

The brief is deliberately mechanical.

If you took part in building this change, your memory of that conversation is the highest-value input available and it is not in the brief: the requirement behind the change, the alternative that was rejected, the edge case that forced the design, the thing the developer asked you not to break.

If you did not take part — the developer is asking about work from last month — say so to yourself and compensate by reading more of the code.

## 3. Read the actual code

Open the files the brief lists under "Suggested reading", and enough of their surroundings to be sure. `git diff` on a specific path is often faster than reading the whole file.

Do not write a handoff from the brief alone. The brief reports that lines moved; only the code says what the behaviour now is.

Read enough to answer:

- What is the new observable behaviour at the boundary? Status codes, response fields, event payloads, required headers, ordering guarantees.
- What was it before? Check the previous version when the diff does not make it obvious.
- **Which of the "possible breaking changes" are real?** Those are regex matches, not findings. A renamed field looks identical to a removed one. Confirm each from the code and discard the ones that are wrong. Do not carry them into the document unexamined.
- What does a consumer that does nothing experience?

## 4. Check in, if the intent is genuinely unclear

Ask with AskUserQuestion, your proposal as the first option.

When the scope is the problem, `--paths` is the fix: `handoff context --working --paths src/chat` describes one slice of a mixed working tree, and you can write more than one handoff from the same tree.

Decide what you can. Ask about what you cannot.

The bar is whether a different answer would produce a materially different document. These are the cases where it usually would:

- **An unspecified feature or multiple features in scope.** When the developer ran handoff without specifying what feature or change they are handing off, or when the repository contains changes spanning multiple features or commits: do not guess or silently pick one. List the candidate features or areas detected in the diff and ask: "Which feature or change would you like to share?"
- **A mixed working tree.** More than one unrelated piece of work is in scope — a deploy script and an auth change, say. Say what you found, say which slice you propose to describe, and offer to narrow or to write more than one handoff. Do not silently pick the largest.
- **A handoff for this change already exists.** The brief lists what was already written here. If one covers the same change, ask whether to update it or write a new one beside it; it may already have been sent. Never replace one on your own judgment.
- **A target you had to guess.** The change plausibly affects several consumers and nobody named one. Say which you chose and why.
- **A breaking call you cannot settle from the code.** The evidence is genuinely split. State both readings rather than picking the confident-sounding one.
- **A language other than English is in play** and nothing in the request or the configuration says which to use.

Ask once, in one message, with your proposed answer already in it — "I'm describing the nginx and deploy changes for devops and leaving the auth work out; want it the other way?" is a question a developer can answer in three words. A list of four separate questions is an interrogation.

When nothing is genuinely ambiguous and the developer already named the feature, do not manufacture a question. Deciding well is the job.

## 5. Write it

```
handoff create --target <target> --title "<short title>"
```

This writes `.handoff/<id>/HANDOFF.md` with the frontmatter already filled in from git — id, timestamp, branch, commit, revision range — and `<!-- TODO -->` markers in the body. It prints the path.

Read that file, then rewrite it with the Write tool. **Keep the generated frontmatter as it is**, with three exceptions you set yourself: `status: ready`, `breaking:`, and a corrected `change_type:`.

Every `<!-- TODO -->` must be gone. A document that still contains one is a scaffold, not a handoff — `handoff validate` rejects a `status: ready` document that has one, and `handoff send` refuses to deliver it.

Write for a specific reader: a competent engineer in another codebase who was not in your conversation and has no context on your repo.

**Write in English.** A handoff crosses team boundaries, so English is the default even when the repository's other documents are in another language — do not infer a language from what you find in `docs/`. Use another language only when the developer asks for one, or when the project has configured one. Section headings stay English regardless: they are the machine contract that validation and the receiving side read.

Set `breaking` from behaviour, not diff size: true only if a consumer who changes nothing is now wrong or broken.

The sections:

**Summary** — 1 to 4 sentences. What changed, in the *consumer's* vocabulary, not yours. "Refresh tokens are now single-use", not "refactored TokenService".

**Why This Matters** — the consequence of ignoring this. Not the engineering rationale. The reader does not care why you chose the design; they care what happens to them.

**Changes** — the concrete behavioural delta. Prefer an explicit previous → new contrast. Include the literal interface where it helps: an endpoint, a payload shape, a header. Small and exact.

**Required Actions** — *the most important section in the document.* Numbered imperatives, one action each, addressed to the target. If there are several targets, split with `### <target>` subsections and give each one only what applies to it. The same backend change means different work for mobile and for devops, and sometimes it means "no action required" — which is a real and useful answer, so write it when it is true.

**Breaking Changes** — required when `breaking` is true. State exactly what fails for a consumer that does nothing.

**Verification** — how the receiver proves *their* implementation is right. Name the scenario to exercise, not just "run the tests".

**Instructions for Receiving Agent** — *the second most important section.* You are writing to another coding agent working in a codebase you have never seen. Its most likely failure is not misunderstanding your change — it is building a second implementation of something that already exists on their side. Tell it which existing module to modify rather than duplicate, what not to build, and what to report back if the contract does not match what it finds.

Optional, only when they carry weight: **Contracts**, **Relevant Source** (a short list of paths in *your* repo), **Out of Scope**, **Notes**.

## 6. Cut it down

Re-read what you wrote and delete:

- anything the reader can see in their own code
- background, history, and the story of how you got there
- implementation details of your side that do not cross the boundary
- restatements of the same point in two sections
- diffs. Never paste a diff. Cite a path instead.

Target: under 400 words for an ordinary change. A handoff should be readable in about two minutes. If it is longer than that, you have written documentation, not a handoff.

Then check it:

```
handoff validate <path>
```

Fix every error. Warnings are advice — `too-long`, `diff-dump` and `unstructured-actions` in particular are usually telling you something true. If you disagree with one, leave it and say why in your report.

## 7. Report back

Tell the developer, briefly:

- where the file is
- who it targets
- whether you marked it breaking, and on what evidence
- anything you were unsure about and decided by assumption
- **the Required Actions, as you wrote them** — what the other team will actually do

That report is the developer's review, so it goes before the delivery question, never after the send. The Required Actions are the part a mistake is expensive in; they should not have to open the file to see what they are about to send.

Then **get it delivered**. A handoff nobody sends is a file nobody reads, and "you can share this now" is not an instruction — it is the work left undone.

Look up the routes this project has configured for the target, then **ask which to use with your question interface**, offering the configured routes as the choices — plus **"let me review it first"** for a developer who wants to read the whole document or change a line before anything leaves. After they have, deliver to the route they pick without asking the rest again. A list of options someone has to type back is worse than a list they can click. If nothing is configured, offer what works anyway and mention that routes can be set once so the answer is automatic next time.

When one change produced several handoffs — a different one for mobile and for web — deliver them together, each to its own target's route, rather than making the developer repeat themselves once per team.

Delivering opens the chat or mail window with an opening line already written. What the recipient then gets depends on one choice, so offer it:

- **A link into the repository** — the handoff is already committed, so the message carries a URL to it. Readable by whoever can read the repository and nobody else, which for a private repository means the team and no one on the open web. Nothing is uploaded. It needs the handoff pushed first.
- **A link to an uploaded copy** — a GitHub "secret" gist. Secret means unlisted, *not* private: anyone who comes by the URL can read it, with or without an account. Offer it for a handoff whose leaking would not matter, and say plainly who can read it.
- **The file** — nothing is uploaded and nothing is linked; the document is revealed ready to drag in, and the message says the file is coming rather than claiming it is already there.

Whichever you use, tell the developer **who can read what you just put in the message**. Never call a gist private.

For chat apps, do not ask who to send it to. The app already knows their colleagues: it opens on a contact list with the message written, and the developer picks — one person, several, or a group — far faster than answering a question about phone numbers.

Either way the last step is theirs: send. Say so, rather than implying it has gone.

Do not commit anything. Do not deliver without being asked: it leaves the machine, and it is the developer's call, not yours.

See how this project reaches the target, then put the routes to the developer with AskUserQuestion so they can pick rather than type — with "let me review it first" among the options — and deliver the one they pick yourself, rather than handing them a command to run.

With the `handoff_*` MCP tools: `handoff_delivery_options`, then `handoff_deliver` once they have picked. Without them:

```
handoff send <id> --list
handoff send <id> --channel <route>
```

For whatsapp, email and slack, `--link` decides what the message carries — offer it in the same question, with who can read each:

- `--link repo` — a link to the handoff where it is committed. Readable by whoever can read the repository; nothing is uploaded. Needs the handoff pushed.
- `--link gist` — uploads a secret gist. Unlisted, but readable by anyone who has the URL.
- no link — the file is revealed for the developer to attach.

Never run the send without being asked.
