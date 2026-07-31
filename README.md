# Smithers Plugins

Smithers Plugins packages vendor adapters and projections for the Smithers
ecosystem.

- `@smithers/adapters` — declarative Claude Code and Codex CLI adapters plus Skills
  and MCP projections.
- `@smithers/host-cloudflare` — Cloudflare Workers `Host` and Durable Object
  database adapters.
- `@smithers/host-vercel` — Vercel Edge and Node `Host` layers plus Blob store
  bindings.

Platform host adapters live here rather than in the engine repository: they are
vendor integrations, not part of the closed `flows` workspace dependency set.
Their docs are under [`docs/`](docs/).

## Development

Keep this repository beside `agent` and `flows`:

```text
parent/
  agent/
  flows/
  plugins/
```

Each package links its agent-layer dependencies from `agent` and its durable
flows-layer dependencies from `flows`. The links use
relative symlink indirection so the `packages/*` workspace glob does not absorb
either sibling repository.

```sh
npm install
npm run check
```
