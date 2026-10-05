# Writing good handoffs

A handoff is not documentation. It answers one narrow question:

> You are a different developer, working in a different codebase. What do you have to
> change, and why?

Everything below follows from that.

## Write in the reader's vocabulary, not yours

Your module names mean nothing to them.

| Instead of | Write |
|---|---|
| "Refactored `TokenService` to use rotation" | "Refresh tokens are now single-use" |
| "Added `PermissionGuard` to `MessagesController`" | "`POST /messages` now returns 403 without the `messages:write` scope" |
| "Migrated to the new upload pipeline" | "Images now upload directly to S3 in three steps instead of one" |

The test: could someone who has never seen your repository act on this sentence?

## `Why This Matters` is about consequences, not rationale

Nobody on the other team cares why you chose the design. They care what happens to them.

> ❌ We moved to single-use refresh tokens because reuse detection is a standard mitigation
> for token theft and the security review flagged it.

> ✅ Clients that keep their original refresh token get logged out mid-session the first time
> they refresh after this ships. The failure is delayed and looks random.

## `Required Actions` is the point

Numbered. Imperative. One action each. Addressed to a specific target.

> ❌ The client will need to handle the new token appropriately and make sure storage is
> updated correctly.

> ✅
> 1. Read `refreshToken` from the refresh response and persist it in the keychain.
> 2. Replace the stored token atomically, in the same write as the access token.
> 3. On `refresh_token_reused`, retry once before logging out.

When several targets are involved, split them:

```md
## Required Actions

### mobile

1. …

### devops

No action required. The new variable has a default and is already set in staging.
```

"No action required" is a real and useful answer. Write it when it's true — it saves someone
an hour of looking for work that isn't there.

## `Instructions for Receiving Agent` prevents the expensive failure

You are writing to another coding agent working in a codebase you have never seen. Its most
likely failure is not misunderstanding your change — it's **building a second
implementation of something that already exists on their side**.

So say what *not* to do:

> Find the existing refresh path before writing anything. Modify it. Do not add a second
> token store, a new HTTP client, or a global retry interceptor — if you find yourself
> creating any of those, you have not found the existing implementation yet.

And tell it what to do when reality disagrees with you:

> If the refresh response you find in this codebase does not match the contract above, stop
> and report the difference rather than adapting to it — it means one of us is out of date.

## Confirm breaking changes; don't inherit them

`handoff context` flags **breaking candidates** by pattern matching. It cannot tell a
renamed field from a removed one, or a moved route from a deleted one.

Check each against the code before it reaches the document. `breaking: true` is a claim
about behavior — *a consumer who changes nothing is now wrong or broken* — not about how big
the diff is.

A false breaking flag is expensive twice: it wastes the receiver's time, and it teaches them
to stop trusting the field.

## Write in English unless told otherwise

A handoff exists to cross a team boundary, and you cannot tell the receiving team's
language from the sending repository. English is the default even when the repo's other
docs are in another language — that is a convention you observed, not an instruction you
were given.

If a team genuinely wants something else, they say so once:

```bash
handoff config --set-language Turkish
```

Section headings stay English regardless. They are what `handoff validate` and the
receiving side match on; only the prose underneath changes.

## Cut ruthlessly

Delete anything that is:

- visible in the reader's own code
- background, history, or the story of how you got here
- an implementation detail of your side that doesn't cross the boundary
- said twice in two sections
- **a diff**

Never paste a diff. Cite a path. `handoff validate` warns about both.

Target: under 400 words for an ordinary change, readable in about two minutes. The validator
warns past 1200. If you're near that, you wrote documentation.

## Contracts, when they help

A small literal interface beats three paragraphs describing one:

```
POST /auth/refresh
  body:  { "refreshToken": string }
  200:   { "accessToken": string, "refreshToken": string }
  401:   { "error": "refresh_token_expired" | "refresh_token_reused" }
```

Keep it under 60 lines — past that the validator warns, and it's right to.

## `Verification` should name a scenario

> ❌ Run the tests.

> ✅ Log in, let the access token expire, refresh, refresh a second time, then log out. The
> second refresh is the one that fails if the new token wasn't stored.

The receiver runs *their* tests, not yours. Give them the case that actually distinguishes a
correct implementation from a plausible one.

## `Out of Scope` is cheap and prevents over-implementation

> Login, logout, and access token lifetime are unchanged. Nothing about session storage
> outside the refresh path needs to move.

One sentence. Saves a day of unnecessary work.

## Checklist

- [ ] Could a stranger act on the Summary alone?
- [ ] Does `Why This Matters` describe a consequence, not a rationale?
- [ ] Is every `Required Action` a numbered imperative aimed at a named target?
- [ ] Did you verify `breaking` from the code, not from the candidate list?
- [ ] Does `Instructions for Receiving Agent` say what **not** to build?
- [ ] Does `Verification` name a scenario the receiver can actually run?
- [ ] Under two minutes to read?
- [ ] `handoff validate <id> --strict` clean?
