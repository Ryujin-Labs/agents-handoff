---
handoff_version: 1
id: 2026-08-28-auth-refresh-v2
title: Refresh tokens are now single-use
created_at: 2026-08-28T18:20:00Z
status: ready
breaking: true
author: Dana
generated_by: agents-handoff/0.1.0 (claude-code)
source:
  project: backend
  repo: acme/backend
  branch: feature/auth-refresh
  commit: 71ac931
  range: main...HEAD
targets:
  - mobile
  - web
change_type:
  - api
  - authentication
links:
  - label: PR
    url: https://github.com/acme/backend/pull/812
---

# Refresh tokens are now single-use

## Summary

`POST /auth/refresh` now returns a new `refreshToken` alongside the access token, and
invalidates the one you sent. Clients must store the returned refresh token every time.

## Why This Matters

Today both clients keep using the refresh token they got at login. That token stops working
the first time it is used after this ships. The failure is delayed and looks like a random
logout: the current access token keeps working until it expires, then the next refresh
returns `401` and the user is signed out mid-session.

## Changes

`POST /auth/refresh`

Previously the refresh token you sent stayed valid and the response contained only
`accessToken`.

Now every successful refresh returns both tokens and retires the one you sent:

```json
{
  "accessToken": "...",
  "refreshToken": "..."
}
```

Reusing a retired refresh token returns `401` with `{ "error": "refresh_token_reused" }`.
Two refreshes racing on the same token means one of them loses; treat that `401` as "retry
once with the stored token", not as "log the user out".

## Required Actions

### mobile

1. Read `refreshToken` from the refresh response and persist it in the keychain.
2. Replace the stored token atomically, in the same transaction that stores the access
   token, so a crash between the two cannot leave an unusable pair.
3. Serialize refreshes behind the existing single-flight lock in `AuthCoordinator` so two
   screens cannot refresh with the same token.
4. On `refresh_token_reused`, retry once with whatever is now in the keychain before
   logging out. Keep the existing logout behavior for every other `401`.

### web

1. Same contract: persist the returned `refreshToken` on every successful refresh.
2. The service worker and the main thread both refresh today. Route both through one
   refresh call, or they will invalidate each other's tokens.

## Breaking Changes

A client that ignores the returned `refreshToken` keeps its original one. That token is
already retired, so the next refresh fails with `401 refresh_token_reused` and the user is
logged out. Every existing build of both clients does this.

## Contracts

```
POST /auth/refresh
  body:     { "refreshToken": string }
  200:      { "accessToken": string, "refreshToken": string }
  401:      { "error": "refresh_token_expired" | "refresh_token_reused" }
```

Access token lifetime is unchanged at 15 minutes. Refresh token lifetime is unchanged at 30
days; rotation does not reset it.

## Relevant Source

- `src/auth/auth.controller.ts`
- `src/auth/auth.service.ts`
- `src/auth/guards/refresh.guard.ts`

## Verification

Backend rotation tests pass on this branch.

On your side, walk one session through: log in, let the access token expire, refresh,
refresh a second time, then log out. The second refresh is the one that fails if the new
token was not stored. Then confirm two concurrent refreshes do not sign the user out.

## Instructions for Receiving Agent

Find the existing refresh path in this codebase before writing anything — both clients
already have one, along with somewhere tokens are persisted and a lock around refresh.

Modify that path. Do not add a second token store, a new HTTP client, or a global retry
interceptor; if you find yourself creating any of those, you have not found the existing
implementation yet.

The atomicity in step 2 is the part that gets missed. Storing the access token and the
refresh token in two separate writes is the bug this handoff exists to prevent.

If the refresh response you find in this codebase does not match the contract above, stop
and report the difference rather than adapting to it — it means one of us is out of date.

## Out of Scope

Login, logout, and access token lifetime are unchanged. Nothing about session storage
outside the refresh path needs to move.
