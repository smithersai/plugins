/**
 * The slice of the Vercel Sandbox SDK this host uses.
 *
 * Structural rather than imported: the SDK is an optional peer, and a
 * structural declaration makes a test double a real implementation of the same
 * interface instead of a cast.
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
export interface Credentials {
  readonly token?: string | undefined
  readonly teamId?: string | undefined
  readonly projectId?: string | undefined
}

/**
 * One command run in a sandbox.
 *
 * @category models
 * @since 1.0.0
 */
export interface CommandResult {
  readonly exitCode?: number | undefined
  readonly stdout?: (() => Promise<string>) | string | undefined
  readonly stderr?: (() => Promise<string>) | string | undefined
}

/**
 * A live sandbox.
 *
 * @category models
 * @since 1.0.0
 */
export interface Sandbox {
  readonly sandboxId?: string | undefined
  readonly writeFiles: (
    files: ReadonlyArray<{ readonly path: string; readonly content: Uint8Array | string }>
  ) => Promise<void>
  readonly readFile: (input: { readonly path: string }) => Promise<string>
  readonly runCommand: (input: {
    readonly cmd: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly env?: Readonly<Record<string, string>>
  }) => Promise<CommandResult>
  readonly extendTimeout?: ((millis: number) => Promise<void>) | undefined
  readonly stop?: (() => Promise<void>) | undefined
}

/**
 * The SDK entry point.
 *
 * @category models
 * @since 1.0.0
 */
export interface Sdk {
  readonly Sandbox: {
    readonly create: (
      input: Credentials & {
        readonly timeout?: number | undefined
        readonly runtime?: string | undefined
      }
    ) => Promise<Sandbox>
  }
}
