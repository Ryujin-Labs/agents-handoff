---
handoff_version: 1
id: 2026-08-28-messages-permission
title: POST /messages now requires the messages:write scope
created_at: 2026-08-28T17:24:00Z
status: ready
breaking: true
generated_by: agents-handoff/0.1.0 (claude-code)
source:
  project: backend
  branch: feature/message-auth
  commit: 8ff8fa2
  range: main...HEAD
targets:
  - mobile
change_type:
  - api
  - authorization
  - database
---

# POST /messages now requires the messages:write scope

## Summary

`POST /messages` is behind a permission guard. A token without the `messages:write` scope
now gets `403`. The success response also renamed `id` to `messageId` and added
`retentionDays`.

## Why This Matters

Existing app builds send a token that has no scopes at all, so every message send will fail
with `403` the moment this deploys. The field rename breaks the send-confirmation screen
independently of that.

## Changes

`POST /messages`

| | before | after |
|---|---|---|
| authorization | any valid token | token must carry `messages:write` |
| success status | `200` | `201` |
| id field | `id` | `messageId` |
| new field | — | `retentionDays: number` |
| failure | `401` only | `403 { "error": "forbidden" }` when the scope is missing |

Messages are now deleted after `retentionDays` (30 by default). The value is per-workspace
and comes back on every send, so read it rather than hardcoding 30.

## Required Actions

1. Request the `messages:write` scope at login. Tokens issued before this ships do not
   carry it, so existing sessions need a token refresh before they can send.
2. Rename `id` to `messageId` where the send response is decoded.
3. Handle `403` on send distinctly from `401`: `401` means re-authenticate, `403` means
   this account is not allowed to post here. Do not sign the user out on `403`.
4. Read `retentionDays` from the response and use it for the disappearing-message hint
   instead of the hardcoded 30.
5. Accept `201` as success. The current code checks for `200` exactly.

## Breaking Changes

Any build that does not request the new scope loses the ability to send messages entirely —
not degraded, blocked. Because existing tokens lack the scope, a client also needs to force
a token refresh on first launch after this ships, or previously-signed-in users stay broken
until their token expires on its own.

## Contracts

```
POST /messages
  auth:  Bearer token with scope "messages:write"
  201:   { "messageId": string, "retentionDays": number }
  401:   token invalid or expired
  403:   { "error": "forbidden" }   scope missing
```

## Relevant Source

- `src/routes/messages.ts`
- `src/auth/require-permission.ts`
- `types/message.ts`
- `migrations/002_add_retention.sql`

## Verification

Exercise, in order: send with a scoped token (expect `201`), send with an unscoped token
(expect `403`, and confirm the user is not signed out), and confirm the confirmation screen
still shows the message id after the rename.

## Instructions for Receiving Agent

The scope request belongs wherever this app already builds its auth request — find that
first. There is one place tokens are requested; do not add a second.

The `id` to `messageId` rename will have more call sites than the send function itself.
Search for every use of the send response before editing, including tests and any local
cache or database schema that stores the id.

`retentionDays` is per-workspace. If you find a constant `30` anywhere near message expiry,
that is the thing to replace.

If this codebase turns out not to call `POST /messages` at all, say so and stop rather than
looking for something to change.
