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

The siblings need their own `npm ci` too. Node and TypeScript resolve the
symlinked `file:` dependencies by realpath, so `effect` and `@smithers/*` are
looked up in `agent/node_modules` and `flows/node_modules`, not in this
repository's. A checkout that has not installed its siblings fails
`npm run check` with `TS2307: Cannot find module 'effect'`.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) reproduces that layout by
checking out the superproject (`smithersai/monorepo`) with its submodules —
which pins `agent/` and `flows/` to the SHAs the superproject records — then
overlaying the pull request's own tree onto `plugins/`, installing all three,
and running `check`, `lint` and `test`.

Two things must be true on GitHub before it can go green, and neither is
verifiable from a local checkout:

1. The repository needs a `SUBMODULE_CHECKOUT_TOKEN` secret with `contents: read`
   on `smithersai/monorepo` and all four of its submodules. `smithersai/monorepo`
   and `smithersai/agent` are private and the default `GITHUB_TOKEN` is scoped
   to `smithersai/plugins` alone, so it 404s on both.
2. The superproject's recorded submodule SHAs must actually be pushed. As of
   this commit they are not — `agent@4bf838f` and `flows@4e5ca54` are not
   ancestors of their remotes' `main` — so `git submodule update` would fail on
   a runner until the submodules and the superproject pointer are pushed.

The workflow was verified end to end by simulation instead: the three
repositories cloned as siblings into a scratch directory, `npm ci` in each, then
`npm run check && npm run lint && npm test` in `plugins` — all exit 0, 28 test
files / 114 tests, coverage gates enforced. What that simulation does *not*
cover is the two runner-only preconditions above.
