# @smthrs-plugins/host-vercel

Vercel Sandbox as a Smithers host.

```ts
import { VercelSandbox } from "@smthrs-plugins/host-vercel"

const provider = VercelSandbox.make({ sdk, session: "run-1", timeoutMs: 900_000 })
```

The provider is a `@smthrs/sandbox` `RemoteChildProcessSpawner.Provider` and a
`SandboxHealth.PingProvider` over `@smthrs-plugins/provider-kit`, talking to the
vendor SDK through `Sdk`, a structural slice rather than a package dependency.

## Credential precedence

The order is not arbitrary, and `Credentials` is where it is written down:

1. An explicitly configured OIDC token, the most specific thing a caller can
   say.
2. The ambient `VERCEL_OIDC_TOKEN`, which a Vercel deployment injects.
3. A personal access token, which needs its team and project named alongside it
   and is therefore accepted only when all three are present.

## Timeouts beyond the create ceiling

The SDK caps the duration a sandbox may be created with. A longer run is reached
incrementally: create at the ceiling, then extend by the remainder. Note that
`extendTimeout` extends **by** its argument rather than **to** it, so the
remainder is what goes in. A request beyond the plan cap fails here with the
number named, not on the wire.
