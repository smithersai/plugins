/**
 * A {@link Spec.Probe} whose answers are scripted.
 *
 * Preflight is the one place an adapter talks to the host, so a suite that
 * wanted to pin "missing binary" against "broken configuration" would
 * otherwise need a real binary that is missing in one run and broken in the
 * next. This is that stand-in.
 */
import { Effect } from "effect"
import * as AdapterError from "../src/AdapterError.ts"
import type * as Spec from "../src/Spec.ts"

export const probeOf = (
  answer: (command: string) =>
    | { readonly exitCode: number; readonly stdout?: string }
    | AdapterError.AdapterError
): Spec.Probe => ({
  exec: (command) => {
    const result = answer(command)
    return "exitCode" in result
      ? Effect.succeed({ exitCode: result.exitCode, stdout: result.stdout ?? "" })
      : Effect.fail(result)
  }
})

export const exits = (exitCode: number, stdout = ""): Spec.Probe => probeOf(() => ({ exitCode, stdout }))

export const unreachable = (): Spec.Probe =>
  probeOf(() => new AdapterError.SpawnFailed({ message: "probe could not run on the selected host" }))
