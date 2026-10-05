# Examples

Three complete, valid handoffs. All three pass `handoff validate --strict` with zero
warnings, and `packages/core/test/examples.test.ts` enforces that on every run.

| | What it demonstrates |
|---|---|
| [`auth-refresh-v2/`](auth-refresh-v2/HANDOFF.md) | A breaking API change with **two targets**, each getting different `Required Actions`. Shows a `Contracts` block and an `Out of Scope` section. |
| [`messages-permission/`](messages-permission/HANDOFF.md) | A **single-target** authorization change: new scope, renamed field, new status code, plus a migration. Uses a before/after table. |
| [`image-upload-historical/`](image-upload-historical/HANDOFF.md) | A **historical** handoff — describing something that shipped weeks ago so another team can finally adopt it. `breaking: false`, but urgent anyway. |

Try one:

```bash
handoff validate examples/auth-refresh-v2/HANDOFF.md --strict
handoff receive examples/auth-refresh-v2/HANDOFF.md --as mobile --no-store
handoff receive examples/auth-refresh-v2/HANDOFF.md --as web --no-store
handoff receive examples/auth-refresh-v2/HANDOFF.md --as devops --no-store
```

The last three show the same document narrowed three different ways: mobile's actions,
web's actions, and a clear "this does not concern you".

See [`../docs/writing-good-handoffs.md`](../docs/writing-good-handoffs.md) for why these
are written the way they are.
