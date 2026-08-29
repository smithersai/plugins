# @smthrs-plugins/accounts

The on-disk provider account registry.

This is what turns "I have five Claude subscriptions" into something a run can
resolve a seat from. The registry holds one row per account: a label, a
provider, and either the configuration directory that vendor's CLI reads or an
API key.

```ts
import { Accounts } from "@smthrs-plugins/accounts"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const accounts = yield* Accounts.Accounts
  return yield* accounts.list
})
```

## The file

`accounts.json` under the accounts root, which is `SMITHERS_HOME` when set and
`~/.smithers` otherwise. It is written mode 0600, because a row may carry an API
key.

Rows whose provider this build does not recognize are carried through every
rewrite verbatim. A legacy row names a directory that still holds credentials,
and an unrelated `add` or `remove` that dropped it would take those credentials
with it.

## Services, not functions

`Accounts` is an Effect service over the kernel `FileSystem` and `Path`, so a
test supplies a memory filesystem instead of a home directory, and a caller that
must not touch the disk composes `Accounts.layerNoop`. Every read-modify-write
goes through `AccountsLock`, an advisory lock file, so two processes adding an
account concurrently do not lose one of them.

`ProviderEnv.accountToProviderEnv` maps a row onto the environment variables its
vendor CLI reads. `AgentId.registeredAgentId` maps a row onto the agent id a
run names.

## Consumers

`@smthrs-plugins/seat-resolver` reads this registry through the `@smthrs/agent`
`SeatResolver` seam. Nothing here knows about seats, pools, or quota; that
policy lives in the resolver and in `@smthrs-plugins/usage`.
