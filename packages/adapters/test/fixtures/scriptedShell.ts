/**
 * Scripted protected host services for CLI harness tests.
 *
 * @since 0.1.0
 */
import * as FileSystem from "@flows/kernel/FileSystem"
import * as Shell from "@flows/kernel/Shell"
import { Effect, Layer, Stream } from "effect"

/**
 * One buffered command result replayed by the scripted Shell.
 *
 * @category models
 * @since 0.1.0
 */
export interface Script {
  readonly stdout?: string | undefined
  readonly stdoutChunks?: ReadonlyArray<string> | undefined
  readonly stderr?: string | undefined
  readonly exitCode?: number | undefined
  readonly hang?: boolean | undefined
  readonly hangAfterOutput?: boolean | undefined
}

/**
 * Observable calls made through the scripted host boundary.
 *
 * @category models
 * @since 0.1.0
 */
export interface Recorder {
  readonly commands: Array<string>
  readonly stdin: Array<string | undefined>
  readonly environments: Array<Readonly<Record<string, string>> | undefined>
  readonly cleanups: Array<string>
  readonly writes: Array<{ readonly path: string; readonly content: string }>
  interrupted: number
}

/**
 * A scripted Shell/FileSystem host fragment and its recorder.
 *
 * @category models
 * @since 0.1.0
 */
export interface Fixture {
  readonly layer: Layer.Layer<Shell.Shell | FileSystem.FileSystem>
  readonly recorder: Recorder
}

/**
 * Constructs a Shell.makeNoop-style layer which replays buffered results.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  scripts: ReadonlyArray<Script>,
  files: Readonly<Record<string, string>> = {}
): Fixture => {
  const remaining = [...scripts]
  const recorder: Recorder = {
    commands: [],
    stdin: [],
    environments: [],
    cleanups: [],
    writes: [],
    interrupted: 0
  }
  const shell = Shell.layerNoop({
    exec: (command, options) =>
      Effect.suspend(() => {
        const script = remaining.shift()
        recorder.commands.push(command)
        recorder.stdin.push(options?.stdin)
        recorder.environments.push(options?.env)
        if (script === undefined) return Effect.die(`No scripted result for ${command}`)
        if (script.hang === true) {
          return Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                recorder.interrupted += 1
              })
            )
          )
        }
        return Effect.succeed({
          stdout: script.stdout ?? "",
          stderr: script.stderr ?? "",
          exitCode: script.exitCode ?? 0
        })
      }),
    stream: (command, options) =>
      Stream.unwrap(
        Effect.sync(() => {
          const script = remaining.shift()
          recorder.commands.push(command)
          recorder.stdin.push(options?.stdin)
          recorder.environments.push(options?.env)
          if (script === undefined) return Stream.die(`No scripted result for ${command}`)
          const encoder = new TextEncoder()
          const stdout = script.stdoutChunks ?? (script.stdout === undefined ? [] : [script.stdout])
          const chunks = [
            ...stdout.map((text) => ({ kind: "stdout" as const, chunk: encoder.encode(text) })),
            ...(script.stderr === undefined
              ? []
              : [{ kind: "stderr" as const, chunk: encoder.encode(script.stderr) }])
          ]
          const output = Stream.fromArray(chunks)
          if (script.hang === true || script.hangAfterOutput === true) {
            return output.pipe(
              Stream.concat(
                Stream.fromEffect(
                  Effect.never.pipe(
                    Effect.onInterrupt(() =>
                      Effect.sync(() => {
                        recorder.interrupted += 1
                      })
                    )
                  )
                )
              )
            )
          }
          return output.pipe(
            Stream.concat(
              Stream.succeed({
                kind: "stdout" as const,
                chunk: encoder.encode(`\n__FLOWS_CLI_EXIT__:${script.exitCode ?? 0}\n`)
              })
            )
          )
        })
      )
  })
  const fileSystem = FileSystem.layerNoop({
    readFileString: (path) =>
      files[path] === undefined
        ? Effect.die(`Missing scripted file ${path}`)
        : Effect.succeed(files[path]),
    remove: (path) =>
      Effect.sync(() => {
        recorder.cleanups.push(path)
      }),
    makeTempDirectoryScoped: ({ prefix }) => Effect.succeed(`/tmp/${prefix}scripted`),
    makeDirectory: () => Effect.void,
    writeFileString: (path, content) =>
      Effect.sync(() => {
        recorder.writes.push({ path, content })
      })
  })
  return {
    layer: Layer.merge(shell, fileSystem),
    recorder
  }
}
