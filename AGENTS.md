# schema-tasks

A Claude Code mod (function-hook plugin): schema-checked delegation through the plain Agent tool. `README.md` is the user-facing spec; keep it in step with any behavior change in the same commit.

## Layout

- `hooks/schema.ts`: the JSON Schema subset. `checkSchema` refuses a schema before any child starts (unsupported keyword, bad keyword value, unresolved or non-local `$ref`, a `$ref`/`allOf`/`anyOf`/`oneOf` cycle that consumes no data, too many bytes, nodes or levels); `validate` collects every issue with a JSON Pointer path. Pure, no `eval`, no `RegExp` built from schema text.
- `hooks/policy.ts`: everything else that is pure: the envelope parser, the child prompt, the strict reply parser, feedback text, the contract state machine (`transition(contracts, event) → { contracts, action }`), command parsing and status text. Unit-tested in `policy.test.ts` and `schema.test.ts`.
- `hooks/register.ts`: wiring only. Each hook turns its engine event into one state-machine event, applies it in one versioned `update`, and does what the returned action says.
- `types/index.d.ts`: `Contract`, `Phase`, `Issue`, `Config`, `Session` and the `$.state` contract (`PluginState['schema-tasks']`: `session`, `contracts`).
- `.claude-plugin/plugin.json`: manifest and the `userConfig` options (`enabled`, `maxRepairs`, `maxSchemaBytes`, `maxResultBytes`).

## How a contract runs

A contract is one Agent tool call whose prompt is a schema-tasks envelope. Its id is that call's `tool_use_id`. Every contract lives in the `contracts` atom (a list of at most 16; the oldest finished ones are dropped first) and moves through `starting → running → valid | failed | cancelled`. Finished phases are final: a late event never changes them.

1. **`tool.call` Agent, before `next`** (main loop or a subagent): a prompt that starts with `{` and names `"claudeSchemaTasks"` is an envelope. A malformed envelope, an unsupported schema, `isolation: "remote"`, or the mod being off answers `{ deny }`: nothing runs unstructured. A good one opens a `starting` contract that records the caller's loop (`parentAgentId`, `null` for main) and freezes the limits.
2. **`agent.spawn`**: the spawn whose `tool_use_id` and `parentAgentId` match a `starting` contract gets its prompt rewritten (task, schema, "finish with exactly one JSON value"). Teammates, forks, workflow agents and resumes are refused for a contract. The `agentId` that `next` resolves binds the child (`running`).
3. **Repair gates** (whichever fires for this child; decided per child from the events that arrive, never configured):
   - the child's `SubagentHandback` `tool.call`, where the setup has children report through that tool: an invalid `message` is answered `{ deny: feedback }`, which re-prompts the child;
   - `classic.SubagentStop`, where it fires: an invalid `last_assistant_message` is answered `{ block: feedback }`.
   Both spend the same persisted `repairsUsed`. When it reaches `maxRepairs` the next invalid reply marks the contract `failed` and the child is let go (never `preventContinuation`). A gate pass is recorded, not final.
4. **`turn.complete` for the child**: the independent final check. `answer` (the delivered report) must parse and validate; that sets `valid` with the data, else `failed`. `aborted` is `cancelled`; `refusal` and `error` are `failed`. A child that never passed a gate is judged here, so ending without a valid answer is a failure, never a success.
5. **`tool.call` Agent, after `next`**: a `valid` contract returns the native record unchanged plus one `context` line holding the validated JSON; `failed`/`cancelled` answers `{ deny }` with the code and issues. If `turn.complete` has not been seen, the result's own text is validated in its place (a hand-back pointer fails closed). `async_launched` returns the record plus a context line naming `schema_result`.
6. **`schema_result({ agent_id })`** (`mcp__schema-tasks__schema_result`, deferred behind ToolSearch): answers `pending`, `ok` with data, or `failed`/`cancelled` with issues, only to the loop that opened the contract.

