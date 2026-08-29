/**
 * The slice of the Microsandbox SDK this host uses.
 *
 * Declared structurally rather than imported, for two reasons. The SDK is an
 * optional peer, so a checkout that never runs a microVM still builds, and a
 * structural declaration is what makes the double in this package's tests a
 * legitimate stand-in rather than a cast.
 *
 * Structural does not mean invented. Every member below is the shape
 * `microsandbox` actually publishes, and `test/SdkConformance.test.ts` fails
 * the `check` gate when the vendor stops satisfying it. Two shapes are easy to
 * get wrong and are called out where they are declared: a command's output
 * arrives through one `collect()`, and the strings it answers are synchronous.
 *
 * @since 1.0.0
 */

/**
 * The guest file system of a running sandbox.
 *
 * @category models
 * @since 1.0.0
 */
export interface GuestFs {
  write(path: string, data: Uint8Array | string): Promise<void>
  readToString(path: string): Promise<string>
  mkdir(path: string): Promise<void>
}

/**
 * A finished command.
 *
 * `stdout` and `stderr` are synchronous readers over an already-drained
 * buffer, not promises.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecOutput {
  readonly code: number
  stdout(): string
  stderr(): string
}

/**
 * One streamed command execution.
 *
 * The handle streams events; `collect` drains standard output and standard
 * error and waits for the exit. There is no separate per-stream reader, which
 * is why this host collects once and answers all three parts from the result.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecHandle {
  collect(): Promise<ExecOutput>
}

/**
 * The fluent command builder the SDK hands the configure callback.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecBuilder {
  args(args: Array<string>): this
  cwd(cwd: string): this
  envs(vars: Record<string, string>): this
}

/**
 * A running microVM.
 *
 * @category models
 * @since 1.0.0
 */
export interface Sandbox {
  readonly name: string
  fs(): GuestFs
  execStreamWith(cmd: string, configure: (builder: ExecBuilder) => ExecBuilder): Promise<ExecHandle>
  stop(): Promise<void>
}

/**
 * The sandbox builder.
 *
 * Every setter this host may call is declared, because a resource or lifetime
 * option that is dropped here is a microVM that boots with the wrong shape.
 *
 * @category models
 * @since 1.0.0
 */
export interface SandboxBuilder {
  image(image: string): this
  fromSnapshot(pathOrName: string): this
  cpus(n: number): this
  maxCpus(n: number): this
  memory(mib: number): this
  maxMemory(mib: number): this
  shell(shell: string): this
  security(profile: "default" | "restricted"): this
  pullPolicy(policy: string): this
  labels(labels: Record<string, string>): this
  scripts(scripts: Record<string, string>): this
  maxDuration(secs: number): this
  idleTimeout(secs: number): this
  ephemeral(enabled: boolean): this
  detached(enabled: boolean): this
  disableNetwork(): this
  create(): Promise<Sandbox>
}

/**
 * The SDK entry point.
 *
 * @category models
 * @since 1.0.0
 */
export interface Sdk {
  readonly Sandbox: { builder(name: string): SandboxBuilder }
}
