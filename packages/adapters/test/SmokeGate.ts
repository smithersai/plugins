/**
 * What a live smoke run is allowed to conclude.
 *
 * The seat loop the live smoke runs, lifted out of it so the policy can be
 * driven without a subscription. A pool tries its seats in order and stops at
 * the first one that answers; what matters here is what the run may report
 * when none of them did.
 *
 * A seat whose login has lapsed or whose quota is spent is a fact about this
 * machine's logins: the pool steps over it, and a run where every seat refuses
 * for that reason skips, naming each refusal. A seat that starts and then
 * never finishes a turn is not a login fact — a hung vendor process is exactly
 * the symptom this suite exists to catch — so a run that answered nowhere and
 * hung somewhere fails, naming the hang. Merging the two is what let an
 * all-seats-hang run report green with zero real turns.
 *
 * @since 1.0.0
 */
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import * as CliRun from "../src/CliRun.ts"
import type * as Spec from "../src/Spec.ts"

const spawner = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
)

/** What one seat's turn is given. */
export interface SeatOptions {
  readonly prompt: string
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  /** How long one turn may take on this machine before the seat counts as hung. */
  readonly budgetMillis: number
}

/** What one seat did with its turn. */
export type Attempt =
  | {
    readonly _tag: "Answered"
    readonly seat: string
    readonly answer: string
    readonly exitCode: number
    readonly records: number
  }
  /** The login has lapsed or the quota is spent: the pool's own failover case. */
  | { readonly _tag: "Spent"; readonly seat: string; readonly reason: string }
  /** The binary started and never finished a turn. */
  | { readonly _tag: "TimedOut"; readonly seat: string; readonly reason: string }
  /** Any other adapter failure. */
  | { readonly _tag: "Broke"; readonly seat: string; readonly reason: string }

const isSpent = (tag: string): boolean =>
  tag === "@smthrs-plugins/adapters/AuthFailed" || tag === "@smthrs-plugins/adapters/QuotaExhausted"

/**
 * Runs one seat's turn under the budget.
 *
 * @since 1.0.0
 */
export const attempt = async (
  spec: Spec.Spec,
  seat: string,
  options: SeatOptions
): Promise<Attempt> => {
  const bounded = await Effect.runPromise(
    Effect.timeoutOption(
      Effect.result(
        CliRun.run(spec, {
          prompt: options.prompt,
          env: options.env,
          cwd: options.cwd,
          configDir: seat
        })
      ),
      options.budgetMillis
    ).pipe(Effect.provide(spawner))
  )

  if (bounded._tag === "None") {
    return { _tag: "TimedOut", seat, reason: `no turn within ${options.budgetMillis}ms` }
  }
  const outcome = bounded.value
  if (outcome._tag === "Failure") {
    const tag = outcome.failure._tag
    return isSpent(tag)
      ? { _tag: "Spent", seat, reason: `${tag} (${outcome.failure.message.slice(0, 100)})` }
      : { _tag: "Broke", seat, reason: `${tag}: ${outcome.failure.message.slice(0, 400)}` }
  }
  return {
    _tag: "Answered",
    seat,
    answer: outcome.success.answer,
    exitCode: outcome.success.exitCode,
    records: outcome.success.records.length
  }
}

/**
 * Tries seats in the pool's order until one answers, hangs, or breaks.
 *
 * @since 1.0.0
 */
export const attemptSeats = async (
  spec: Spec.Spec,
  seats: ReadonlyArray<string>,
  options: SeatOptions
): Promise<ReadonlyArray<Attempt>> => {
  const attempts: Array<Attempt> = []
  for (const seat of seats) {
    const next = await attempt(spec, seat, options)
    attempts.push(next)
    // A spent seat is the one case the pool steps over. Anything else is the
    // run's answer, for better or worse.
    if (next._tag !== "Spent") break
  }
  return attempts
}

/** What the run may report. */
export type Verdict =
  | { readonly _tag: "Answered"; readonly attempt: Extract<Attempt, { _tag: "Answered" }> }
  | { readonly _tag: "Skip"; readonly reason: string }
  | { readonly _tag: "Fail"; readonly reason: string }

/**
 * Decides what a set of attempts means.
 *
 * @since 1.0.0
 */
export const verdict = (binary: string, attempts: ReadonlyArray<Attempt>): Verdict => {
  const answered = attempts.find((entry) => entry._tag === "Answered")
  if (answered !== undefined) return { _tag: "Answered", attempt: answered }

  const broke = attempts.flatMap((entry) => entry._tag === "Broke" ? [`${entry.seat}: ${entry.reason}`] : [])
  if (broke.length > 0) return { _tag: "Fail", reason: `${binary} failed on ${broke.join("; ")}` }

  const hung = attempts.flatMap((entry) => entry._tag === "TimedOut" ? [`${entry.seat}: ${entry.reason}`] : [])
  const spent = attempts.flatMap((entry) => entry._tag === "Spent" ? [`${entry.seat}: ${entry.reason}`] : [])
  if (hung.length > 0) {
    return {
      _tag: "Fail",
      reason: `${binary} never finished a turn on ${hung.length} seat(s): ${hung.join("; ")}` +
        (spent.length === 0 ? "" : ` (spent seats stepped over: ${spent.join("; ")})`)
    }
  }
  // A run that tried nothing covered nothing; it must not read like a run that
  // covered everything either.
  if (attempts.length === 0) return { _tag: "Fail", reason: `${binary} was offered no seat to run on` }

  return { _tag: "Skip", reason: `no seat answered for ${binary}: ${spent.join("; ")}` }
}

/**
 * Applies a verdict to a running case: the answered attempt, a named skip, or
 * a thrown failure.
 *
 * @since 1.0.0
 */
export const settle = (
  ctx: { readonly skip: (reason: string) => void },
  binary: string,
  attempts: ReadonlyArray<Attempt>
): Extract<Attempt, { _tag: "Answered" }> => {
  const decided = verdict(binary, attempts)
  if (decided._tag === "Fail") throw new Error(decided.reason)
  if (decided._tag === "Skip") {
    ctx.skip(decided.reason)
    throw new Error(`unreachable: ${decided.reason}`)
  }
  return decided.attempt
}
