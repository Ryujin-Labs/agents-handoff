---
name: handoff
description: "Write a HANDOFF.md describing a software change the developer just finished, for another team and their coding agent. Use when the developer asks to write, create or export a handoff describing a change for another team (mobile, web, frontend, backend, devops...)."
---

# Write a handoff

You are producing a `HANDOFF.md`: a short structured document that tells **a different developer, working in a different codebase, what they must change and why**.

Use the `handoff_*` tools from the agents-handoff MCP server, and the absolute path of the repository the change is in for every call. If the developer named a target (mobile, web, frontend, backend, sdk, devops…) or said what the handoff should say, use that.

Interpret the argument as follows. It is optional and may be either form, or both:

- A short word or comma-separated list (`mobile`, `web`, `mobile,web`, `frontend`, `sdk`, `devops`) is the **target**: who has to act.
- Anything longer and sentence-like (`"tell the frontend team about the new auth rules"`) is a **note**: the developer telling you what this handoff is about. Extract the target from it if one is named, and keep the rest as the note.
- Nothing at all: infer the target from the change itself and say which you chose. If you genuinely cannot tell, target no one specific and write for any consumer.

If the developer provided no note or feature name, and the repository has changes touching multiple areas or features, do not guess: ask which feature or change they want to share before writing.

## 1. Collect the deterministic context

Call `handoff_context`. It is fast, local, and reads nothing outside the repository.

If the change is not simply "this branch", pass a scope: `base` to compare against another ref, `commits` for the last N, `since` for older work, `working` for uncommitted changes only.

If the developer did not name the feature or change they want to hand off, or if the brief shows multiple features/areas, ask the developer: "Which feature or change would you like to share?" (or summarize the detected features and ask them to pick/confirm) before calling `handoff_write`.

The result is a **context brief**: the revision, the changed files, and pattern-matched signals about routes, auth guards, contracts, migrations, environment variables and dependencies. Read all of it.

It is raw material, not a handoff. It reports what moved; it cannot say what any of it means to another team.

## 2. Add what only you know

The brief is deliberately mechanical.

If you took part in building this change, your memory of that conversation is the highest-value input available and it is not in the brief: the requirement behind the change, the alternative that was rejected, the edge case that forced the design, the thing the developer asked you not to break.

If you did not take part — the developer is asking about work from last month — say so to yourself and compensate by reading more of the code.

## 3. Read the actual code

Call `handoff_source` on the files the brief lists under "Suggested reading". Use `mode: "diff"` where the previous behaviour is not obvious from the current file.

Do not write a handoff from the brief alone. The brief reports that lines moved; only the code says what the behaviour now is.

Read enough to answer:

- What is the new observable behaviour at the boundary? Status codes, response fields, event payloads, required headers, ordering guarantees.
- What was it before? Check the previous version when the diff does not make it obvious.
- **Which of the "possible breaking changes" are real?** Those are regex matches, not findings. A renamed field looks identical to a removed one. Confirm each from the code and discard the ones that are wrong. Do not carry them into the document unexamined.
- What does a consumer that does nothing experience?

## 4. Check in, if the intent is genuinely unclear

Ask with your client's question tool if it has one, your proposal as the first option; otherwise in one short message. If the tool returns before the developer has answered, stop there: end your turn with at most a line pointing at the question. Do not ask it again as text, and do not start work that depends on the answer.

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

Call `handoff_write`. You supply only prose — the schema version, id, timestamp, branch, commit and revision range come from git, and the section headings are generated.

The document is validated before it is stored. If it does not conform, nothing is written and you get the errors back; fix them and call the tool again.

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

## 7. Report back

Tell the developer, briefly:

- where the file is
- who it targets
- whether you marked it breaking, and on what evidence
- anything you were unsure about and decided by assumption
- **the Required Actions, as you wrote them** — what the other team will actually do

The complete Markdown file is the result. Keep all sections, frontmatter, examples and instructions in that file; do not replace it with an opening message or a shortened summary. If the developer requests a separate copy, export the complete document and report the exported path.

When one change produced several handoffs — a different one for mobile and for web — report each complete file and the team it targets.

Finish with the file paths and the Required Actions. Do not ask for a delivery channel or recipient. Do not open another application, copy to the clipboard, create a hosted link, or send a message. The developer shares the Markdown file through their own workflow.

Do not commit anything.

Call `handoff_export` after `handoff_write` to produce a local Markdown file and return its full contents. Report its path, targets, breaking status, and Required Actions. If you generated handoffs for several targets, identify each file and what it covers.
