import { describe, expect, it } from "vitest"
import * as CommandSpec from "../src/CommandSpec.ts"

const spec = (args: ReadonlyArray<string>): CommandSpec.CommandSpec => ({
  command: "adapter",
  args,
  cleanup: [],
  env: {}
})

describe("CommandSpec", () => {
  it("quotes diagnostic argv without treating it as an execution mechanism", () => {
    expect(CommandSpec.quoteArg("plain/path-1")).toBe("plain/path-1")
    expect(CommandSpec.quoteArg("")).toBe("''")
    expect(CommandSpec.quoteArg("two words")).toBe("'two words'")
    expect(CommandSpec.quoteArg("it's safe")).toBe("'it'\"'\"'s safe'")
    expect(CommandSpec.quoteArg("$(not executed)")).toBe("'$(not executed)'")
    expect(CommandSpec.renderArgv(spec(["--model", "two words"]))).toBe("adapter --model 'two words'")
  })

  it("reports fresh flags missing from resume argv", () => {
    const fresh = spec(["exec", "--model", "gpt", "--json", "-"])
    const resumed = spec(["exec", "--model", "gpt", "resume", "session-1", "-"])
    expect(CommandSpec.flagDiff(fresh, resumed)).toEqual(["--json"])
    expect(() => CommandSpec.assertResumePreservesFlags(fresh, resumed)).toThrow("--json")
  })

  it("accepts a resumed command built through the same builder", () => {
    const builder: CommandSpec.Builder = (options, resume) =>
      spec([
        "exec",
        "--model",
        options.model ?? "default",
        "--json",
        ...(resume === undefined ? [] : ["resume", resume.sessionId]),
        "-"
      ])
    const fresh = builder({ model: "gpt" })
    const resumed = CommandSpec.withResume(builder, { model: "gpt" }, { sessionId: "session-1" })
    expect(CommandSpec.flagDiff(fresh, resumed)).toEqual([])
    expect(() => CommandSpec.assertResumePreservesFlags(fresh, resumed)).not.toThrow()
  })
})
