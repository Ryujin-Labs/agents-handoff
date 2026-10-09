/**
 * The methodology for writing and receiving a handoff, held in one place.
 *
 * Two surfaces teach an agent this — the Claude Code skill and the MCP prompt — and they
 * differ only in mechanics: one drives a CLI through a shell, the other calls tools. The
 * judgment being taught is identical, so it lives here and each surface injects its own
 * mechanics at named points. Written twice, it would drift, and the copy that drifted
 * would still look authoritative.
 */

export interface Step {
  /** Where a surface injects its mechanics. */
  id: string;
  /** Heading, rendered as `## <n>. <title>`. */
  title: string;
  /** Shared prose, free of any mention of a command or a tool. */
  body: string;
}

export const AUTHORING_INTRO = `You are producing a \`HANDOFF.md\`: a short structured document that tells **a different developer, working in a different codebase, what they must change and why**.`;

export const ARGUMENT_GUIDANCE = `Interpret the argument as follows. It is optional and may be either form, or both:

- A short word or comma-separated list (\`mobile\`, \`web\`, \`mobile,web\`, \`frontend\`, \`sdk\`, \`devops\`) is the **target**: who has to act.
- Anything longer and sentence-like (\`"tell the frontend team about the new auth rules"\`) is a **note**: the developer telling you what this handoff is about. Extract the target from it if one is named, and keep the rest as the note.
- Nothing at all: infer the target from the change itself and say which you chose. If you genuinely cannot tell, target no one specific and write for any consumer.

If the developer provided no note or feature name, and the repository has changes touching multiple areas or features, do not guess: ask which feature or change they want to share before writing.`;

export const AUTHORING_STEPS: readonly Step[] = [
  {
    id: 'collect',
    title: 'Collect the deterministic context',
    body: `The result is a **context brief**: the revision, the changed files, and pattern-matched signals about routes, auth guards, contracts, migrations, environment variables and dependencies. Read all of it.

It is raw material, not a handoff. It reports what moved; it cannot say what any of it means to another team.`,
  },
  {
    id: 'recall',
    title: 'Add what only you know',
    body: `The brief is deliberately mechanical.

If you took part in building this change, your memory of that conversation is the highest-value input available and it is not in the brief: the requirement behind the change, the alternative that was rejected, the edge case that forced the design, the thing the developer asked you not to break.

If you did not take part — the developer is asking about work from last month — say so to yourself and compensate by reading more of the code.`,
  },
  {
    id: 'read',
    title: 'Read the actual code',
    body: `Do not write a handoff from the brief alone. The brief reports that lines moved; only the code says what the behaviour now is.

Read enough to answer:

- What is the new observable behaviour at the boundary? Status codes, response fields, event payloads, required headers, ordering guarantees.
- What was it before? Check the previous version when the diff does not make it obvious.
- **Which of the "possible breaking changes" are real?** Those are regex matches, not findings. A renamed field looks identical to a removed one. Confirm each from the code and discard the ones that are wrong. Do not carry them into the document unexamined.
- What does a consumer that does nothing experience?`,
  },
  {
    id: 'check',
    title: 'Check in, if the intent is genuinely unclear',
    body: `Decide what you can. Ask about what you cannot.

The bar is whether a different answer would produce a materially different document. These are the cases where it usually would:

- **An unspecified feature or multiple features in scope.** When the developer ran handoff without specifying what feature or change they are handing off, or when the repository contains changes spanning multiple features or commits: do not guess or silently pick one. List the candidate features or areas detected in the diff and ask: "Which feature or change would you like to share?"
- **A mixed working tree.** More than one unrelated piece of work is in scope — a deploy script and an auth change, say. Say what you found, say which slice you propose to describe, and offer to narrow or to write more than one handoff. Do not silently pick the largest.
- **A handoff for this change already exists.** The brief lists what was already written here. If one covers the same change, ask whether to update it or write a new one beside it; it may already have been sent. Never replace one on your own judgment.
- **A target you had to guess.** The change plausibly affects several consumers and nobody named one. Say which you chose and why.
- **A breaking call you cannot settle from the code.** The evidence is genuinely split. State both readings rather than picking the confident-sounding one.
- **A language other than English is in play** and nothing in the request or the configuration says which to use.

Ask once, in one message, with your proposed answer already in it — "I'm describing the nginx and deploy changes for devops and leaving the auth work out; want it the other way?" is a question a developer can answer in three words. A list of four separate questions is an interrogation.

When nothing is genuinely ambiguous and the developer already named the feature, do not manufacture a question. Deciding well is the job.`,
  },
  {
    id: 'compose',
    title: 'Write it',
    body: `Write for a specific reader: a competent engineer in another codebase who was not in your conversation and has no context on your repo.

**Write in English.** A handoff crosses team boundaries, so English is the default even when the repository's other documents are in another language — do not infer a language from what you find in \`docs/\`. Use another language only when the developer asks for one, or when the project has configured one. Section headings stay English regardless: they are the machine contract that validation and the receiving side read.

Set \`breaking\` from behaviour, not diff size: true only if a consumer who changes nothing is now wrong or broken.

The sections:

**Summary** — 1 to 4 sentences. What changed, in the *consumer's* vocabulary, not yours. "Refresh tokens are now single-use", not "refactored TokenService".

**Why This Matters** — the consequence of ignoring this. Not the engineering rationale. The reader does not care why you chose the design; they care what happens to them.

**Changes** — the concrete behavioural delta. Prefer an explicit previous → new contrast. Include the literal interface where it helps: an endpoint, a payload shape, a header. Small and exact.

**Required Actions** — *the most important section in the document.* Numbered imperatives, one action each, addressed to the target. If there are several targets, split with \`### <target>\` subsections and give each one only what applies to it. The same backend change means different work for mobile and for devops, and sometimes it means "no action required" — which is a real and useful answer, so write it when it is true.

**Breaking Changes** — required when \`breaking\` is true. State exactly what fails for a consumer that does nothing.

**Verification** — how the receiver proves *their* implementation is right. Name the scenario to exercise, not just "run the tests".

**Instructions for Receiving Agent** — *the second most important section.* You are writing to another coding agent working in a codebase you have never seen. Its most likely failure is not misunderstanding your change — it is building a second implementation of something that already exists on their side. Tell it which existing module to modify rather than duplicate, what not to build, and what to report back if the contract does not match what it finds.

Optional, only when they carry weight: **Contracts**, **Relevant Source** (a short list of paths in *your* repo), **Out of Scope**, **Notes**.`,
  },
  {
    id: 'cut',
    title: 'Cut it down',
    body: `Re-read what you wrote and delete:

- anything the reader can see in their own code
- background, history, and the story of how you got there
- implementation details of your side that do not cross the boundary
- restatements of the same point in two sections
- diffs. Never paste a diff. Cite a path instead.

Target: under 400 words for an ordinary change. A handoff should be readable in about two minutes. If it is longer than that, you have written documentation, not a handoff.`,
  },
  {
    id: 'report',
    title: 'Report back',
    body: `Tell the developer, briefly:

- where the file is
- who it targets
- whether you marked it breaking, and on what evidence
- anything you were unsure about and decided by assumption
- **the Required Actions, as you wrote them** — what the other team will actually do

The complete Markdown file is the result. Keep all sections, frontmatter, examples and instructions in that file; do not replace it with an opening message or a shortened summary. If the developer requests a separate copy, export the complete document and report the exported path.

When one change produced several handoffs — a different one for mobile and for web — report each complete file and the team it targets.

Finish with the file paths and the Required Actions. Do not ask for a delivery channel or recipient. Do not open another application, copy to the clipboard, create a hosted link, or send a message. The developer shares the Markdown file through their own workflow.

Do not commit anything.`,
  },
];

