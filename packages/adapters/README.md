# @flows/adapters

`@flows/adapters` provides declarative adapters for foreign CLI harnesses and
the projections that make flows available inside those harnesses.

## Declarative CLI harnesses

The central contract is `CliHarness.Spec`. An adapter is data: a typed
capabilities record, a pure `buildCommand`, an output interpreter, classifiers,
and prompt fragments. `CliHarness.make(spec)` supplies the shared lifecycle,
preflight, spawning, cleanup, retry, and suspension behavior. There is no
inheritance hierarchy and no vendor conditionals in shared code; behavior is
selected by declared capabilities and by the spec itself.

The initial CLI adapters are:

- `ClaudeCode` for Claude Code's stream-json CLI protocol and isolated config.
- `Codex` for Codex's structured execution and resume command forms.

Both normalize vendor output into the common harness events and classify
quota, authentication, configuration, protocol, and session failures at the
adapter boundary.

## Reverse projections

`FlowsAsSkills` renders visible flow descriptors as deterministic `SKILL.md`
trees. Its scoped `mount` operation returns `CliHarness.MakeOptions` for a
Claude plugin directory or isolated Codex home. `FlowsAsMcp` renders the same
selected registry entries as MCP tools and bootstrap configuration. Its handler
receives an injected `ChildRunInvoker`; an invocation re-enters durable
execution as a child run rather than executing a flow body directly in the
projection process.

See the [package reference](../../docs/reference/adapters.md) for the complete
module and error surface.

## Specifications and research

- [Agent Adapters](../../docs/specs/Concepts/Agent%20Adapters.md)
- [Wrapping Adapters](../../docs/specs/Concepts/Wrapping%20Adapters.md)
- [System Prompt](../../docs/specs/Concepts/System%20Prompt.md)
- [Agent Ecosystem Plan](../../docs/specs/Research/Agent%20Ecosystem%20Plan%202026-07-28.md)
- [Pi Core Sweep](../../docs/specs/Research/Pi%20Core%20Sweep%202026-07-28.md)
- [Opencode Core Sweep](../../docs/specs/Research/Opencode%20Core%20Sweep%202026-07-28.md)
- [Smithers Agents Sweep](../../docs/specs/Research/Smithers%20Agents%20Sweep%202026-07-28.md)
