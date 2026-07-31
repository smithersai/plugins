# @smithers/host-vercel

Vercel Edge and Node implementations of the closed Smithers host surface, with remote Sandbox and server database composition. The root is Edge-safe; dedicated `node` and `store` entries provide server-only capabilities.

```sh
npm install @smithers/host-vercel
```

## Public API

Package metadata is also exported from `@smithers/host-vercel/package.json`.

### Root: `@smithers/host-vercel`

#### `VercelFileSystem`

Adapts an injected Blob or KV binding to Effect's filesystem service.

- `BlobBinding` — structural subset of `@vercel/blob` used by the adapter.
- `KvBinding` — structural subset of a Vercel KV-compatible binding.
- `Storage` — persistent `{ blob }` or `{ kv }` binding supplied by the application.
- `make` — constructs an Effect `FileSystem` over Blob or KV storage.
- `layer` — provides the constructed `FileSystem`.

Directories are inferred from key prefixes. `watch` fails with a typed platform error because Blob and KV have no portable change stream.

#### `VercelHost`

Composes the complete six-service Vercel Edge host layer.

- `VercelFileSystem`, `VercelHttpTransport`, `VercelJj`, `VercelPty`, `VercelSandbox`, `VercelShell` — re-exported Edge implementation namespaces.
- `VercelHost` — union of the six services in the complete Edge host bundle.
- `implementationIds` — stable implementation identity for each host slot.
- `Options` — persistent Edge bundle options containing `storage`.
- `layer` — provides Blob/KV filesystem, fetch, path, and typed-unavailable local process services.
- `layerWithSandbox` — provides the same bundle with shell execution routed to Vercel Sandbox.

```ts
import { VercelHost } from "@smithers/host-vercel"
import { Effect, FileSystem } from "effect"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFile("state.json")
})

Effect.runPromise(program.pipe(
  Effect.provide(VercelHost.layer({ storage: { kv } }))
))
```

#### Platform layers

- `VercelHttpTransport.layer` — provides a fetch-backed HTTP transport with redirects disabled.
- `VercelShell.layer` — provides the typed-unavailable Edge shell.
- `VercelPty.layer` — provides the typed-unsupported Edge pseudo-terminal.
- `VercelJj.layer` — provides the typed-not-installed Edge jj service.

#### `VercelSandbox`

Adapts Vercel Sandbox clients to the shared remote-sandbox seam.

- `Provider` — alias for the shared provider-neutral remote sandbox service.
- `Session` — provider-neutral Vercel Sandbox session surface.
- `Binding` — structural async session factory.
- `fromBinding` — adapts a structural binding to the shared provider.
- `fromSandbox` — adapts an existing `@vercel/sandbox` instance.
- `layerWithSandbox` — provides a shell backed by the provider.
- `makeProvider` — names and returns an injected provider at application boundaries.

### Node: `@smithers/host-vercel/node`

Provides the invocation-lifetime Node host composition for Vercel functions.

- `NodeVercelHost` — union of the six services supplied by the Node bundle.
- `layerEphemeral` — provides local Node filesystem, path, HTTP, shell, PTY, and jj services confined below `root` (default `/tmp`).

```ts
import * as NodeVercelHost from "@smithers/host-vercel/node"

const hostLayer = NodeVercelHost.layerEphemeral()
```

The filesystem is invocation-lifetime storage and may disappear between invocations; it is not a persistence layer.

### Store: `@smithers/host-vercel/store`

Composes a server-side SQL client with the Smithers database service.

- `Options` — caller-supplied Effect `SqlClient`.
- `layer` — provides `Database` from `Options.sql`.
- `layerFromService` — provides `Database` from a `SqlClient` already in the Effect environment.

```ts
import * as VercelStore from "@smithers/host-vercel/store"

const databaseLayer = VercelStore.layer({ sql })
```

See the [package reference](../../docs/reference/host-vercel.md) and [Vercel guide](../../docs/guides/vercel.md).
