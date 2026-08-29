/**
 * The slice of the Microsandbox SDK this host uses.
 *
 * Declared structurally rather than imported, for two reasons. The SDK is an
 * optional peer — a checkout that never runs a microVM should still build —
 * and a structural declaration is what makes the mock in this package's tests
 * a legitimate stand-in rather than a cast.
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
  readonly write: (path: string, content: string) => Promise<void>
  readonly readToString: (path: string) => Promise<string>
  readonly mkdir: (path: string) => Promise<void>
}

/**
 * One streamed command execution.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecHandle {
  readonly output: () => Promise<string>
  readonly error: () => Promise<string>
  readonly exitCode: () => Promise<number>
}

/**
 * A running microVM.
 *
 * @category models
 * @since 1.0.0
 */
export interface Sandbox {
  readonly fs: () => GuestFs
  readonly execStreamWith: (
    shell: string,
    configure: (builder: ExecBuilder) => ExecBuilder
  ) => Promise<ExecHandle>
  readonly stop?: (() => Promise<void>) | undefined
}

/**
 * The fluent command builder the SDK exposes.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecBuilder {
  readonly args: (args: ReadonlyArray<string>) => ExecBuilder
  readonly cwd: (cwd: string) => ExecBuilder
  readonly envs: (env: Readonly<Record<string, string>>) => ExecBuilder
}

/**
 * The sandbox builder.
 *
 * @category models
 * @since 1.0.0
 */
export interface SandboxBuilder {
  readonly image: (image: string) => SandboxBuilder
  readonly ephemeral: (ephemeral: boolean) => SandboxBuilder
  readonly create: () => Promise<Sandbox>
}

/**
 * The SDK entry point.
 *
 * @category models
 * @since 1.0.0
 */
export interface Sdk {
  readonly Sandbox: { readonly builder: (name: string) => SandboxBuilder }
}
