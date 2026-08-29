/**
 * A `@smthrs/agent` `SeatResolver` backed by the account registry.
 *
 * Core resolves a seat from one environment variable per provider. This
 * resolver answers the same seat strings from the registry instead, so an
 * operator with several subscriptions spreads a run across them without
 * respelling a single seat. It is bound from outside through the existing
 * `NodeControl` seat-resolver seam: the composition provides this layer in
 * place of the environment one, and nothing in core changes.
 *
 * Two halves, deliberately separate. {@link module:Pool} decides which account
 * runs next, from measured headroom and durable quota blocks. This module
 * turns the account it chose into a live route, and records a block when the
 * provider refuses, so the next resolution skips the account that just failed
 * instead of learning the same refusal again.
 *
 * @since 1.0.0
 */
import type { Account } from "@smthrs-plugins/accounts/Account"
import { Accounts } from "@smthrs-plugins/accounts"
import { QuotaState } from "@smthrs-plugins/usage"
import type { UsageReport } from "@smthrs-plugins/usage/UsageReport"
import * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import type * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import { Effect, Layer, Redacted, Result, Stream } from "effect"
import * as Pool from "./Pool.ts"

/**
 * The provider each seat prefix draws its accounts from.
 *
 * A seat with no prefix is an Anthropic seat, which is the one convention the
 * Node host already assumes.
 *
 * @category models
 * @since 1.0.0
 */
export const providerForSeat: Readonly<Record<string, Account["provider"]>> = Object.freeze({
  anthropic: "anthropic-api",
  openai: "openai-api",
  gemini: "gemini-api",
  google: "gemini-api",
  xai: "xai-api",
  grok: "xai-api"
})

const baseUrl: Readonly<Partial<Record<Account["provider"], string>>> = Object.freeze({
  "gemini-api": "https://generativelanguage.googleapis.com/v1beta/openai",
  "xai-api": "https://api.x.ai/v1"
})

const seatOf = <Body, Frame, Event, State>(
  configured: Result.Result<Route.Route<Body, Frame, Event, State>, ModelError>,
  executor: RequestExecutor.RequestExecutor,
  quota: QuotaState.Service,
  label: string,
  seat: string,
  modelId: string
): Effect.Effect<Seat.Seat, Seat.SeatUnresolved> =>
  Effect.gen(function*() {
    const routeConfig = yield* Effect.fromResult(configured).pipe(
      Effect.mapError((error) => new Seat.SeatUnresolved({ seat, message: error.message }))
    )
    const model = yield* Route.toModel(routeConfig).pipe(
      Effect.provideService(RequestExecutor.RequestExecutor, executor)
    )
    return Seat.make({
      id: seat,
      model: recording(model, quota, label, modelId),
      route: FlowEngineLike.routeResolver(routeConfig),
      contextWindowTokens: SeatResolver.contextWindowTokensFor(modelId)
    })
  })

const isQuota = (error: unknown): error is ModelError =>
  error instanceof ModelError && (error.code === "quota_exceeded" || error.code === "rate_limited")

const resetAtOf = (error: ModelError): number | undefined => {
  const match = /reset[^0-9]{0,12}(\d{10,13})/i.exec(error.message)
  if (match?.[1] === undefined) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? (match[1].length === 10 ? value * 1000 : value) : undefined
}

/**
 * How the pool resolver is configured.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options extends Pool.Options {
  /** Cached usage reports keyed by account label. */
  readonly reports?: Readonly<Record<string, UsageReport>> | undefined
}

/**
 * Builds the resolver over the registry, the quota store, and a dispatcher.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  accounts: Accounts.Service,
  quota: QuotaState.Service,
  executor: RequestExecutor.RequestExecutor,
  options: Options = {}
): SeatResolver.Service =>
  SeatResolver.make({
    resolve: (seat) =>
      Effect.gen(function*() {
        const separator = seat.indexOf(":")
        const prefix = separator < 0 ? "anthropic" : seat.slice(0, separator)
        const modelId = Seat.modelIdOf(seat)
        const provider = providerForSeat[prefix]
        if (provider === undefined) {
          return yield* new Seat.SeatUnresolved({
            seat,
            message: `No registered account provider serves the ${prefix} seat prefix`
          })
        }
        const nowMs = options.nowMs ?? Date.now()
        const registered = yield* accounts.list.pipe(
          // A registry that cannot be read means "no pool", not a failed run:
          // the composition falls back to whatever resolver sits behind this
          // one only if the caller installed one, so the refusal is typed.
          Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<Account>))
        )
        const state = yield* quota.read(nowMs).pipe(
          Effect.catchCause(() => Effect.succeed({ version: 1, entries: {} } as const))
        )
        const rungs = Pool.order(registered, {
          ...options,
          providers: [provider],
          quota: state.entries,
          ...(options.models === undefined ? { models: { [provider]: modelId } } : {}),
          nowMs
        })
        const rung = Pool.first(rungs, nowMs)
        if (rung === undefined) {
          const soonest = rungs[0]?.blockedUntilMs
          return yield* new Seat.SeatUnresolved({
            seat,
            message: rungs.length === 0
              ? `No registered ${provider} account can serve the ${seat} seat`
              : `Every registered ${provider} account is rate-limited${
                soonest === undefined ? "" : ` until ${new Date(soonest).toISOString()}`
              }`
          })
        }
        const key = rung.account.apiKey
        if (key === undefined || key === "") {
          return yield* new Seat.SeatUnresolved({
            seat,
            message:
              `Account "${rung.account.label}" carries no key. Subscription accounts run through the CLI adapters in @smthrs-plugins/adapters, not through a model route.`
          })
        }
        const apiKey = Redacted.make(key)
        const label = rung.account.label
        // The provider routes have distinct body types, so each branch is
        // erased into the seat shape on its own rather than through a union.
        return yield* provider === "anthropic-api"
          ? seatOf(Route.anthropic({ apiKey }), executor, quota, label, seat, modelId)
          : provider === "openai-api"
          ? seatOf(Route.openai({ apiKey }), executor, quota, label, seat, modelId)
          : seatOf(
            Route.openaiCompatible({ id: provider, baseUrl: baseUrl[provider] ?? "", apiKey }),
            executor,
            quota,
            label,
            seat,
            modelId
          )
      })
  })

/**
 * Wraps a model so a provider's quota refusal is written to the quota store.
 *
 * This is the whole reason the pool works across processes: the next
 * resolution reads what this one learned rather than spending another request
 * to learn it again.
 *
 * @category constructors
 * @since 1.0.0
 */
export const recording = (
  model: Model.Model,
  quota: QuotaState.Service,
  label: string,
  modelId: string
): Model.Model => ({
  stream: (request) =>
    Stream.tapError(model.stream(request), (error) =>
      isQuota(error)
        ? Effect.ignore(quota.record(label, {
          model: modelId,
          scope: /\b(fable|opus|sonnet)\b/i.test(error.message) ? "model" : "shared",
          ...(resetAtOf(error) === undefined ? {} : { untilMs: resetAtOf(error) as number })
        }))
        : Effect.void)
})

/**
 * Provides the pool resolver in place of core's environment one.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  options: Options = {}
): Layer.Layer<
  SeatResolver.SeatResolver,
  never,
  Accounts.Accounts | QuotaState.QuotaStore | RequestExecutor.RequestExecutor
> =>
  Layer.effect(
    SeatResolver.SeatResolver,
    Effect.gen(function*() {
      return make(
        yield* Accounts.Accounts,
        yield* QuotaState.QuotaStore,
        yield* RequestExecutor.RequestExecutor,
        options
      )
    })
  )
