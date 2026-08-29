# @smthrs-plugins/host-cloudflare

Cloudflare Sandbox containers and Cloudflare SQLite storage as Smithers hosts.

```ts
import { CloudflareSandbox } from "@smthrs-plugins/host-cloudflare"

const provider = CloudflareSandbox.make({ getSandbox, binding, session: "run-1" })
```

The provider is a `@smthrs/sandbox` `RemoteChildProcessSpawner.Provider` and a
`SandboxHealth.PingProvider` over `@smthrs-plugins/provider-kit`. It talks to the
vendor SDK through `Sdk`, a structural slice of the interface rather than a
dependency on the package, so the host builds and tests without a Cloudflare
account.

## Two execution modes, one outcome

`exec` returns a finished result. `startProcess` returns a handle, and the
provider waits on `waitForExit` and reconciles the outcome exactly as `exec`
does, so a caller sees one shape regardless of which mode the SDK offered.

## `sleepAfter`

Passed straight through, because it is the container cost lever: it sets the
idle-hibernation window. A caller that names none gets the SDK default rather
than one this package invented.

## D1

`D1` builds SQLite descriptors over Durable Object storage and over D1. The D1
descriptor reports `supportsTransactions: false`. D1's HTTP API has no
transaction that survives across round trips, and a descriptor that claimed
otherwise would let a caller write code whose rollback silently does nothing.
Reserve D1 for read-mostly work. Durable Object storage, which does hold a
transaction, reports `true`.
