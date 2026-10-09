# HANDOFF.md — Protocol Specification v1

Status: **draft**  ·  `handoff_version: 1`

A handoff is a single UTF-8 Markdown file describing **one completed software change** and
**what a specific consumer must do about it**.

A conforming file has two parts:

1. **YAML frontmatter** — a machine contract. Parsed before any prose is read.
2. **Markdown body** — a human/agent contract, made of named `##` sections.

```
---
<frontmatter>
---

# <Title>

## <Section>
...
```

---

## 1. Frontmatter

Delimited by a line containing exactly `---` at the very start of the file, and a closing
line containing exactly `---`. Content between them is YAML 1.2.

### 1.1 Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `handoff_version` | integer | **yes** | Must be `1`. |
| `id` | string | **yes** | Stable identifier. `^[a-z0-9][a-z0-9._-]*$`, max 120 chars. Conventionally `YYYY-MM-DD-<slug>`. |
| `title` | string | no | Falls back to the `#` H1 in the body. |
| `created_at` | string | **yes** | ISO 8601 with timezone, e.g. `2026-08-28T18:20:00Z`. |
| `status` | enum | **yes** | `draft` \| `ready` \| `delivered` \| `acknowledged` \| `complete`. |
| `breaking` | boolean | **yes** | `true` if any consumer breaks by doing nothing. |
| `source` | object | **yes** | Where the change came from. See 1.2. |
| `targets` | string[] | **yes** | Who must act. May be empty (`[]`) meaning "any consumer". |
| `change_type` | string[] | **yes** | Open vocabulary. See 1.3. |
| `author` | string | no | Human name or handle. |
| `generated_by` | string | no | Tool/agent that produced the file, e.g. `agents-handoff/0.1.0 (claude-code)`. |
| `supersedes` | string | no | `id` of a handoff this replaces. |
| `expires_at` | string | no | ISO 8601. After this, treat as stale. |
| `links` | object[] | no | `{ label, url }`. PRs, issues, docs. |
| `x-*` | any | no | Reserved for vendor extensions. Validators must ignore unknown `x-` keys. |

Unknown non-`x-` keys are preserved on round-trip and reported as **warnings**, not errors.

### 1.2 `source`

| Field | Type | Required | Notes |
|---|---|---|---|
| `project` | string | **yes** | Logical name of the originating codebase, e.g. `backend`. |
| `repo` | string | no | Remote URL or `owner/name`. |
| `branch` | string | no | |
| `commit` | string | no | Short or full SHA. |
| `range` | string | no | Git revision range the handoff covers, e.g. `main..HEAD`. |

### 1.3 `change_type`

Open vocabulary — validators **warn** on unrecognized values but never reject them. Known
values:

`api`, `authentication`, `authorization`, `contract`, `schema`, `database`, `migration`,
`config`, `environment`, `dependency`, `infrastructure`, `performance`, `security`,
`behavior`, `ui`, `deprecation`, `removal`, `bugfix`, `feature`, `refactor`, `tooling`.

### 1.4 `targets`

Free-form consumer labels. Common: `mobile`, `ios`, `android`, `web`, `frontend`,
`backend`, `sdk`, `devops`, `data`, `qa`, `docs`.

Aliases are normalized case-insensitively by implementations (`fe` → `frontend`,
`be` → `backend`, `infra` → `devops`, …) but the file stores whatever was written.

---

## 2. Body

### 2.1 Title

The first non-blank line after the frontmatter **must** be a single `#` H1. It is the
handoff title. There must be exactly one H1 in the document.

### 2.2 Sections

Sections are `##` headings. Matching is **case-insensitive** on the heading text after
normalizing whitespace. A section is *present* only if it contains at least one non-blank
line of content.

| Section | Required | Purpose |
|---|---|---|
| `Summary` | **yes** | 1–4 sentences. What changed, in the consumer's vocabulary. |
| `Why This Matters` | **yes** | The consequence of ignoring this. Not the engineering rationale. |
| `Changes` | **yes** | The concrete behavioral delta. Prefer *previous → new*. |
| `Required Actions` | **yes** | **The most important section.** Imperative, numbered, per target. |
| `Breaking Changes` | conditional | Required and non-empty when `breaking: true`. |
| `Instructions for Receiving Agent` | **yes** | **Second most important.** How the receiving agent should approach its own codebase. |
| `Verification` | **yes** | How the receiver proves their implementation is correct. |
| `Contracts` | no | Endpoints, payloads, types, events. The literal interface. |
| `Relevant Source` | no | Pointers into the *source* repo. A short list of paths. |
| `Out of Scope` | no | What deliberately did not change. Prevents over-implementation. |
| `Notes` | no | Anything else. |

