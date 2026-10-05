---
handoff_version: 1
id: 2026-07-14-image-upload
title: How image upload works (direct-to-S3, since July)
created_at: 2026-08-28T09:05:00Z
status: ready
breaking: false
generated_by: agents-handoff/0.1.0 (claude-code)
source:
  project: backend
  repo: acme/backend
  branch: main
  commit: c4f0a19
  range: c4f0a19...HEAD
targets:
  - mobile
change_type:
  - api
  - feature
---

# How image upload works (direct-to-S3, since July)

## Summary

Images no longer go through the API. The client asks for a presigned URL, uploads directly
to S3, then tells the API the upload finished. This shipped in July; this handoff exists
because the mobile app has not adopted it yet.

## Why This Matters

The multipart endpoint the app currently uses (`POST /images`) still works but is
deprecated and capped at 8 MB, which is why large photos fail today. It will be removed
after the next release. Adopting the new flow fixes the size limit and the upload timeouts
on slow connections.

## Changes

Three steps replace one.

1. `POST /images/upload-url` with `{ contentType, byteSize }` returns
   `{ uploadUrl, imageId, expiresAt }`. The URL is valid for 15 minutes.
2. `PUT` the raw bytes to `uploadUrl` directly. Set `Content-Type` to the value you
   declared. Do not send an `Authorization` header — S3 rejects the request if you do.
3. `POST /images/{imageId}/complete` to make the image visible. Until this call, the image
   exists but no other endpoint will return it.

Limit is now 50 MB. Accepted types are `image/jpeg`, `image/png`, `image/heic`, and
`image/webp`; `byteSize` and `contentType` are enforced by the presigned policy, so a
mismatch fails at the `PUT` with a `403` from S3 rather than a useful error from us.

## Required Actions

1. Replace the multipart `POST /images` call with the three-step flow above.
2. Send the real byte count in `byteSize`. The presigned policy is signed against it and an
   estimate will fail the upload.
3. Handle the `PUT` failing independently of the API calls. This is the step that breaks on
   a bad connection, and it is safe to retry the `PUT` alone while `expiresAt` is in the
   future.
4. Do not attach the auth header to the S3 `PUT`.
5. If the app is killed between step 2 and step 3, call `complete` on next launch. The
   `imageId` is enough to resume; nothing else needs storing.

## Contracts

```
POST /images/upload-url
  body: { "contentType": string, "byteSize": number }
  200:  { "uploadUrl": string, "imageId": string, "expiresAt": string }
  413:  byteSize above 50 MB
  415:  contentType not accepted

PUT <uploadUrl>            (S3, no Authorization header)
  200 / 204 on success

POST /images/{imageId}/complete
  200:  { "imageId": string, "url": string, "width": number, "height": number }
  409:  the bytes never arrived
```

## Relevant Source

- `src/images/images.controller.ts`
- `src/images/presign.service.ts`
- `src/images/images.module.ts`

## Verification

Upload a 20 MB HEIC photo end to end and confirm it appears in the feed. Then kill the app
between the `PUT` and `complete` and confirm the retry on next launch produces one image,
not two. Finally, upload with the wrong `byteSize` and confirm the failure is surfaced as
an upload error rather than a crash.

## Instructions for Receiving Agent

This is a description of code that already shipped on the backend, not a change you are
coordinating with. Nothing on our side is waiting for you.

Find this app's existing image upload path and replace its body. The retry, progress
reporting, and image picker around it should not need to change — if you are rewriting
those, you have gone too wide.

The step that reliably gets built wrong is the `PUT`: it goes to S3, not to our API, so it
must not use this app's authenticated HTTP client. Use a bare request.

## Out of Scope

Avatars still use `POST /images`. That endpoint is not going away for avatars, only for
feed images.
