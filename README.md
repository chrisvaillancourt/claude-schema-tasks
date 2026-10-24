# schema-tasks

A Claude Code mod (function-hook plugin) for schema-checked delegation. When Claude hands a subagent a JSON Schema through the plain Agent tool, it gets back either JSON that validates against that schema or an explicit failure with the problems listed, never prose that only looks like a result. The subagent is told what is wrong and gets a bounded number of chances to fix its answer before it finishes.

Claude Code's Workflow tool already checks a `schema` per agent. This mod covers the Agent tool, from the main conversation and from subagents, and leaves Workflow alone.

## Behavior

**Opting in.** Delegation is structured only when the Agent call's whole `prompt` is an envelope:

```json
{
  "claudeSchemaTasks": 1,
  "schema": {
    "type": "object",
    "properties": { "verdict": { "enum": ["pass", "fail"] } },
    "required": ["verdict"],
    "additionalProperties": false
  },
  "task": "Inspect the implementation and report a verdict."
}
```

`description`, `subagent_type`, `model`, `run_in_background` and the other Agent parameters work as usual. Every other Agent prompt passes through untouched. The mod tells Claude about the envelope with one fixed paragraph added to the Agent tool's description (817 characters, about 200 tokens, sent with the tool list and cached with it).

**Before the subagent starts.** A prompt that starts with `{` and names `"claudeSchemaTasks"` but is malformed (bad JSON, missing `task`, an unknown key, a wrong version), a schema that uses anything outside the supported subset, a schema over the size limits, `isolation: "remote"`, a teammate, a fork, or the mod being off: each refuses the Agent call with the reason. Nothing runs unstructured.

**While it runs.** The subagent's prompt is rewritten to hold the task, the schema and the instruction to finish with exactly one JSON value (no code fences, no text around it). Its reply is checked strictly: the whole reply, trimmed, must parse as one JSON value and validate. A number JSON parsing can't hold (such as `1e400`, which would read as Infinity and be stored as `null`) makes the reply invalid wherever it appears, and the data handed back is checked to be exactly what was validated. A reply that fails is sent back with every problem and its JSON Pointer path (at most 20 listed), up to `maxRepairs` times. The check happens at whichever point the setup gives the mod, chosen per subagent from what actually happens:

- where subagents report through a hand-back tool (`SubagentHandback`), that call is refused with the problems and the subagent tries again. **Verified live** on Claude Code 2.1.310: three refusals with path feedback, then the fourth invalid report let through and the parent given a `repairs-exhausted` failure.
- otherwise at the subagent's stop (`SubagentStop`), which is blocked with the problems. **Covered by the test kit only**: on the machine this was built on, a managed plugin seated above (prepend tier) sends that event on before this mod sees it.