Section order is **not** enforced, but the canonical order is the table order above.
Additional `##` sections are allowed and preserved.

`###` subsections inside `Required Actions` are the conventional way to address multiple
targets:

```md
## Required Actions

### mobile

1. ...

### web

1. ...
```

### 2.3 Language

Section headings are **always** the canonical English strings in the table above — they are
the machine contract, matched case-insensitively by every validator and reader.

The prose beneath them may be in any language. Implementations should default to English,
because a handoff is written to cross a team boundary and the receiving team's language is
not knowable from the sending repository. Producing another language should require an
explicit instruction, not inference from the repository's other documents.

### 2.4 Content rules

These are enforced as **warnings**, because a warning that costs nothing is better than a
rejection that loses a document:

- A handoff should be under ~1200 words. Longer means the author dumped instead of decided.
- No fenced code block should exceed 60 lines. Handoffs carry *contracts*, not diffs.
- A fenced block whose content looks like a unified diff (`@@ -` / `diff --git`) is a
  smell — cite paths instead.
- `Required Actions` should contain at least one imperative item.
- Every target in `targets` should be addressed somewhere in `Required Actions`.

### 2.5 Unfinished documents

`<!-- TODO -->` marks a place where a decision is still owed. Tools that scaffold a handoff
write it; the author removes it by making the decision.

A document containing the marker in any section is unfinished, and must say so with
`status: draft`. A document with any other status that still contains the marker claims
to be finished while it is not — that is the one content rule treated as an **error**,
because exporting it would give a teammate a template instead of a handoff.

---

## 3. Conformance

An implementation is **conforming** if it:

- rejects a file whose frontmatter is absent, unparseable, or has `handoff_version != 1`
- rejects a file missing any required field or required section
- rejects `breaking: true` with an empty `Breaking Changes` section
- preserves unknown frontmatter keys and unknown sections on parse → serialize
- treats every rule in 2.4 as a warning only
- rejects a document whose `status` is not `draft` while it contains `<!-- TODO -->` (2.5)

A **round trip** (`parse` then `serialize`) must produce a semantically identical document:
same frontmatter keys and values, same sections, same section content.

---

## 4. Storage layout

Not part of the wire format — a handoff is valid as a bare `.md` file anywhere. This is the
convention Agents Handoff uses on disk:

```
.handoff/
  2026-08-28-auth-refresh-v2/
    HANDOFF.md
  inbox/
    2026-08-20-payments-idempotency/
      HANDOFF.md
```

Outgoing handoffs live at `.handoff/<id>/HANDOFF.md`. Received handoffs live under
`.handoff/inbox/<id>/HANDOFF.md`. The directory name is the `id`. There is no index file —
the directory *is* the index, so it cannot drift.

---

## 5. Non-goals for v1

- No signing, encryption, or authenticity guarantees.
- No transport. A handoff is a file; how it moves is out of scope.
- No acknowledgement or completion protocol. Legacy `delivered` and `acknowledged` values
  remain valid for stored-document compatibility; file export never changes `status`.
- No cross-handoff dependency graph.

---

## 6. Minimal valid document

```md
---
handoff_version: 1
id: 2026-08-28-rate-limit
created_at: 2026-08-28T18:20:00Z
status: ready
breaking: false
source:
  project: backend
targets: [web]
change_type: [api]
---

# Rate limiting on /search

## Summary

`GET /search` now returns `429` with a `Retry-After` header after 30 requests per minute
per user.

## Why This Matters

The web client currently retries failed searches immediately, which will turn a single
rate-limit into a retry storm and lock the user out for longer.

## Changes

Previous: unlimited requests.
New: 30 req/min per user, then `429` with `Retry-After` in seconds.

## Required Actions

1. Handle `429` from `GET /search` distinctly from `5xx`.
2. Respect `Retry-After` instead of the existing fixed 1s backoff.
3. Surface a "slow down" state in the search UI rather than a generic error.

## Instructions for Receiving Agent

Find the existing search request wrapper and add `429` handling there. Do not add a new
HTTP client or a global retry layer — the project already has one.

## Verification

Send 31 searches within a minute and confirm the UI shows the throttled state and does not
retry before `Retry-After` elapses.
```
