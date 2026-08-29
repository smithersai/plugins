/**
 * The published `@cloudflare/sandbox` still satisfies this host's structural
 * slice.
 *
 * This is the host's substitute for a real-backend test, and it is a compile
 * rather than a run on purpose. The SDK is a Durable Object client: it resolves
 * a sandbox from a `DurableObjectNamespace`, and its `@cloudflare/containers`
 * dependency only resolves under the `workerd` export condition, so importing
 * it from Node fails before any assertion could run. Nothing about this host is
 * executable outside a deployed Worker.
 *
 * What is provable here is the type. `pnpm run check` compiles this file, so
 * the day the vendor changes `getSandbox`, `exec`, `startProcess`, `readFile`,
 * or `mkdir`, the gate goes red instead of a mock quietly agreeing with a slice
 * that no longer describes anything. The file is not a `*.test.ts`, so vitest
 * does not collect it.
 *
 * Each assertion below is a `const` whose annotation is a conditional type, not
 * a bare type alias. A type alias that resolves to `never` still compiles, so
 * an alias proves nothing; annotating a `true` literal with
 * `X extends Y ? true : false` fails with TS2322 the moment `X` stops
 * satisfying `Y`. The vendor's `getSandbox` is generic
 * (`<T extends Sandbox<any>>(ns: DurableObjectNamespace<T>, ...) => T`), so
 * every assertion goes through `VendorSandbox`, which resolves that generic to
 * its constraint. Matching the vendor's signature against
 * `GetSandbox<DurableObjectNamespace<never>>` instead would infer `T = never`
 * and check `never extends Sandbox`, which is true for every possible vendor
 * shape.
 *
 * @since 1.0.0
 */
/// <reference types="@cloudflare/workers-types" />
import type * as Sdk from "../src/Sdk.ts"

type Vendor = typeof import("@cloudflare/sandbox")

/**
 * The sandbox `getSandbox` hands back, with the vendor's own generic resolved
 * to its constraint rather than to `never`.
 */
type VendorSandbox = ReturnType<Vendor["getSandbox"]>

/**
 * The vendor sandbox still implements every member this host calls: `exec`,
 * `startProcess`, `readFile`, `writeFile` and `mkdir`.
 *
 * @since 1.0.0
 */
export const sandboxConforms: VendorSandbox extends Sdk.Sandbox ? true : false = true

/**
 * The handle `startProcess` answers still carries `waitForExit`, `getLogs` and
 * `kill`, which is how process mode reports what a command wrote.
 *
 * @since 1.0.0
 */
export const processConforms: Awaited<ReturnType<VendorSandbox["startProcess"]>> extends Sdk.RemoteProcess ? true
  : false = true

/**
 * The resolver still accepts the binding, the id and the options this host
 * passes, and still answers a sandbox.
 *
 * @since 1.0.0
 */
export const resolverConforms: Vendor["getSandbox"] extends (
  ns: DurableObjectNamespace<VendorSandbox>,
  id: string,
  options?: Sdk.SandboxOptions
) => Sdk.Sandbox ? true
  : false = true