## Design invariants of this mod

- Ordinary Agent prompts pass untouched: no state is written and no text added for them.
- Never success-shaped prose: the parent gets validated JSON in `context`, or a deny. Data comes only from a check of the delivered answer (or the result's text), never from a gate's candidate alone and never past a withheld or flagged hand-back.
- Every state change is one `transition` applied in one `update`; actions are read from the run that landed. Hooks decide from the contract's phase at that moment, not from module variables.
- The teaching text is fixed: one paragraph appended to the Agent tool's description by `tool.describe` at session start, the same every turn (prompt cache safe). Nothing else changes the system prompt or tool list.
- Guards fail closed for envelopes (a throwing pre-check denies the call) and open for everything else (an ordinary Agent call is never blocked by a fault in this mod).
- `/schema-tasks off` refuses new envelopes and makes every gate let its child go, marking open contracts `failed` with code `disabled`.

## Live findings (Claude Code 2.1.310)

- A managed plugin seated above (prepend tier) can send `classic.*` events on past this mod; on the machine this was built on `classic.SubagentStop` never reached it. The SubagentStop gate is therefore covered by the test kit only; the hand-back gate and `turn.complete` were verified live.
- Where children report through `SubagentHandback`, the Agent tool's result is only a pointer and the report reaches the parent as a separate message. Denying the hand-back call re-prompts the child each time (checked with two denials in a row). `turn.complete`'s `answer` is the delivered report.
- A `$.tool.register` tool's `{ result }` must be a string or a content-block list: an object was refused live ("does not match its output shape") although the test kit accepted it. `schema_result` answers JSON text.
- The main model may launch an Agent call in the background on its own (`async_launched`) even when the prompt didn't ask for it, so the `schema_result` path is not rare.

## Commands

```sh
scripts/check.sh            # claude plugin validate . && claude plugin test . && typecheck
scripts/check.sh --no-tsc   # when TypeScript isn't available
```

All gates must pass before every commit. A behavior change needs a test in `hooks/*.test.ts` (the `claude-code/testing` kit: `mock.clock`, `mock.store`, `mock.env`, and `on(...)` hooks that stand for the engine beneath the plugin) written first and seen failing for the intended reason, then the change that makes it pass.

To try the mod in a live session: `claude --plugin-dir .` (interactive sessions hot-reload on save), or `claude -p --plugin-dir . "<prompt>"` for a headless run (always loads fresh; hooks that need a terminal won't fire). `claude --debug` logs every skipped hook and refused result.

## API reference

The API is early access and changes between releases; the declarations are the authority, not memory. Grep them by name (`'turn.step'`, `export type ToolCallResult`):

- after the engine has loaded this folder: `.claude-plugin/types/claude-code/index.d.ts`;
- otherwise the newest `claude-code.d.ts` the `plugin-authoring` skill writes under the temp dir (`scripts/check.sh` finds it), plus that skill's `reference.md` and `examples/`.

## Design invariants (apply to every mod built from this template)

- **Main conversation vs subagents.** Events from a subagent's loop carry `e.agentId` (`agent_id` on `classic.*` events). Decide explicitly whether the mod acts on subagents; by default return `next(e)` early for them.
- **Hot reloads reset module variables** (timers included). `register` and `session.start` run again; `$.state` and `$.store` survive. Anything that must persist goes in state or store. Change an atom's `shape` tag when its stored type changes.
- **Never throw out of a hook or timer for reporting.** Logging, status and toasts are best effort. A hook that guards (denies a tool call, drops a prompt) gets a `.catch` that decides fail-open or fail-closed deliberately (`next.called ? next(e) : { deny }`).
- **Headless sessions** (`e.isInteractive === false`, `claude -p`) have no terminal: no panes, `$.ui.notify` fails, `$.session.compact` rejects. Skip or degrade explicitly.
- **Cost and the prompt cache.** Anything that calls a model (`$.model.complete`, `classify`, `fork`, `$.agent.spawn`) is billed to the person. Say what it costs in the README, bound it with options, and don't change the system prompt or tool list per turn (that rewrites the whole prompt cache).

### Engine constraints found the hard way (Claude Code 2.1.29x–2.1.310)

- `$.prompt.submit` is refused from inside a `command.run` hook (it would wait on the turn the hook holds). Submit from a `$.clock.after(0, …)` timer.
- `$.session.compact` rejects while a turn runs and in headless sessions.
- A plugin's submitted prompt never expands `@` mentions; `$.prompt.fill` lets the person send it instead.
- `$.model.fork` replays the main thread's last request, which ends before the turn's final answer: quote the answer into the fork prompt if the fork needs it.
- The engine already prefixes `$.ui.status`, `$.ui.toast` and command output with the plugin name; don't add `schema-tasks:` there. `$.ui.log` lines keep the prefix.
- A model `Write` outside the project raises a permission prompt; have the plugin write its own files with `$.fs.write` (it creates directories). `$.fs.write` replaces the whole file; there is no append.
- `turn.step` hooks are async generators in the path of every request: always pass the stream through (`yield* next({ ...e, effort })`). A rewritten `model` must be a full id (`claude-haiku-5-5`); an alias failed with `unrecognized_model`. Changing `effort` per request keeps the prompt cache (Opus, Sonnet, Haiku 5.5); changing `model` rereads everything uncached. The UI keeps showing the session's model and effort, so surface a rewrite with `$.ui.status`.
- `tool.call`: `const r = await next(e); return { ...r, context: [text] }` adds text the model reads after the tool result and the person never sees; `{ deny: reason }` blocks the call. A `tool.call` hook without `.catch` is reported by validate as a gate: give it one that fails open or closed on purpose.
- Haiku 5.5 rejects `temperature`/`top_p`/`top_k`, `budget_tokens` and assistant prefill with a 400. Prices step up 5x above 100K prompt tokens.
- Side calls (forks, completions, subagents, compaction) use the "everything else" prompt-cache bucket (5m on a subscription), not the main conversation's 1h one. Cache reads still count against plan usage.
- Text a hook injects for the model must not talk about the model's thinking or reasoning ("you can't see it", "doesn't count"): Opus 5.5's reasoning-extraction safeguard refused such a request. Phrase it in terms of the reply and the work.
- Don't build on instructions the model can ignore: a gate that "asks" the model to do something first failed live. Enforce in a hook, or give the model the information and let it decide.
- `/clear` is `session.end` with `reason: 'clear'` and no `session.start` after it: reset per-conversation state there. After a `/clear`, `$.state` reads empty (version 0) for the new session, while module variables survive: anything that must cross a `/clear` (a "not sent" list, an epoch) has to be carried in a module variable from `session.end` and merged into state on first access (lost if the plugin reloads in between).
- **Hook-owned time has a budget (about 10 s).** Time spent in a `$` call or `next` doesn't count; time awaiting the mod's own promises (a local queue, a semaphore, a timer) does, and the engine refuses the dispatch when it runs out. Never make a hook wait on local state: keep one of the hook's own `$` calls in flight, or move the work to a timer.
- **`$.state.get` can return a stale snapshot** within a dispatch (seen live: a plain read returned this module's earlier write after another hook's later one). To check ownership right before a side effect, use a versioned `update` that writes the same value back; it retries on a version miss. It's a freshness check, not a lock: re-check after every `await` and immediately before each `$.prompt.submit`, `$.turn.abort` or `$.session.append`.
- **Design async ownership as one state machine** (a pure `transition(state, event) → { state, actions }`, every event applied in one `update`) once a mod has corrections, holds or releases that can race newer input, `/clear`, off switches or reloads. Patching individual checks kept failing review; the state machine passed.
- `turn.start` and `turn.complete` fire for subagents too (`e.agentId` set) on 2.1.310. Track the main turn by id and consume its completion once.
- A plugin seated above yours (a managed plugin, prepend tier) can pass an event on past your hook: `prompt.context`, `prompt.attachment`, classic hooks and some `session.append` rows were skipped this way live. Don't build a guarantee on a hook firing; document it.
- `session.append` can't rewrite attachments rendered per request (`@file` content); `prompt.attachment` is the hook that can. The raw attachment payload still persists in the transcript.
- On 2.1.310 a `prompt.submit` answered `{ drop }` leaves the typed text in the prompt box. Clearing it by reading the box and replacing it races the person's typing: never replace the whole box from an earlier read.
- `$.prompt.fill` is refused while a focused pane holds the keys: close the pane first. Button hotkeys fire even while a text field is drawn, and a Button and an Input sharing a `key` sends focus to the Button.
- `$.fs.read` refuses files over 4 MiB (transcripts pass 50 MB); `$.process.spawn` of `tail -c +N` reads incrementally.
- The hooks sandbox treats `__proto__` as an ordinary own key: use `Object.hasOwn` (or a `Map`) for every lookup keyed by user text (rule names, schema properties).
- `$.model.classify` takes only labels: no rubric, timeout, effort or usage. `$.model.complete` with a rubric and `timeoutMs` worked better for judges. Haiku replies have exceeded `maxTokens`; don't promise an output bound.
- Parallel cold requests each write the prompt cache; send one request first when many share a long cached block.

### Bugs that recur in these mods (check every change against them)

Reviews of relay, defer-queue and prewalk kept finding the same family: a boolean flag left stale by a late event (track the running `turnId` instead), a message lost on a path nobody tested (a refused submit, a release racing a new hold), a timer or async step acting for a run that was cancelled or replaced (guard with a `runId` and re-check after every `await`), state that survived `/clear` or a reload when it shouldn't (or didn't when it should), and engine state copied into the mod's own flags (decide from facts at decision time). Two review rounds of blockers in the same mechanism means change the mechanism.

### Test kit notes

- A hook that answers an op on `$` (`command.register`, `fs.read`, `model.complete`, `ui.toast`, `session.messages`) returns `{ value }` or `{ deny }`; a hook that answers an event (`session.start`, `turn.start`, `turn.complete`) returns the event's result directly.
- One bottom hook per event per test file (a second registration errors). Test files with JSX are `.test.tsx`.
- Use `mock.clock(on)` and `clock.advance`/`settle` for time; there is no `setTimeout`.
- A throwing mock hook is skipped rather than surfacing its error, so test decisions that depend on an error's text as pure functions in `policy.ts`.
- Any helper that receives `$` must be a top-level function: the engine's static check refuses a module that passes `$` to a closure defined inside `register`. `atom({ plugin, key })` takes string literals, not a const.
- The kit accepted a wrong tool-input shape at runtime that `tsc` caught: run the typecheck.

### Live checks

The test kit stands in for the engine; it can't show what the engine really does. Before building on an engine behavior the types don't state, probe it: a throwaway observer mod (`--plugin-dir`) that logs events with `$.fs.write`, and one short live session, with `--model haiku` to keep it cheap. Record the Claude Code version a behavior was checked on. Headless runs (`claude -p`) create transcript folders under `~/.claude/projects/`; run them from a scratch directory.

## Conventions

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).
- Bump `version` in `plugin.json` for every release users should get. Installs from GitHub run a copy, and `claude plugin update` only replaces it when the version changes. An install whose marketplace is a local clone runs from the clone itself: edit, then `/reload-plugins`.
- MIT licensed: `LICENSE` at the root, and `plugin.json` says `MIT`. Treat the repo as public: no secrets, tokens, session IDs, personal paths or employer-specific details in code, tests, docs or commit messages.
- Don't add Claude or AI attribution trailers to commits.
