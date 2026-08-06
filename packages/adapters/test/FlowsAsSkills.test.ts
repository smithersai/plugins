import * as FileSystem from "@smithers/kernel/FileSystem"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { install, mount, render } from "../src/FlowsAsSkills.ts"
import type { Selection } from "../src/Projection.ts"

const selection: Selection = {
  descriptors: [] as const,
  names: new Map([["inspect", "inspect"]]),
  flowNames: new Map([["inspect", "inspect"]]),
  digest: "selection",
  flows: [{
    descriptor: { name: "inspect", description: "Inspect a workspace", capabilities: ["fs:read"] },
    toolName: "inspect",
    inputSchema: { type: "object", properties: { path: { type: "string" } } }
  }] as Selection["flows"]
}

describe("FlowsAsSkills", () => {
  it("renders deterministic plugin and home layouts", async () => {
    const plugin = await Effect.runPromise(render(selection, { skillsInstall: "plugin-dir" }))
    const home = await Effect.runPromise(render(selection, { skillsInstall: "home-dir" }))
    expect(plugin.files.map((file) => file.path)).toEqual([
      ".claude-plugin/plugin.json",
      "skills/inspect/SKILL.md"
    ])
    expect(JSON.parse(plugin.files[0]!.content)).toMatchObject({ name: "flows-projection" })
    expect(plugin.files[1]?.content).toContain("description: \"Inspect a workspace\"")
    expect(home.files.map((file) => file.path)).toEqual([".codex/skills/inspect/SKILL.md"])
    expect((await Effect.runPromise(render(selection, { skillsInstall: "plugin-dir" }))).digest).toBe(plugin.digest)
    expect(plugin.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it("uses the scoped kernel filesystem installation directory", async () => {
    const writes: Array<string> = []
    let released = false
    const fs = FileSystem.makeNoop({
      makeTempDirectoryScoped: () =>
        Effect.acquireRelease(Effect.succeed("/tmp/flows-skills"), () =>
          Effect.sync(() => {
            released = true
          })),
      makeDirectory: () => Effect.void,
      writeFileString: (path) =>
        Effect.sync(() => {
          writes.push(path)
        })
    })
    const rendered = await Effect.runPromise(render(selection, { skillsInstall: "home-dir" }))
    await Effect.runPromise(Effect.scoped(install(rendered).pipe(Effect.provideService(FileSystem.FileSystem, fs))))
    expect(writes).toEqual(["/tmp/flows-skills/.codex/skills/inspect/SKILL.md"])
    expect(released).toBe(true)
  })

  it("bridges mounted layouts into CliHarness options", async () => {
    const fs = FileSystem.makeNoop({
      makeTempDirectoryScoped: () => Effect.succeed("/tmp/flows-skills"),
      makeDirectory: () => Effect.void,
      writeFileString: () => Effect.void
    })
    const rendered = await Effect.runPromise(render(selection, { skillsInstall: "plugin-dir" }))
    const mounted = await Effect.runPromise(
      Effect.scoped(
        mount(rendered, { skillsInstall: "plugin-dir" }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs)
        )
      )
    )
    expect(mounted.harnessOptions.commandOptions?.({} as never)).toEqual({
      extraArgs: ["--plugin-dir", "/tmp/flows-skills"]
    })

    const homeRendered = await Effect.runPromise(render(selection, { skillsInstall: "home-dir" }))
    const home = await Effect.runPromise(
      Effect.scoped(
        mount(homeRendered, { skillsInstall: "home-dir" }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs)
        )
      )
    )
    expect(home.harnessOptions.environment?.({} as never)).toEqual({
      userOverrides: {
        CODEX_HOME: "/tmp/flows-skills/.codex"
      }
    })
  })

  it("refuses to render or mount for a harness which installs no skills", async () => {
    const failure = await Effect.runPromise(Effect.flip(render(selection, { skillsInstall: "none" })))
    expect(failure).toMatchObject({
      _tag: "flows/adapters/ProjectionError",
      code: "unsupported",
      message: "the harness does not support skill installation"
    })
    const rendered = await Effect.runPromise(render(selection, { skillsInstall: "plugin-dir" }))
    const mountFailure = await Effect.runPromise(
      Effect.scoped(
        Effect.flip(
          mount(rendered, { skillsInstall: "none" }).pipe(
            Effect.provideService(
              FileSystem.FileSystem,
              FileSystem.makeNoop({
                makeTempDirectoryScoped: () => Effect.die("must not create a directory"),
                makeDirectory: () => Effect.die("must not create a directory"),
                writeFileString: () => Effect.die("must not write")
              })
            )
          )
        )
      )
    )
    expect(mountFailure).toMatchObject({ code: "unsupported" })
  })

  describe("host failures during installation", () => {
    const rendering = () => Effect.runPromise(render(selection, { skillsInstall: "home-dir" }))

    const installWith = async (fs: FileSystem.FileSystem) =>
      Effect.runPromise(
        Effect.scoped(Effect.flip(install(await rendering()).pipe(Effect.provideService(FileSystem.FileSystem, fs))))
      )

    it("reports an unusable temporary root as an invalid request", async () => {
      const failure = await installWith(FileSystem.makeNoop({
        makeTempDirectoryScoped: () => Effect.fail("no temp space") as never,
        makeDirectory: () => Effect.void,
        writeFileString: () => Effect.void
      }))
      expect(failure).toMatchObject({ code: "invalid_request", message: "could not create skill directory" })
    })

    it("names the directory it could not create", async () => {
      const failure = await installWith(FileSystem.makeNoop({
        makeTempDirectoryScoped: () => Effect.succeed("/tmp/flows-skills"),
        makeDirectory: () => Effect.fail("read-only") as never,
        writeFileString: () => Effect.void
      }))
      expect(failure).toMatchObject({
        code: "invalid_request",
        message: "could not create /tmp/flows-skills/.codex/skills/inspect"
      })
    })

    it("names the skill file it could not write", async () => {
      const failure = await installWith(FileSystem.makeNoop({
        makeTempDirectoryScoped: () => Effect.succeed("/tmp/flows-skills"),
        makeDirectory: () => Effect.void,
        writeFileString: () => Effect.fail("disk full") as never
      }))
      expect(failure).toMatchObject({
        code: "invalid_request",
        message: "could not write .codex/skills/inspect/SKILL.md"
      })
    })
  })
})