export const RECEIVING_INTRO = `Another developer's agent wrote a \`HANDOFF.md\` describing a change in **their** codebase. Your job is to work out what it means for **this** one.`;

export const RECEIVING_STEPS: readonly Step[] = [
  {
    id: 'parse',
    title: 'Parse it',
    body: `The result is the document reordered for someone who has to act: whether it concerns this repository, then \`Required Actions\` narrowed to your target, then the rest.

If validation reports errors, still read the document, but treat its claims with proportionate caution and say so in your report.`,
  },
  {
    id: 'applies',
    title: 'Establish whether it actually applies',
    body: `Before planning any work, find out whether this repository consumes the thing that changed.

Search for the concrete nouns in the handoff: the endpoint paths, the type names, the environment variables, the event names.

Three honest outcomes, all of them fine:

- **It applies.** You found the calling code. Continue.
- **It does not apply.** Nothing here touches that surface. Say so plainly and stop. Do not invent work to justify the handoff.
- **You cannot tell.** The integration may be dynamic, generated, or in another repository. Say exactly what you searched for and what you found, and ask.`,
  },
  {
    id: 'compare',
    title: 'Compare current behaviour against the new contract',
    body: `For each item in \`Required Actions\`, find the code that implements the old behaviour and state the specific difference. Be concrete: file, function, and what it does today versus what the handoff says it must do.

Where the handoff is ambiguous or contradicts what you find in this codebase, note it. A contract mismatch is information the sender needs, and it is far cheaper to raise now than after the implementation.`,
  },
  {
    id: 'respect',
    title: "Respect the sender's constraints",
    body: `\`Instructions for Receiving Agent\` is written by someone who knows their change but not this codebase. It usually tells you what *not* to do — most often, not to build a second implementation of something that already exists here.

Honour that. Extend the existing module. Do not introduce a parallel client, a second token store, or a new HTTP layer because it is easier than reading the current one.`,
  },
  {
    id: 'plan',
    title: 'Present a plan, then wait',
    body: `Report:

1. Whether this handoff applies here, with the evidence.
2. The specific changes needed: file by file, in this repository's terms.
3. Anything in the handoff that does not match reality here.
4. What you will verify afterwards, based on the handoff's \`Verification\` section adapted to this codebase.

Then stop and wait for the developer, unless they have already told you to implement directly.`,
  },
  {
    id: 'implement',
    title: 'Implement, if asked',
    body: `Follow this project's existing conventions, not the sender's. Their repository's patterns are not evidence about yours.

Afterwards run this project's own checks, and report anything that did not line up with what the handoff promised. Give that back to the developer in a form they can forward to the sender.`,
  },
];
