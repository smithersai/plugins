# @smthrs-plugins/seat-resolver

A `@smthrs/agent` `SeatResolver` over the registered account pool.

Smithers core resolves seats from environment keys: one account, whatever the
process was started with. This replaces that resolver with one that reads
`@smthrs-plugins/accounts` and picks among every registered subscription, so a
rate limit on one account does not stall a run.

Bind it from outside, in place of the resolver core installs:

```ts
import { SeatPool } from "@smthrs-plugins/seat-resolver"

const seats = SeatPool.layer({ seed: "run-1" })
```

The `NodeControl` seat-resolver seam is a public composition point. Nothing in
the engine changes to accept this layer.

## The policy

`Pool` orders candidates by measured headroom, breaks ties with a seeded
shuffle, and puts accounts a provider has already blocked last rather than
dropping them — a pool with nothing but blocked accounts should still answer,
and a block whose reset has passed is usable again. `blockedUntilMs` comes from
`@smthrs-plugins/usage` `QuotaState` and is compared against the clock, so a
seat returns to the front of the pool on its own.

Seeding on the run id means two runs starting at the same moment take different
seats, and one run retrying takes the same order twice.

## What a resolved seat carries

The seat the resolver hands back names its account's configuration directory or
API key, its model, and its context window. A caller never assembles those from
the environment: the resolver owns the credential, which is what lets `agent.run`
accept only a seat that came out of one.
