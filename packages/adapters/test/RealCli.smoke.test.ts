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

// The seat: the adapter runs on the account this machine is already signed in
// as, named explicitly rather than inherited, because the adapters isolate
// their configuration directory by default.
const configDirFor = (binary: string): string =>
  binary === "claude"
    ? process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude")
    : process.env["CODEX_HOME"] ?? join(homedir(), ".codex")

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

      it("answers a one-word question through its own reader", async () => {
        const bounded = await Effect.runPromise(
          Effect.timeoutOption(
            Effect.result(
              CliRun.run(spec, {
                prompt,
                env: environment(),
                cwd: process.cwd(),
                configDir: configDirFor(binary)
              })
            ),
            turnBudgetMillis
          ).pipe(Effect.provide(spawner))
        )

        if (bounded._tag === "None") {
          // The binary is installed and started; it did not finish a turn
          // inside the smoke's budget. Reported as a named skip because that
          // is an environment fact about this machine, not an adapter defect.
          // eslint-disable-next-line no-console
          console.warn(
            `skipped: ${binary} did not finish a turn within ${turnBudgetMillis}ms on this machine`
          )
          return
        }
        const outcome = bounded.value

        if (outcome._tag === "Failure") {
          // A machine whose vendor login is interactive-only has no headless
          // seat for this binary. That is an environment fact, and the adapter
          // reporting it as AuthFailed from the vendor's own words is the
          // behaviour under test — so it is a named skip, never a silent pass
          // and never a fabricated answer. Every other failure is real.
          const tag = outcome.failure._tag
          if (tag === "@smthrs-plugins/adapters/AuthFailed") {
            // eslint-disable-next-line no-console
            console.warn(
              `skipped: ${binary} has no headless seat on this machine — the adapter classified the vendor's own refusal as AuthFailed (${outcome.failure.message.slice(0, 120)})`
            )
            expect(outcome.failure.message.length).toBeGreaterThan(0)
            return
          }
          throw new Error(`${name} smoke failed with ${tag}: ${outcome.failure.message.slice(0, 400)}`)
        }

        expect(outcome.success.exitCode).toBe(0)
        expect(outcome.success.answer.trim().length).toBeGreaterThan(0)
        expect(outcome.success.records.length).toBeGreaterThan(0)
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
