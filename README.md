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

Every `@smthrs/*` dependency and `effect` itself resolve through pnpm `link:`
paths into `../smithers-v1`, so both repositories share one physical `effect`
install and one set of `Context` tags. Install Smithers first.

```sh
cd ../smithers-v1 && pnpm install
cd ../smithers-plugins && pnpm install
pnpm check
pnpm test
```

## Why these live outside the engine

Smithers 1.0 resolves seats from environment keys and ships one built-in agent.
Multi-account rotation, vendor CLI subprocesses, and cloud sandbox hosts are
local operations concerns rather than engine features, so they bind through
public seams — `@smthrs/agent` `SeatResolver`, `@smthrs/sandbox`
`RemoteChildProcessSpawner.Provider` and `SandboxHealth.PingProvider`,
`@smthrs/harness` `Cell`, `EngineLike`, and `FlowBinding` — and never through
engine internals or store tables.
