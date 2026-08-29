/**
 * The slice of the Cloudflare Sandbox SDK this host uses.
 *
 * Structural rather than imported: the SDK is an optional peer that only runs
 * inside a Worker, so a Node checkout still builds, and a structural
 * declaration makes a test double a real implementation of the same interface
 * instead of a cast.
 *
 * Structural does not mean invented. Every member below is the shape
 * `@cloudflare/sandbox` actually publishes, and `test/SdkConformance.types.ts`
 * fails the `check` gate when the vendor stops satisfying it. That type pin is
 * this host's substitute for a real-backend test: the SDK cannot be driven
 * from Node at all.
 *
 * @since 1.0.0
 */

/**
 * How a command's output is fetched after it exits.
 *
 * @category models
 * @since 1.0.0
 */
export interface ProcessLogs {
  readonly stdout: string
  readonly stderr: string
}

/**
 * One command started with `startProcess`.
 *
 * A detached start answers a handle, not an outcome. Output is not on the
 * handle either: it is fetched with `getLogs` once the process has exited.
 *
 * @category models
 * @since 1.0.0
 */
export interface RemoteProcess {
  readonly id: string
  readonly pid?: number | undefined
  readonly exitCode?: number | undefined
  waitForExit(timeout?: number): Promise<{ readonly exitCode: number }>
  getLogs(): Promise<ProcessLogs>
  kill(signal?: string): Promise<void>
}

/**
 * One command run with `exec`.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * What a read answers. The text is on `content`, never the result itself.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReadFileResult {
  readonly content: string
}

/**
 * What a directory creation answers.
 *
 * @category models
 * @since 1.0.0
 */
export interface MkdirResult {
  readonly path: string
}

/**
 * How a command names its working directory and environment.
 *
 * @category models
 * @since 1.0.0
 */
export interface CommandOptions {
  cwd?: string
  env?: Record<string, string | undefined>
}

/**
 * A live sandbox Durable Object.
 *
 * @category models
 * @since 1.0.0
 */
export interface Sandbox {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<MkdirResult>
  writeFile(path: string, content: string, options?: { encoding?: string }): Promise<unknown>
  readFile(path: string): Promise<ReadFileResult>
  exec(command: string, options?: CommandOptions): Promise<ExecResult>
  startProcess(command: string, options?: CommandOptions): Promise<RemoteProcess>
}

/**
 * The idle-hibernation and session options `getSandbox` accepts.
 *
 * @category models
 * @since 1.0.0
 */
export interface SandboxOptions {
  enableDefaultSession?: boolean
  keepAlive?: boolean
  sleepAfter?: string | number
}

/**
 * How the SDK resolves a sandbox from a Durable Object binding.
 *
 * Generic in the binding because the vendor types it as
 * `DurableObjectNamespace<T>`, which only exists inside a Worker's type
 * environment. A Node caller leaves it `unknown`; the conformance test pins the
 * vendor against the Worker type.
 *
 * @category models
 * @since 1.0.0
 */
export type GetSandbox<Binding = unknown> = (
  binding: Binding,
  id: string,
  options?: SandboxOptions
) => Sandbox
