# @smthrs-plugins/host-microsandbox

Local Microsandbox microVMs as a Smithers sandbox host.

```ts
import { Microsandbox } from "@smthrs-plugins/host-microsandbox"

const provider = Microsandbox.make({ sdk, session: "run-1" })
```

The provider is a `@smthrs/sandbox` `RemoteChildProcessSpawner.Provider` and a
`SandboxHealth.PingProvider` over `@smthrs-plugins/provider-kit`, talking to the
vendor SDK through `Sdk`, a structural slice rather than a package dependency.

Microsandbox is the local option: a microVM on the developer's own machine
rather than a cloud container. The egress policy, containment, and diagnostic
scrubbing are the kit's, identical to the cloud hosts.

The microVM name is derived from the session key, so reopening a session opens
the same microVM instead of starting a second one beside it, and a sticky
workspace keeps it alive after the scope closes.

The vendor SDK is an optional peer: a checkout that never runs a microVM still
builds and tests.
