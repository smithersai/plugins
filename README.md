# Smithers Plugins

Smithers Plugins packages vendor adapters and projections for the Smithers
ecosystem. It currently contains `@flows/adapters`, which provides declarative
Claude Code and Codex CLI adapters plus Skills and MCP projections.

## Development

Keep this repository beside `smithers-agent` and `smithers-flows`:

```text
parent/
  smithers-agent/
  smithers-flows/
  smithers-plugins/
```

`@flows/adapters` links its agent-layer dependencies from `smithers-agent` and
its durable flows-layer dependencies from `smithers-flows`. The links use
relative symlink indirection so the `packages/*` workspace glob does not absorb
either sibling repository.

```sh
npm install
npm run check
```
