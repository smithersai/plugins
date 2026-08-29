/**
 * The Claude Code and Codex adapters against the real binaries.
 *
 * Not a mock and not a fixture replay: this spawns the vendor CLI that is
 * installed on the machine, on the account the ambient environment is signed
 * in as, and asserts that the adapter's own reader turns that binary's real
 * output into a settled answer. A machine without the binary skips with the
 * reason named, because a fabricated pass here would hide exactly the drift
 * this suite exists to catch — a vendor changing its stream shape.
 *
 * Run with `SMITHERS_ADAPTER_SMOKE=1`; it is off by default because it spends
 * a real subscription turn.
 */
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { Accounts } from "@smthrs-plugins/accounts"
import { Pool } from "@smthrs-plugins/seat-resolver"
import { QuotaState } from "@smthrs-plugins/usage"
import { Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as ClaudeCode from "../src/ClaudeCode.ts"
import * as CliRun from "../src/CliRun.ts"
import * as Codex from "../src/Codex.ts"
import * as Doctor from "../src/Doctor.ts"
import type * as Spec from "../src/Spec.ts"

const enabled = process.env["SMITHERS_ADAPTER_SMOKE"] === "1"

/** How long one live turn may take before the smoke gives up on this machine. */
const turnBudgetMillis = 180_000

const spawner = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
)

