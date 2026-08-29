/**
 * Pool ordering and the `SeatResolver` over it.
 *
 * The resolver runs against the real registry and quota store in a temporary
 * Smithers root, with a scripted request executor standing in for the network:
 * what is under test is which account a seat resolves to and what the pool
 * learns when a provider refuses, not the provider's wire format.
 */
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Accounts } from "@smthrs-plugins/accounts"
import type { Account } from "@smthrs-plugins/accounts/Account"
import { QuotaState } from "@smthrs-plugins/usage"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { ModelError } from "@smthrs/model/ModelError"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Layer, Stream } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Pool from "../src/Pool.ts"
import * as SeatPool from "../src/SeatPool.ts"

const now = Date.parse("2026-08-29T12:00:00.000Z")

const account = (label: string, provider: Account["provider"], extra: Partial<Account> = {}): Account => ({
  label,
  provider,
  ...(provider.endsWith("-api") ? { apiKey: `key-${label}` } : { configDir: `/tmp/${label}` }),
  ...extra
})

describe("Pool", () => {
  it("draws from Claude Code and Codex by default", () => {
    const rungs = Pool.order(
      [account("c", "claude-code"), account("x", "codex"), account("k", "kimi")],
      { shuffle: false, nowMs: now }
    )

    expect(rungs.map((rung) => rung.account.label).sort()).toEqual(["c", "x"])
  })

  it("draws from every provider when asked for all", () => {
    const rungs = Pool.order([account("k", "kimi")], { providers: "all", shuffle: false, nowMs: now })

    expect(rungs).toHaveLength(1)
  })

  it("is reproducible for one seed and different across seeds", () => {
    const accounts = ["a", "b", "c", "d", "e", "f"].map((label) => account(label, "claude-code"))
    const labels = (seed: string) =>
      Pool.order(accounts, { seed, nowMs: now }).map((rung) => rung.account.label)

    expect(labels("run-1")).toEqual(labels("run-1"))
    expect(labels("run-1")).not.toEqual(labels("run-2"))
  })

  it("carries a block on the rung rather than dropping the account", () => {
    const rungs = Pool.order([account("c", "claude-code")], {
      quota: { c: { untilMs: now + 60_000, observedAt: "" } },
      shuffle: false,
      nowMs: now
    })

    expect(rungs).toHaveLength(1)
    expect(rungs[0]?.blockedUntilMs).toBe(now + 60_000)
    expect(Pool.first(rungs, now)).toBeUndefined()
  })

  it("uses a blocked account again once its reset has passed", () => {
    const rungs = Pool.order([account("c", "claude-code")], {
      quota: { c: { untilMs: now + 1_000, observedAt: "" } },
      shuffle: false,
      nowMs: now
    })

    expect(Pool.first(rungs, now + 2_000)?.account.label).toBe("c")
  })

  it("orders healthy accounts before blocked ones", () => {
    const rungs = Pool.order(
      [account("blocked", "claude-code"), account("healthy", "claude-code")],
      { quota: { blocked: { untilMs: now + 60_000, observedAt: "" } }, shuffle: false, nowMs: now }
    )

    expect(rungs.map((rung) => rung.account.label)).toEqual(["healthy", "blocked"])
  })
})

