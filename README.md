# Smithers Plugins

Vendor agent adapters, provider seats, and deployment hosts for Smithers. Every
package here builds against `@smthrs/*` `1.0.0-rc.0` and Effect
`4.0.0-rc.108`; nothing here is part of the engine's published set.

| Package | What it is |
| --- | --- |
| `@smthrs-plugins/adapters` | Claude Code, Codex, Kimi, and Antigravity CLI adapters, their capability registry, and a doctor. |
| `@smthrs-plugins/accounts` | The on-disk provider account registry. |
| `@smthrs-plugins/usage` | Usage reports, durable quota state, and pool ordering. |
| `@smthrs-plugins/seat-resolver` | A `@smthrs/agent` `SeatResolver` over the registry, with the fallback seat pool. |
| `@smthrs-plugins/provider-kit` | The command sandbox provider kit, egress policy, and bundling. |
| `@smthrs-plugins/host-cloudflare` | Cloudflare Sandbox remote spawner and health provider. |
| `@smthrs-plugins/host-vercel` | Vercel Sandbox remote spawner and health provider. |
| `@smthrs-plugins/host-microsandbox` | Microsandbox remote spawner and health provider. |

## Development

Keep this repository beside the Smithers checkout it links against:

```text
parent/
  smithers-v1/
  smithers-plugins/
```

Install Smithers first, because this repository resolves against it.

```sh
cd ../smithers-v1 && pnpm install
cd ../smithers-plugins && pnpm install
pnpm check
pnpm test
```

### What the manifests say, and what development overrides

Every manifest pins what a consumer installs: `@smthrs/*` at `1.0.0-rc.0` and
`effect` at `4.0.0-rc.108`. Neither is on the registry yet, and both
repositories must share one physical `effect` install or Effect's `Context`
tags stop matching across the boundary.

The `link:` paths that arrange that live in `pnpm-workspace.yaml` `overrides`,
never in a manifest. Overrides apply to this workspace's own installs and are
not part of a published package, so publishing needs no edit: the pinned
versions are already the truth, and the day `@smthrs/*` reaches the registry
the overrides are deleted rather than rewritten. `pnpm check` runs
`scripts/check-manifests.mjs`, which fails on a `link:` or `file:` specifier in
any manifest and on a version that drifts from those two pins.

To gate this repository against a Smithers branch, point the overrides at that
worktree:

```sh
sed -i '' 's|../smithers-v1|../smithers-v1-worktree|' pnpm-workspace.yaml
```

### Vendor SDKs

Each host package declares its vendor SDK (`@cloudflare/sandbox`,
`@vercel/sandbox`, `microsandbox`) as an optional peer dependency and carries a
structural slice of it, so the package builds and type-checks with no vendor
account. A conformance suite per host proves the slice still matches the real
package, and the real-backend suites run against a live sandbox when the
credential is present and skip with the missing variable named when it is not.

## Why these live outside the engine

Smithers 1.0 resolves seats from environment keys and ships one built-in agent.
Multi-account rotation, vendor CLI subprocesses, and cloud sandbox hosts are
local operations concerns rather than engine features, so they bind through
public seams and never through engine internals or store tables. The seams are
`@smthrs/agent` `SeatResolver`, `@smthrs/sandbox`
`RemoteChildProcessSpawner.Provider` and `SandboxHealth.PingProvider`, and
`@smthrs/harness` `FlowBinding`.
