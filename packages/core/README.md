# ryujin-handoff-core

Agent-independent core of [Agents Handoff](https://github.com/Ryujin-Labs/agents-handoff):
the `HANDOFF.md` schema, Markdown parsing and serialization, git inspection, context
collectors, validation, storage, and delivery channels.

**No model calls.** Everything here is deterministic and testable. The reasoning — what a
change means to another team, whether it breaks them, what they must do — belongs to the
coding agent that already has the repository in context.

```ts
import {
  loadConfig,
  collectChangeContext,
  renderBrief,
  scaffoldHandoff,
  parseHandoff,
  validateHandoff,
  serializeHandoff,
} from 'ryujin-handoff-core';

const loaded = loadConfig(process.cwd());
const context = collectChangeContext({ cwd: process.cwd(), loaded, targets: ['mobile'] });

console.log(renderBrief(context));                       // what an agent reads
const draft = scaffoldHandoff({ context, targets: ['mobile'] });
const result = validateHandoff(parseHandoff(serializeHandoff(draft)));
```

`composeHandoff` builds a finished document from an agent's prose, with every fact taken
from git — it is what the MCP server's `handoff_write` uses. `analyzeReceived` and
`renderReceiveBrief` are the receiving side.

See [`SPEC.md`](https://github.com/Ryujin-Labs/agents-handoff/blob/main/SPEC.md) for the
format and
[`docs/architecture.md`](https://github.com/Ryujin-Labs/agents-handoff/blob/main/docs/architecture.md)
for the design.

## License

MIT
