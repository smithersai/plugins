/**
 * The slice of the Cloudflare Sandbox SDK this host uses.
 *
 * Structural rather than imported: the SDK is an optional peer, and a
 * structural declaration makes a test double a real implementation of the same
 * interface instead of a cast.
 *
 * @since 1.0.0
 */

/**
 * One command started with `startProcess`.
 *
 * @category models
 * @since 1.0.0
 */
export interface RemoteProcess {
  readonly pid?: number | undefined
  readonly exitCode?: number | undefined
  readonly waitForExit?: ((timeoutMs?: number) => Promise<{ readonly exitCode?: number }>) | undefined
  readonly kill?: ((signal?: string) => Promise<void>) | undefined
}

/**
 * One command run with `exec`.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecResult {
  readonly exitCode?: number | undefined
  readonly stdout?: string | undefined
  readonly stderr?: string | undefined
}

/**
 * A live sandbox Durable Object.
 *
 * @category models
 * @since 1.0.0
 */
export interface Sandbox {
  readonly mkdir?: ((path: string) => Promise<void>) | undefined
  readonly writeFile: (
    path: string,
    content: string,
    options?: { readonly encoding?: string }
  ) => Promise<void>
  readonly readFile: (path: string) => Promise<string | { readonly content: string }>
  readonly exec: (
    command: string,
    options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> }
  ) => Promise<ExecResult>
  readonly startProcess?:
    | ((
      command: string,
      options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> }
    ) => Promise<RemoteProcess>)
    | undefined
}

/**
 * How the SDK resolves a sandbox from a Durable Object binding.
 *
 * @category models
 * @since 1.0.0
 */
export type GetSandbox = (
  binding: unknown,
  id: string,
  options: {
    readonly enableDefaultSession?: boolean
    readonly keepAlive?: boolean | undefined
    readonly sleepAfter?: string | number | undefined
  }
) => Sandbox
