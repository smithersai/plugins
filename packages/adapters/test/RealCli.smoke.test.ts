/**
 * The Claude Code and Codex adapters against the real binaries.
 *
 * Not a mock and not a fixture replay: this spawns the vendor CLI that is
 * installed on the machine, on the account the ambient environment is signed
 * in as, and asserts that the adapter's own reader turns that binary's real
 * output into a settled answer. Every gate is a `ctx.skip` in the case body
 * with the missing thing named — the toggle, the binary, or every seat — never
 * a `describe.skipIf` that reports a bare skipped count, because a run that
 * covered nothing must not read like a run that covered everything.
 *
 * A run where every seat refuses skips; a run where a seat starts and never
 * finishes a turn FAILS, because a hang is the adapter's symptom rather than a
 * fact about this machine's logins. That policy is {@link module:SmokeGate},
 * which `SmokeGate.test.ts` pins against real processes without a credential.
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
import { mkdtempSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { TestContext } from "vitest"
import { describe, expect, it } from "vitest"
import * as ClaudeCode from "../src/ClaudeCode.ts"
import * as CliRun from "../src/CliRun.ts"
import * as Codex from "../src/Codex.ts"
import * as Doctor from "../src/Doctor.ts"
import type * as Spec from "../src/Spec.ts"
import * as SmokeGate from "./SmokeGate.ts"

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

/**
 * Where the turn runs.
 *
 * A temp directory, never the package: an adapter writes vendor state beside
 * its working directory (Codex's `--output-last-message` file, a Claude Code
 * configuration directory when no seat is named), and that state carries the
 * machine's own identity.
 *
 * It is a git repository because Codex refuses to run anywhere else: `codex
 * exec` outside a repository answers "Not inside a trusted directory and
 * --skip-git-repo-check was not specified" rather than taking the turn.
 */
const workspace = mkdtempSync(join(tmpdir(), "adapter-smoke-"))
execFileSync("git", ["init", "--quiet"], { cwd: workspace, stdio: "ignore" })

/**
 * Skips the case with the missing thing named, rather than vanishing.
 *
 * `describe.skipIf` reports a skipped case with no reason at all, so a run that
 * covered nothing looks the same as a run that covered everything. Every gate
 * in this suite is stated here instead, in the case body, where `ctx.skip`
 * prints what was absent next to the skipped name.
 */
const requireEnvironment = (ctx: TestContext, binary: string, present: boolean): void => {
  if (!enabled) ctx.skip("SMITHERS_ADAPTER_SMOKE is not 1: the live smoke spends a real subscription turn")
  if (!present) ctx.skip(`the ${binary} binary is not on PATH`)
}

const smoke = (name: string, spec: Spec.Spec, binary: string, prompt: string) => {
  const present = installed(binary)
  describe(
    `${name} against the installed ${binary} binary`,
    () => {
      it("passes its own preflight", async (ctx) => {
        requireEnvironment(ctx, binary, present)
        const outcome = await Effect.runPromise(
          Effect.result(
            Effect.flatMap(CliRun.probe, (probe) => spec.preflight!(probe, environment()))
          ).pipe(Effect.provide(spawner))
        )

        expect(outcome._tag).toBe("Success")
      }, 120_000)

      it("answers a one-word question through its own reader", async (ctx) => {
        requireEnvironment(ctx, binary, present)
        // Seat failover, exactly as the pool does it: a seat whose login has
        // lapsed or whose quota is spent is stepped over. A seat that starts
        // and never finishes is not a login fact, so `SmokeGate` fails the run
        // rather than skipping it — a hung vendor process is the symptom this
        // suite exists to catch.
        const attempts = await SmokeGate.attemptSeats(spec, await seatsFor(binary), {
          prompt,
          env: environment(),
          cwd: workspace,
          budgetMillis: turnBudgetMillis
        })

        const answered = SmokeGate.settle(ctx, binary, attempts)

        // eslint-disable-next-line no-console
        console.log(
          `${binary} answered on the seat at ${answered.seat}: ${JSON.stringify(answered.answer.trim().slice(0, 80))}`
        )
        expect(answered.exitCode).toBe(0)
        expect(answered.answer.trim().length).toBeGreaterThan(0)
        expect(answered.records).toBeGreaterThan(0)
      }, 300_000)
    }
  )
}

smoke("Claude Code", ClaudeCode.spec, "claude", "Reply with exactly the word: ready")
smoke("Codex", Codex.spec, "codex", "Reply with exactly the word: ready")

describe("Doctor against the installed binaries", () => {
  it("reports each shipped adapter as ready or names why it is not", async (ctx) => {
    if (!enabled) ctx.skip("SMITHERS_ADAPTER_SMOKE is not 1: the live smoke spends a real subscription turn")
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