describe("SeatPool", () => {
  let root = ""

  const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

  const seats = (options: SeatPool.Options = {}) =>
    SeatPool.layer(options).pipe(
      Layer.provideMerge(Accounts.layer),
      Layer.provideMerge(QuotaState.layer),
      Layer.provideMerge(Accounts.layerConfig(root)),
      Layer.provideMerge(QuotaState.layerRoot(root)),
      Layer.provideMerge(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer))),
      Layer.provideMerge(platform)
    )

  const run = <A, E>(
    body: Effect.Effect<A, E, SeatResolver.SeatResolver | Accounts.Accounts | QuotaState.QuotaStore>,
    options: SeatPool.Options = {}
  ) => Effect.runPromise(Effect.provide(body, seats(options)) as Effect.Effect<A, E>)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "smithers-seats-"))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("refuses a seat prefix no registered provider serves", async () => {
    const outcome = await run(Effect.gen(function*() {
      const resolver = yield* SeatResolver.SeatResolver
      return yield* Effect.result(resolver.resolve("mistral:large"))
    }))

    expect(outcome._tag).toBe("Failure")
    expect(outcome._tag === "Failure" ? outcome.failure.message : "").toContain("mistral")
  })

  it("refuses when the registry holds no matching account", async () => {
    const outcome = await run(Effect.gen(function*() {
      const resolver = yield* SeatResolver.SeatResolver
      return yield* Effect.result(resolver.resolve("anthropic:claude-sonnet-4-5"))
    }))

    expect(outcome._tag === "Failure" ? outcome.failure.message : "").toContain("No registered anthropic-api")
  })

  it("resolves a seat from a registered API account", async () => {
    const seat = await run(Effect.gen(function*() {
      const accounts = yield* Accounts.Accounts
      yield* accounts.add(account("anth-1", "anthropic-api"))
      const resolver = yield* SeatResolver.SeatResolver
      return yield* resolver.resolve("anthropic:claude-sonnet-4-5")
    }))

    expect(seat.id).toBe("anthropic:claude-sonnet-4-5")
    expect(seat.contextWindowTokens).toBe(200_000)
  })

  it("refuses a subscription account, which has no model route", async () => {
    const outcome = await run(Effect.gen(function*() {
      const accounts = yield* Accounts.Accounts
      yield* accounts.add({ label: "anth-1", provider: "anthropic-api", apiKey: "" })
      const resolver = yield* SeatResolver.SeatResolver
      return yield* Effect.result(resolver.resolve("anthropic:claude-sonnet-4-5"))
    }))

    expect(outcome._tag === "Failure" ? outcome.failure.message : "").toContain("CLI adapters")
  })

  it("skips an account the quota store has blocked", async () => {
    const outcome = await run(Effect.gen(function*() {
      const accounts = yield* Accounts.Accounts
      const quota = yield* QuotaState.QuotaStore
      yield* accounts.add(account("anth-1", "anthropic-api"))
      yield* quota.record("anth-1", { untilMs: Date.now() + 600_000 })
      const resolver = yield* SeatResolver.SeatResolver
      return yield* Effect.result(resolver.resolve("anthropic:claude-sonnet-4-5"))
    }))

    expect(outcome._tag === "Failure" ? outcome.failure.message : "").toContain("rate-limited")
  })

  it("records a block when the provider refuses for quota", async () => {
    const entries = await Effect.runPromise(
      Effect.gen(function*() {
        const quota = yield* QuotaState.QuotaStore
        const failing = {
          stream: () =>
            Stream.fail(new ModelError({ code: "quota_exceeded", message: "opus weekly limit reached" }))
        }
        const wrapped = SeatPool.recording(failing, quota, "anth-1", "claude-opus-5")
        yield* Effect.ignore(Stream.runDrain(wrapped.stream({} as never)))
        return (yield* quota.read()).entries
      }).pipe(
        Effect.provide(
          QuotaState.layer.pipe(
            Layer.provideMerge(QuotaState.layerRoot(root)),
            Layer.provideMerge(platform)
          )
        )
      )
    )

    expect(Object.keys(entries)).toEqual(["anth-1::opus"])
  })

  it("leaves the store alone for a failure that is not a quota refusal", async () => {
    const entries = await Effect.runPromise(
      Effect.gen(function*() {
        const quota = yield* QuotaState.QuotaStore
        const failing = {
          stream: () => Stream.fail(new ModelError({ code: "transport", message: "socket closed" }))
        }
        const wrapped = SeatPool.recording(failing, quota, "anth-1", "claude-opus-5")
        yield* Effect.ignore(Stream.runDrain(wrapped.stream({} as never)))
        return (yield* quota.read()).entries
      }).pipe(
        Effect.provide(
          QuotaState.layer.pipe(
            Layer.provideMerge(QuotaState.layerRoot(root)),
            Layer.provideMerge(platform)
          )
        )
      )
    )

    expect(entries).toEqual({})
  })
})
