/**
 * Renders selected flows as deterministic skill files.
 *
 * @since 0.1.0
 */
import * as FileSystem from "@flows/kernel/FileSystem"
import * as Digest from "@flows/keys/Digest"
import { Effect, type Scope } from "effect"
import type * as CliHarness from "./CliHarness.ts"
import type { Selection } from "./Projection.ts"
import { ProjectionError } from "./Projection.ts"

/**
 * Skill installation layouts understood by wrapped harnesses.
 *
 * @category models
 * @since 0.1.0
 */
export type SkillsInstall = "plugin-dir" | "home-dir" | "none"

/**
 * The capability subset used to choose a skill installation layout.
 *
 * @category models
 * @since 0.1.0
 */
export interface SkillsCapabilities {
  readonly skillsInstall: SkillsInstall
}

/**
 * An in-memory file in a rendered skill tree.
 *
 * @category models
 * @since 0.1.0
 */
export interface SkillFile {
  readonly path: string
  readonly content: string
}

/**
 * Deterministic rendered skill tree.
 *
 * @category models
 * @since 0.1.0
 */
export interface RenderedSkills {
  readonly files: ReadonlyArray<SkillFile>
  readonly digest: string
}

/**
 * A scoped skills mount and the harness options which discover it.
 *
 * @category models
 * @since 0.1.0
 */
export interface MountedSkills {
  readonly root: string
  readonly harnessOptions: CliHarness.MakeOptions
}

const schemaText = (schema: Readonly<Record<string, unknown>>): string => JSON.stringify(schema, null, 2)

const skill = (
  name: string,
  description: string,
  toolName: string,
  schema: Readonly<Record<string, unknown>>,
  capabilities: ReadonlyArray<string>
): string =>
  [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description.replaceAll("\n", " "))}`,
    "---",
    "",
    `# ${name}`,
    "",
    description,
    "",
    `Invoke this flow through the MCP tool \`${toolName}\`.`,
    "",
    "## Input contract",
    "",
    "```json",
    schemaText(schema),
    "```",
    "",
    "## Effects and capabilities",
    "",
    capabilities.length === 0
      ? "This flow declares no additional capabilities."
      : `This flow requires: ${[...capabilities].sort().join(", ")}.`,
    ""
  ].join("\n")

const treeDigest = (files: ReadonlyArray<SkillFile>): string => {
  return Digest.digest(files.map((file) => `${file.path}\u0000${file.content}`).join("\u0001"))
}

/**
 * Renders one SKILL.md for every selected flow without writing to the host.
 *
 * @category conversions
 * @since 0.1.0
 */
export const render = (
  selection: Selection,
  capabilities: SkillsCapabilities
): Effect.Effect<RenderedSkills, ProjectionError> => {
  if (capabilities.skillsInstall === "none") {
    return Effect.fail(
      new ProjectionError({ code: "unsupported", message: "the harness does not support skill installation" })
    )
  }
  const prefix = capabilities.skillsInstall === "plugin-dir" ? "skills" : ".codex/skills"
  const pluginManifest: ReadonlyArray<SkillFile> = capabilities.skillsInstall === "plugin-dir"
    ? [{
      path: ".claude-plugin/plugin.json",
      content: `${
        JSON.stringify(
          {
            name: "flows-projection",
            version: "0.1.0",
            description: "Run-scoped flows registry projection"
          },
          null,
          2
        )
      }\n`
    }]
    : []
  const files = Object.freeze(
    [
      ...pluginManifest,
      ...selection.flows.map((flow) => ({
        path: `${prefix}/${flow.toolName}/SKILL.md`,
        content: skill(
          flow.toolName,
          flow.descriptor.description,
          flow.toolName,
          flow.inputSchema,
          flow.descriptor.capabilities
        )
      }))
    ].sort((left, right) => left.path.localeCompare(right.path))
  )
  return Effect.succeed({ files, digest: treeDigest(files) })
}

/**
 * Installs a rendered tree into a scope-owned temporary directory.
 *
 * Closing the surrounding Effect scope removes the directory and every file.
 *
 * @category operations
 * @since 0.1.0
 */
export const install = (
  rendered: RenderedSkills
): Effect.Effect<string, ProjectionError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "flows-skills-" }).pipe(
      Effect.mapError((cause) =>
        new ProjectionError({ code: "invalid_request", message: "could not create skill directory", cause })
      )
    )
    for (const file of rendered.files) {
      const target = `${root}/${file.path}`
      const directory = target.slice(0, target.lastIndexOf("/"))
      yield* fs.makeDirectory(directory, { recursive: true }).pipe(
        Effect.mapError((cause) =>
          new ProjectionError({ code: "invalid_request", message: `could not create ${directory}`, cause })
        )
      )
      yield* fs.writeFileString(target, file.content).pipe(
        Effect.mapError((cause) =>
          new ProjectionError({ code: "invalid_request", message: `could not write ${file.path}`, cause })
        )
      )
    }
    return root
  })

/**
 * Installs a rendered tree and returns its direct `CliHarness.make` bridge.
 *
 * @category operations
 * @since 0.1.0
 */
export const mount = (
  rendered: RenderedSkills,
  capabilities: SkillsCapabilities
): Effect.Effect<MountedSkills, ProjectionError, FileSystem.FileSystem | Scope.Scope> =>
  capabilities.skillsInstall === "none"
    ? Effect.fail(
      new ProjectionError({ code: "unsupported", message: "the harness does not support skill installation" })
    )
    : install(rendered).pipe(
      Effect.map((root) => ({
        root,
        harnessOptions: capabilities.skillsInstall === "plugin-dir"
          ? {
            commandOptions: () => ({
              extraArgs: ["--plugin-dir", root]
            })
          }
          : {
            environment: () => ({
              userOverrides: {
                CODEX_HOME: `${root}/.codex`
              }
            })
          }
      }))
    )
