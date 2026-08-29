/**
 * The slice of the Vercel Sandbox SDK this host uses.
 *
 * Structural rather than imported: the SDK is an optional peer, so a checkout
 * that never opens a Vercel sandbox still builds, and a structural declaration
 * makes a test double a real implementation of the same interface instead of a
 * cast.
 *
 * Structural does not mean invented. Every member below is the shape
 * `@vercel/sandbox` actually publishes, and
 * `test/SdkConformance.test.ts` fails the `check` gate when the vendor
 * stops satisfying it.
 *
 * @since 1.0.0
 */

/**
 * The credential shape the SDK's `create` accepts.
 *
 * There is no `oidcToken` parameter. `token` is documented as "an OIDC token or
 * a personal access token", so an OIDC token maps straight into it, and an
 * access token arrives with the team and project it belongs to. An empty object
 * is legal and means "discover from the environment".
 *
 * @category models
 * @since 1.0.0
 */
export type Credentials = {
  readonly token?: string
  readonly teamId?: string
  readonly projectId?: string
}

/**
 * The `create` input this host sends.
 *
 * A type alias rather than an interface on purpose: the vendor's parameter
 * type carries a `__`-prefixed index signature, and only an alias picks up the
 * implicit index signature that makes the two assignable.
 *
 * @category models
 * @since 1.0.0
 */
export type CreateInput = Credentials & {
  readonly timeout?: number
  readonly runtime?: string
}

/**
 * One finished command.
 *
 * Output arrives through methods rather than fields: the SDK fetches it from
 * the sandbox on demand and caches it.
 *
 * @category models
 * @since 1.0.0
 */
export interface CommandFinished {
  readonly exitCode: number
  stdout(): Promise<string>
  stderr(): Promise<string>
}

/**
 * A live sandbox.
 *
 * `readFile` answers a stream, not text. That is the vendor's contract and the
 * reason this host decodes before handing anything to a caller.
 *
 * @category models
 * @since 1.0.0
 */
export interface Sandbox {
  /** The sandbox's own name. The host reports it as the remote id. */
  readonly name: string
  writeFiles(files: Array<{ path: string; content: Uint8Array | string }>): Promise<void>
  readFile(file: { path: string }): Promise<NodeJS.ReadableStream | null>
  runCommand(params: {
    cmd: string
    args?: Array<string>
    cwd?: string
    env?: Record<string, string>
  }): Promise<CommandFinished>
  /** Extends the lifetime *by* the duration, not *to* it. */
  extendTimeout(duration: number): Promise<unknown>
  stop(): Promise<unknown>
}

/**
 * The SDK entry point.
 *
 * @category models
 * @since 1.0.0
 */
export interface Sdk {
  readonly Sandbox: {
    create(input: CreateInput): Promise<Sandbox>
  }
}