const installed = (binary: string): boolean => {
  try {
    execFileSync("command", ["-v", binary], { shell: "/bin/sh", stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )

// The registry and the quota store, over the machine's real Smithers home.
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const accountsConfig = Accounts.layerConfigFromEnv(process.env, homedir()).pipe(Layer.provide(NodePath.layer))

const usageRoot = Layer.effect(
  QuotaState.UsageRoot,
  Effect.map(Accounts.AccountsConfig, (config) => QuotaState.UsageRoot.of({ root: config.root }))
).pipe(Layer.provide(accountsConfig))

const registryLayer = Layer.mergeAll(
  Accounts.layer.pipe(Layer.provide(Layer.mergeAll(platform, accountsConfig))),
  QuotaState.layer.pipe(Layer.provide(Layer.mergeAll(platform, usageRoot)))
)

const ambientConfigDir = (binary: string): string =>
  binary === "claude"
    ? process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude")
    : process.env["CODEX_HOME"] ?? join(homedir(), ".codex")

/**
 * The seats this smoke may run on, in the order the pool would try them.
 *
 * This is the whole point of the lane joined up: `Pool.order` is the 0.x
 * `fallbackAgents` policy — registered accounts ordered by headroom, ties broken
 * by a seeded shuffle, accounts a provider already blocked last — and the
 * adapter runs on whichever account it hands back. Proving the two separately
 * would leave the seam between them untested, and that seam is the reason a
 * rate limit on one subscription does not stall a run.
 *
 * The ambient configuration directory is appended last, for a machine with no
 * registry at all.
 */
const seatsFor = async (binary: string): Promise<ReadonlyArray<string>> => {
  const provider = binary === "claude" ? "claude-code" : "codex"
  const ordered = await Effect.runPromise(
    Effect.orElseSucceed(
      Effect.gen(function*() {
        const accounts = yield* Accounts.Accounts
        const quota = yield* QuotaState.QuotaStore
        const rows = yield* accounts.list
        const state = yield* quota.read()
        // Every rung, not just the runnable one: a blocked account is stepped
        // over here the way the pool steps over it, and the smoke still has
        // somewhere to go when every account carries a stale block.
        return Pool.order(rows, { providers: [provider], quota: state.entries, seed: "adapter-smoke" })
          .flatMap((rung) => typeof rung.account.configDir === "string" ? [rung.account.configDir] : [])
      }),
      (): ReadonlyArray<string> => []
    ).pipe(Effect.provide(registryLayer))
  )
  const ambient = ambientConfigDir(binary)
  return ordered.includes(ambient) ? ordered : [...ordered, ambient]
}

/** Failures that mean "this seat is spent", so the pool moves to the next one. */
const seatIsSpent = (tag: string): boolean =>
  tag === "@smthrs-plugins/adapters/AuthFailed" || tag === "@smthrs-plugins/adapters/QuotaExhausted"

const smoke = (name: string, spec: Spec.Spec, binary: string, prompt: string) => {
  const present = installed(binary)
  describe.skipIf(!enabled || !present)(
    `${name} against the installed ${binary} binary`,
    () => {
      it("passes its own preflight", async () => {
        const outcome = await Effect.runPromise(
          Effect.result(
            Effect.flatMap(CliRun.probe, (probe) => spec.preflight!(probe, environment()))
          ).pipe(Effect.provide(spawner))
        )

        expect(outcome._tag).toBe("Success")
      }, 120_000)

      it("answers a one-word question through its own reader", async (ctx) => {
        // Seat failover, exactly as the pool does it: a seat whose login has
        // lapsed or whose quota is spent is stepped over, every other failure
        // is the adapter's and fails the test.
        const seats = await seatsFor(binary)
        const refusals: Array<string> = []

        for (const seat of seats) {
          const bounded = await Effect.runPromise(
            Effect.timeoutOption(
              Effect.result(
                CliRun.run(spec, {
                  prompt,
                  env: environment(),
                  cwd: process.cwd(),
                  configDir: seat
                })
              ),
              turnBudgetMillis
            ).pipe(Effect.provide(spawner))
          )

          if (bounded._tag === "None") {
            // The binary started and did not finish inside the budget. An
            // environment fact about this machine, not an adapter defect, so
            // the next seat gets a turn.
            refusals.push(`${seat}: no turn within ${turnBudgetMillis}ms`)
            continue
          }
          const outcome = bounded.value

          if (outcome._tag === "Failure") {
            const tag = outcome.failure._tag
            if (seatIsSpent(tag)) {
              refusals.push(`${seat}: ${tag} (${outcome.failure.message.slice(0, 100)})`)
              continue
            }
            throw new Error(`${name} smoke failed with ${tag}: ${outcome.failure.message.slice(0, 400)}`)
          }

          // eslint-disable-next-line no-console
          console.log(
            `${binary} answered on the seat at ${seat}: ${JSON.stringify(outcome.success.answer.trim().slice(0, 80))}`
          )
          expect(outcome.success.exitCode).toBe(0)
          expect(outcome.success.answer.trim().length).toBeGreaterThan(0)
          expect(outcome.success.records.length).toBeGreaterThan(0)
          return
        }

        // Every seat refused. That is a fact about this machine's logins, not a
        // statement about the adapter, so the case skips with each refusal
        // named. Asserting on the refusal count here would record a green pass
        // on a machine that never spent a real turn, which is the one outcome
        // this suite must never produce.
        ctx.skip(`no seat answered for ${binary}: ${refusals.join("; ")}`)
      }, 300_000)
    }
  )

  if (enabled && !present) {
    // eslint-disable-next-line no-console
    console.warn(`skipped: ${name} smoke needs the ${binary} binary, which is not installed here`)
  }
}

smoke("Claude Code", ClaudeCode.spec, "claude", "Reply with exactly the word: ready")
smoke("Codex", Codex.spec, "codex", "Reply with exactly the word: ready")

describe.skipIf(!enabled)("Doctor against the installed binaries", () => {
  it("reports each shipped adapter as ready or names why it is not", async () => {
    const report = await Effect.runPromise(
      Effect.flatMap(CliRun.probe, (probe) => Doctor.report(probe, environment())).pipe(
        Effect.provide(spawner)
      )
    )

    for (const entry of report.entries) {
      expect(entry.available || (entry.reason ?? "").length > 0).toBe(true)
    }
    // eslint-disable-next-line no-console
    console.log(Doctor.format(report))
  }, 300_000)
})
