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
 * @since 1.0.0
 */
/// <reference types="@cloudflare/workers-types" />
import type * as Sdk from "../src/Sdk.ts"

type Vendor = typeof import("@cloudflare/sandbox")

/** Fails to compile when the vendor's resolver stops implementing the slice. */
type Conforms<T extends Sdk.GetSandbox<DurableObjectNamespace<never>>> = T

/** The assertion is the compile, not the value. */
export type VendorConforms = Conforms<Vendor["getSandbox"]>

/** The sandbox the resolver answers is the one this host drives. */
export type SandboxConforms = ReturnType<Vendor["getSandbox"]> extends Sdk.Sandbox ? true : never
