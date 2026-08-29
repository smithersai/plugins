# @smthrs-plugins/usage

Provider usage reports and durable account quota state.

Two halves, plus the ordering they produce together.

- `UsageReport` is the normalized shape every usage source produces, whatever
  the vendor reported: windows, their limits, and what is left.
- `QuotaState` is the durable record of which accounts a provider has already
  refused, held in `account-quota-state.json` beside the registry so the next
  process starts where the last one left off instead of re-discovering a
  rate limit by spending a turn on it.
- `Selection` combines them into the order a seat pool picks from.

```ts
import { QuotaState, Selection } from "@smthrs-plugins/usage"
import { Effect } from "effect"

const order = Effect.gen(function*() {
  const quota = yield* QuotaState.QuotaStore
  const state = yield* quota.read()
  return Selection.orderAccountsByUsage([], { quota: state.entries })
})
```

## Availability

`Availability` reduces an account's windows to one of `ok`, `degraded`,
`blocked`, or `unknown`, because that is the decision a pool actually makes. The
distinction that carries the weight is account-wide against model-scoped: an
exhausted five-hour session blocks every request, while an exhausted per-model
weekly cap still leaves the other models usable. Collapsing the two would idle a
whole subscription over one model's limit. `ModelFamily` names the families a
provider caps separately.

A window past its reset has rolled over, so its recorded utilization describes
the previous period and reads as fresh. Every function takes `nowMs`, so the
answer is deterministic in a test.

## Why the state is durable

A quota refusal is expensive to learn — it costs a request, and on a
subscription CLI it can cost a turn. Recording the refusal with its reset time
means a restarted process skips the seat until the window rolls over, instead of
paying to find out again.
