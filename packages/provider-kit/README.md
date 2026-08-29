# @smthrs-plugins/provider-kit

What every cloud sandbox host would otherwise write twice.

A host package supplies a `Session` over its vendor SDK — open a sandbox, run a
command in it, read the files it wrote. This package turns that into a
`@smthrs/sandbox` `RemoteChildProcessSpawner.Provider` with the egress policy
delivered to the command, secrets scrubbed out of diagnostics, and a liveness
probe wired to `SandboxHealth`.

```ts
import { CommandProvider } from "@smthrs-plugins/provider-kit"

const provider = CommandProvider.make({ id: "vendor", session: "run-1", open })
```

`host-cloudflare`, `host-vercel`, and `host-microsandbox` are each a `Session`
and little else. Everything they share lives here.

## Egress

The rule this module exists to keep is the one fault case 23 pinned: a sandbox's
proxy configuration is delivered **to the sandbox**, never applied to the
harness that launched it. A harness that reconfigured its own proxy to run a
sandboxed command would route its control-plane traffic through the sandbox's
proxy, and every other run in the process with it.

Allow and deny are expressed the way every proxy-aware runtime already
understands them: `HTTP_PROXY` and `HTTPS_PROXY` name the proxy that decides,
`NO_PROXY` names the hosts that bypass it. A denied host reaches the proxy and is
refused there; an allowed host bypasses or is passed through.

`test/Egress.test.ts` proves this against real sockets, not a mock: it starts an
origin server and a proxy, runs a command through the kit with the environment
the kit produced, and asserts the denied host is blocked at the proxy while the
allowed host is served — and that the harness's own environment is untouched.

## Containment

`SandboxPath.resolve` keeps a sandboxed path inside its root with two checks,
both needed. The lexical one rejects a path escaping by `..` before anything
touches the disk. The symlink one resolves the nearest existing ancestor of the
target, because a symlinked parent of a path that does not exist yet would
otherwise smuggle a write outside the root.
