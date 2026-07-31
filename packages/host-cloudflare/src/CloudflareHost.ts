/** Complete Cloudflare Workers Host bundle. @since 0.1.0 */
import { HostServiceIds } from "@smithers/host/HostServices"
import type * as HttpTransport from "@smithers/host/HttpTransport"
import type * as Jj from "@smithers/host/Jj"
import type * as Pty from "@smithers/host/Pty"
import type * as Shell from "@smithers/host/Shell"
import { Layer, Path } from "effect"
import type { FileSystem } from "effect/FileSystem"
import * as CloudflareFileSystem from "./CloudflareFileSystem.ts"
import * as CloudflareHttpTransport from "./CloudflareHttpTransport.ts"
import * as CloudflareJj from "./CloudflareJj.ts"
import * as CloudflarePty from "./CloudflarePty.ts"
import * as CloudflareSandbox from "./CloudflareSandbox.ts"
import * as CloudflareShell from "./CloudflareShell.ts"

export {
  CloudflareFileSystem,
  CloudflareHttpTransport,
  CloudflareJj,
  CloudflarePty,
  CloudflareSandbox,
  CloudflareShell
}

/** The closed Host service union supplied by Cloudflare Workers. @category models @since 0.1.0 */
export type CloudflareHost = FileSystem | Path.Path | Shell.Shell | Pty.Pty | Jj.Jj | HttpTransport.HttpTransport

/** Stable implementation identities for the six Host slots. @category models @since 0.1.0 */
export const implementationIds: Readonly<Record<(typeof HostServiceIds)[number], string>> = {
  "effect/FileSystem": "cloudflare-object-storage",
  "effect/Path": "cloudflare-path",
  "flows/host/Shell": "cloudflare-edge-unsupported",
  "flows/host/Pty": "cloudflare-edge-unsupported",
  "flows/host/Jj": "cloudflare-edge-unsupported",
  "flows/host/HttpTransport": "cloudflare-workers-fetch"
}

/** Default Workers layer: object storage, Workers fetch, and typed local-process failures. @category layers @since 0.1.0 */
export const layer = (store: CloudflareFileSystem.ObjectStore): Layer.Layer<CloudflareHost> =>
  Layer.mergeAll(
    CloudflareFileSystem.layer(store),
    Path.layer,
    CloudflareHttpTransport.layer,
    CloudflareShell.layer,
    CloudflarePty.layer,
    CloudflareJj.layer
  )

/** Same complete Host surface, routing shell operations to a remote sandbox. @category layers @since 0.1.0 */
export const layerWithSandbox = (
  store: CloudflareFileSystem.ObjectStore,
  provider: CloudflareSandbox.SandboxProvider
): Layer.Layer<CloudflareHost> =>
  Layer.mergeAll(
    CloudflareFileSystem.layer(store),
    Path.layer,
    CloudflareHttpTransport.layer,
    CloudflareSandbox.layerShell(provider),
    CloudflarePty.layer,
    CloudflareJj.layer
  )