**When it ends.** The answer the subagent delivered is checked again on its own, whatever happened before (verified live, as is the parent's note or failure below). Then:

- valid: the Agent result is returned as usual, plus a note to Claude holding the validated JSON;
- invalid after the last repair, interrupted, refused or errored: the Agent call is answered with an explicit failure (code and problems).
- the check could not be completed (`validation-limit`): the answer or the schema needed more than 256 nested steps to check. This is a failure of its own, never read as "doesn't match" (inside `anyOf`/`oneOf` too), and it is not sent back for repair. The subagent's own report, if it was delivered separately, is named as not a valid result.

A subagent that ends without ever producing a valid answer is a failure, never a success.

**Background subagents.** With `run_in_background`, the Agent call returns at once with a note to call `mcp__schema-tasks__schema_result({ "agent_id": "<id>" })` after the subagent finishes. That tool answers JSON text: `pending`, `ok` with the data, or `failed`/`cancelled` with the problems, and only to the conversation (main loop or subagent) that started the contract (verified live). The main model may background an Agent call on its own, so this path is not rare. The engine's own completion notice still carries the raw report: treat `schema_result` as the result.

**Nested delegation.** A subagent can delegate with its own envelope; each contract belongs to the loop that made the call.

## Supported JSON Schema

`type` (one or a list of `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`), `properties`, `required`, `additionalProperties` (boolean or schema), `items` (one schema), `enum`, `const`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum` (numbers), `minLength`, `maxLength`, `minItems`, `maxItems`, `anyOf`, `oneOf`, `allOf`, and `$ref` to a place in the same schema (`#`, `#/$defs/name`, `#/definitions/name`, any JSON Pointer to a subschema). Annotations are allowed and ignored: `$schema`, `$comment`, `title`, `description`, `default`, `examples`, `deprecated`, `readOnly`, `writeOnly`, `$defs`, `definitions`. Boolean subschemas (`true`, `false`) work; the root must be an object.

Anything else is refused before the subagent starts, never ignored: `pattern`, `format`, `patternProperties`, `uniqueItems`, `not`, `if`/`then`/`else`, tuple `items`, `$id`, remote `$ref`, and the rest. So is a schema over `maxSchemaBytes`, nested deeper than 32 levels, with more than 2,000 subschemas, with a `$ref`/`allOf`/`anyOf`/`oneOf` loop that never moves into the data or a chain of them more than 256 steps long, or holding a number out of range for JSON (`1e400`). String lengths count UTF-16 code units, as JavaScript does.

## Command

`/schema-tasks [on|off|status|show <id>]`

- `status` (the default): whether the mod is on, and the last contracts with their phase (`starting`, `running`, `valid`, `failed`, `cancelled`), repairs used and agent id.
- `show <id>`: one contract by its id (the Agent call's `tool_use_id`) or its agent id, with the problems from its last check.
- `on` / `off`: set the mod for this session. Off refuses new envelopes and lets every running structured subagent finish, marking its contract `failed` (`disabled`).

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Turn the mod on for new sessions. `/schema-tasks on\|off` overrides it per session. |
| `maxRepairs` | `3` | How many times an invalid reply is sent back (0 to 5). |
| `maxSchemaBytes` | `32768` | Largest schema accepted, as JSON text. |
| `maxResultBytes` | `262144` | Largest reply accepted, in UTF-8 bytes; a longer one is invalid. |

## What it costs

The mod makes no model calls of its own. Its costs are:

- the teaching paragraph in the Agent tool description, about 200 tokens per request, cached with the tool list; it is added once per session and never changes;
- the schema in each structured subagent's prompt;
- each repair is one more subagent request (its context plus the problem list), so at most `maxRepairs` extra requests per contract; the subagent's own work is not capped by the mod;
- the validated JSON appears once more in the parent's context, after the Agent result.

## Limitations

- Final-answer JSON only: no streamed or section-by-section results, no `error` channel for the subagent. A task that can fail should say so in its schema (for example `anyOf` with an error shape).
- No `pattern` or `format`, no JSON Type Definition, no schema inheritance from agent definitions.
- The `SubagentStop` gate is not verified live (see above). Where neither gate fires, the final check still holds: an invalid answer is a failure, but the subagent gets no chance to repair it.
- The child is bound by the `agentId` its spawn resolves. If a gate event ever arrived before that binding, the gate would pass it by; the final check then fails closed.
- With a background subagent, the engine's completion notice carries the subagent's raw report, which this mod cannot mark; only `schema_result` says whether it validated.
- Contracts live in session state: at most 16 are kept (the oldest finished go first), they survive a hot reload, and a `/clear` or a restart forgets them.
- The teaching paragraph is in every agent's Agent description, and `schema_result` is listed for subagents too; a subagent has been seen calling it by mistake (it answers with an error and does no harm).
- A plugin seated above this one can skip any of its hooks. A skipped pre-check means an envelope runs as an ordinary prompt with no contract; the mod cannot detect that.

## Install

```sh
claude plugin marketplace add chrisvaillancourt/claude-schema-tasks
claude plugin install schema-tasks@schema-tasks --scope user
```

Or from inside Claude Code: `/plugin install schema-tasks --marketplace chrisvaillancourt/claude-schema-tasks`.

To work on it locally, add your clone as the marketplace instead (`claude plugin marketplace add <path to clone>`). The plugin is read from that folder; after editing, run `/reload-plugins`.

## Update

```sh
claude plugin marketplace update schema-tasks
claude plugin update schema-tasks@schema-tasks
```

Then restart Claude Code.

## Develop

```sh
scripts/check.sh
```

It runs `claude plugin validate .`, `claude plugin test .` and a TypeScript check. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

MIT. See [LICENSE](LICENSE).
