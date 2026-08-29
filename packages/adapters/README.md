# @smthrs-plugins/adapters

The vendor CLI agents, declared as data.

Smithers 1.0 ships one built-in agent. This package is how a run drives somebody
else's: Claude Code, Codex, Kimi, or Antigravity. Each is a `Spec`: the argv
its binary takes, how to read a line of its JSON output, which of its messages
are quota rather than breakage, and what it can do. One runner spawns them all,
and `AdapterFlows` projects each one as a flow an agent can call.

```ts
import { AdapterRuntime, CliRun } from "@smthrs-plugins/adapters"
import { Effect } from "effect"

const run = Effect.gen(function*() {
  const spec = yield* Effect.fromResult(AdapterRuntime.lookup("claude-code"))
  return yield* CliRun.run(spec, { prompt: "explain this repository" })
})
```

## Why a spec instead of a class

An adapter is four decisions: what to run, how to read what comes back, what the
binary's own failure words mean, and what the binary can do. Written as data,
all four are inspectable without spawning anything (`CliRun.render` returns the
argv a run would use, which is the part worth reviewing before it executes), and
adding a vendor is a new record rather than a new subclass of a runner.

`CliRun` is the only module that starts a process. It renders the command,
spawns it through the kernel's permission-checked `ChildProcessSpawner`, decodes
stdout line by line through the spec's reader, and turns a non-zero exit into
the typed failure the spec's patterns say it is.

## Classification, and why its order matters

`CliClassifier` maps a vendor's own words onto `QuotaExhausted`, `AuthFailed`,
`SessionLost`, `ConfigInvalid`, or `ProtocolError`, because each one has a
different recovery. Two of them point in opposite directions:

- `SessionLost` is repaired by discarding the resume token and retrying **on the
  same seat**.
- `AuthFailed` is only repaired by moving **to another seat**.

Vendors describe a lapsed login in words that name a session. Claude Code prints
`Failed to authenticate: OAuth session expired and could not be refreshed`, so
authentication is matched first. Reading that as a lost session would keep a
pool retrying a dead account forever.

## Capabilities and the doctor

`HarnessCapabilities` records what each binary supports: resume style, MCP
bootstrap, skills install, configuration-directory isolation, native structured
output, steering, images, usage reporting. `Doctor.report` probes the machine
and says, per adapter, ready or why not.

```text
claude-code: ready (poolable)
codex: ready (poolable)
kimi: ready (poolable)
antigravity: unavailable (antigravity --version could not run on the selected host)
```

## Two schemas, not one

A declared output schema is rendered twice, deliberately.
`StructuredOutput.renderSchema` produces what the prompt teaches, the shape the
caller declared. `renderVendorSchema` produces what goes in the file a binary
reads (Codex `--output-schema`, Claude Code `--json-schema`), strictened to
OpenAI's dialect: every object node typed, closed with
`additionalProperties: false`, and every declared property listed in `required`,
because strict mode has no optional properties. Handing the model the strict
copy would make it invent values for fields the caller marked optional; handing
the binary the declared copy gets the file rejected.

## Reaching an adapter from a flow

`CliRun.run` needs a `Spec` and a `ChildProcessSpawner`. A cell holds neither:
its only authority is `ctx.call(flow, input)`. `AdapterFlows` closes that gap by
projecting every shipped spec as a `@smthrs/harness` `FlowBinding` named
`agents.<adapter>`, so a host composes one source and an agent can delegate to
Claude Code or Codex the way it calls any other flow.

```ts
import { AdapterFlows } from "@smthrs-plugins/adapters"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Effect } from "effect"

const catalog = Effect.flatMap(
  AdapterFlows.sourceEffect,
  (source) => FlowBinding.catalog([source])
)
```

A quota refusal, a lapsed login, and a lost session cross as typed
`HarnessError`s rather than as call results, so the controller can move the work
to another seat instead of letting the cell retry a dead account.

## Containment

Nothing in this package supervises the processes it starts. `CliRun` spawns
through `@smthrs/kernel` `ChildProcessSpawner`, and the containment the 0.x
suites `run-command-parent-death`, `run-command-process-group`, and
`parent-death-watchdog-cwd` pinned is owned by the kernel's `ContainedSpawner`
with its `ProcessLedger` and `ProcessReaper` (`packages/platform-node/src/NodeHost.ts`
in the Smithers checkout). Those requirements still hold; they are pinned there,
against the spawner that implements them, rather than duplicated here.

## Seat isolation

Nothing here reads `process.env`. A caller passes the child's whole environment,
because an adapter that inherited the launching process's environment would
inherit its account too. The spec's own entries are applied last, so a seat's
isolation variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) cannot be overridden by
the caller.

## Tests

`vitest run` covers the runner, the classifier, both readers, structured output,
credentials, and the capability registry against recorded vendor transcripts.

`SMITHERS_ADAPTER_SMOKE=1 vitest run test/RealCli.smoke.test.ts` runs Claude Code
and Codex against the binaries installed on the machine, on the seats
`@smthrs-plugins/seat-resolver` `Pool.order` hands back, failing over to the next
rung when one refuses. That joins the two halves the rest of the suite proves
separately: the pool policy and the adapter that runs on its choice. It spends a
real subscription turn, so it is off by default. A machine with no binary, or no
seat that answers, skips with the reason named. It never reports a pass it did
not earn: the all-refused path is a named skip carrying each refusal, not an
assertion about how many seats declined.
