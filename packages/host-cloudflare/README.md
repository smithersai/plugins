# @smithers/host-cloudflare

Cloudflare Workers implementations of the closed Smithers host surface, plus remote Sandbox and Durable Object database adapters. It supplies edge-safe filesystem, path, HTTP, shell, PTY, and jj layers to flows compositions.

```sh
npm install @smithers/host-cloudflare
```

## Public API

The root entry exports these namespaces. The same modules are public subpaths such as `@smithers/host-cloudflare/CloudflareHost`; `CloudflareSandboxSdk` is subpath-only. Package metadata is exported from `@smithers/host-cloudflare/package.json`.

### `CloudflareFileSystem`

Adapts injected object storage to Effect's filesystem service.

- `ObjectStore` — application-supplied object-storage adapter with `get`, `put`, `delete`, and prefix `list` operations.
- `make` — constructs an Effect `FileSystem` over an `ObjectStore`.
- `layer` — provides the constructed `FileSystem`.

Directories use `.flows-dir` marker objects. `watch` fails with a typed platform error because object storage has no change feed.

### `CloudflareHost`

Composes the complete six-service Workers host layer.

- `CloudflareFileSystem`, `CloudflareHttpTransport`, `CloudflareJj`, `CloudflarePty`, `CloudflareSandbox`, `CloudflareShell` — re-exported implementation namespaces.
- `CloudflareHost` — union of the six services in the complete Workers host bundle.
- `implementationIds` — stable implementation identity for each host slot.
- `layer` — provides object storage, Workers fetch, path, and typed-unavailable local process services.
- `layerWithSandbox` — provides the same bundle with shell execution routed to a remote sandbox.

```ts
import { CloudflareHost } from "@smithers/host-cloudflare"
import * as Shell from "@smithers/host/Shell"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const shell = yield* Shell.Shell
  return yield* shell.exec("pwd")
})

Effect.runPromise(program.pipe(Effect.provide(CloudflareHost.layer(store))))
```

### Platform layers

- `CloudflareHttpTransport.layer` — provides a Workers `fetch` HTTP transport with redirects disabled.
- `CloudflareShell.layer` — provides the typed-unavailable local shell.
- `CloudflarePty.layer` — provides the typed-unsupported local pseudo-terminal.
- `CloudflareJj.layer` — provides the typed-not-installed local jj service.

### `CloudflareSandbox`

Adapts Cloudflare Sandbox clients to the shared remote-sandbox seam.

- `SandboxProvider` — alias for the shared provider-neutral remote sandbox service.
- `Client` — structural Cloudflare Sandbox execution and lifecycle interface.
- `fromBinding` — adapts a session client factory to `SandboxProvider`.
- `layer` — provides an injected `SandboxProvider`.
- `layerShell` — provides the shared shell implementation backed by the provider.

### `CloudflareStore`

Composes Durable Object SQLite storage with the Smithers database service.

- `layer` — provides `Database` from one `DurableObjectStorage` using `@effect/sql-sqlite-do` transactions.

```ts
import { CloudflareStore } from "@smithers/host-cloudflare"

const databaseLayer = CloudflareStore.layer(state.storage)
```

### `@smithers/host-cloudflare/CloudflareSandboxSdk`

Provides the direct, runtime-specific `@cloudflare/sandbox` adapter.

- `SandboxNamespace` — Cloudflare Durable Object namespace accepted by the Sandbox SDK.
- `fromNamespace` — adapts that namespace to `CloudflareSandbox.SandboxProvider`.

This module stays off the root barrel so generic browser and Node consumers do not load Cloudflare Container runtime code.

See the [package reference](../../docs/reference/host-cloudflare.md) and [Cloudflare guide](../../docs/guides/cloudflare.md).
