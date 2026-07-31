# Deploying host services on Vercel

This guide explains the Vercel Edge host, Node function host, remote sandbox seam, and server database layer. It identifies the additional work required for a full durable-engine deployment.

## Edge host

```ts
import { VercelHost } from "@smithers/host-vercel"

const HostLayer = VercelHost.layer({
  storage: { blob }
})
```

`storage` must satisfy `VercelFileSystem.Storage`, which accepts either a Blob binding or a KV-compatible binding. The complete host surface is present, but local shell, PTY, and Jujutsu operations fail as unsupported.

Use `VercelHost.layerWithSandbox(options, provider)` to route shell operations through a `VercelSandbox.Provider`. `VercelSandbox.fromBinding` and `fromSandbox` adapt application bindings and the Vercel Sandbox SDK respectively.

## Node function host

Import `@smithers/host-vercel/node` for `NodeVercelHost.layerEphemeral(root?)`. It uses a Node host rooted at `/tmp` by default. Files disappear with the function instance; this is scratch space, not durable engine storage.

## Database

Import `@smithers/host-vercel/store` only from server code:

```ts
import * as VercelStore from "@smithers/host-vercel/store"

const DatabaseLayer = VercelStore.layer({ sql })
```

The caller creates the Effect `SqlClient`, normally for PostgreSQL. `layerFromService` instead reads `SqlClient` from the Effect environment. Run journal migrations before constructing journal stores.

## Full-engine status

The full `EngineStore` is currently Node-oriented, but deferred/clock durability and a production `StepBoundary` are still application responsibilities. Serverless workers must also arrange reliable wake delivery and trustworthy ownership liveness. A packaged Vercel durable-engine assembly is **Planned**.

See the [`@smithers/host-vercel` reference](../reference/host-vercel.md), [Assembling a durable engine](https://github.com/smithersai/flows/blob/main/docs/guides/durable-engine.md), and [Implementation status](https://github.com/smithersai/flows/blob/main/docs/architecture/implementation-status.md).
