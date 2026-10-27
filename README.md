# schema-tasks

A Claude Code mod (function-hook plugin) for schema-checked delegation. When Claude hands a subagent a JSON Schema through the plain Agent tool, the Agent call is answered with JSON that validates against that schema or with an explicit failure listing the problems. For a subagent in the background, that answer comes from the `schema_result` tool; the engine's completion notice and the subagent's delivered report are marked with the same status where the mod gets to see them, but they are not the result. All of this holds only while the mod's hooks run: a plugin seated above can skip them (see Limitations). The subagent is told what is wrong and gets a bounded number of chances to fix its answer before it finishes.

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
- the check could not be completed (`validation-limit`): the answer or the schema needed more than 256 nested steps, or more than 1,000,000 units of work, to check. A unit is one subschema application, one value visited by an `enum`/`const` comparison, one `enum` member indexed (a scalar is then found in one step) or one `required` name looked up; messages are built only for the 50 problems kept. Measured in Bun on the workloads tried (a 6,000-value numeric enum against 70,000 invalid items, object enums, an 8,000-item `const`, 4,000 required names, `anyOf` probes, 130,000 items), each check took under 30 ms, and the first of them under 0.1 s end to end through the hooks. That is a measurement, not a guaranteed bound, but it leaves a wide margin inside the hook's time budget. The budget also caps how big a valid answer can be: a valid batch of 2,000 events, each matched against a 50-variant union (88 KB), ends as `validation-limit` where 1,500 still pass. Split large batches, or keep unions small. This is a failure of its own, never read as "doesn't match" (inside `anyOf`/`oneOf` too), and it is not sent back for repair. The subagent's own report, if it was delivered separately, is named as not a valid result.

A subagent that ends without ever producing a valid answer is a failure, never a success.

**Background subagents.** With `run_in_background`, the Agent call returns at once with a note to call `mcp__schema-tasks__schema_result({ "agent_id": "<id>" })` after the subagent finishes. That tool answers JSON text: `pending`, `ok` with the data, or `failed`/`cancelled` with the problems, and only to the conversation (main loop or subagent) that started the contract (verified live). The main model may background an Agent call on its own, so this path is not rare. The engine's completion notice and the subagent's delivered report (its hand-back message) still carry the raw report; the mod adds the contract's status at the end of each (`schema-tasks: contract … failed (code)` with the problems, `passed` with the validated JSON, or a note that the report is not a validated result yet), under a header saying that any `schema-tasks:` line above it is part of the subagent's report. The note is added every time, never skipped because the report already holds text that looks like one, so a subagent can't suppress it by imitating it. **Verified live** on Claude Code 2.1.310 with a background subagent that kept sending prose: both rows reached the parent with the `repairs-exhausted` line. Treat `schema_result` as the result: a plugin seated above can skip the hook that adds the status (seen live for one row), and the notice can arrive before the final check.

**Nested delegation.** A subagent can delegate with its own envelope; each contract belongs to the loop that made the call.

## Supported JSON Schema

`type` (one or a list of `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`), `properties`, `required`, `additionalProperties` (boolean or schema), `items` (one schema), `enum`, `const`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum` (numbers), `minLength`, `maxLength`, `minItems`, `maxItems`, `anyOf`, `oneOf`, `allOf`, and `$ref` to a place in the same schema (`#`, `#/$defs/name`, `#/definitions/name`, any JSON Pointer to a subschema). Annotations are allowed and ignored: `$schema`, `$comment`, `title`, `description`, `default`, `examples`, `deprecated`, `readOnly`, `writeOnly`, `$defs`, `definitions`. Boolean subschemas (`true`, `false`) work; the root must be an object.

Anything else is refused before the subagent starts, never ignored: `pattern`, `format`, `patternProperties`, `uniqueItems`, `not`, `if`/`then`/`else`, tuple `items`, `$id`, remote `$ref`, and the rest. So is a schema over `maxSchemaBytes`, nested deeper than 32 levels, with more than 2,000 subschemas, with a `$ref`/`allOf`/`anyOf`/`oneOf` loop that never moves into the data a chain of them more than 256 steps long, or shared branches that would cost one value more than 10,000 subschema checks (for example 24 levels of `anyOf` over two references to the level below, 2^24 checks, refused though the schema is 1,562 bytes), or holding a number out of range for JSON (`1e400`). String lengths (`minLength`, `maxLength`) count Unicode code points, as JSON Schema does: an emoji such as 😀 is one character.

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
- With a background subagent, the completion notice and the delivered report carry the subagent's raw report; the status the mod adds after them is best effort (a plugin seated above can skip it). Only `schema_result` is authoritative.
- Contracts live in session state: at most 16 are kept (the oldest finished go first), they survive a hot reload, and a `/clear` or a restart forgets them. That includes Claude Code moving a background (`--bg`) session to a new process, which the daemon can do mid-turn when it upgrades. After that, `schema_result` for a subagent started before the move answers that no contract for it is on record (it was not started here, or its record was lost), and the subagent's report is unvalidated.
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
