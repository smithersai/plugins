import { describe, expect, it } from "vitest"
import * as Env from "../src/Env.ts"

describe("Env", () => {
  it("layers only safe inherited values in documented precedence order", () => {
    expect(
      Env.merge({
        processEnv: { PATH: "/bin", HOME: "/home/a", OPENAI_API_KEY: "inherited", UNSAFE: "omit" },
        runIdentity: { runId: "run-1", nodeId: "node-2", attempt: 3 },
        adapterDefaults: { PATH: "/adapter", MODEL: "default", CLAUDECODE: "nested" },
        credentials: { OPENAI_API_KEY: "credential" },
        userOverrides: { MODEL: "override", EXTRA: "yes", CLAUDE_CODE_ENTRYPOINT: "nested" }
      })
    ).toEqual({
      PATH: "/adapter",
      HOME: "/home/a",
      FLOWS_RUN_ID: "run-1",
      FLOWS_NODE_ID: "node-2",
      FLOWS_ATTEMPT: "3",
      MODEL: "override",
      OPENAI_API_KEY: "credential",
      EXTRA: "yes",
      CLAUDECODE: "",
      CLAUDE_CODE_ENTRYPOINT: "",
      ANTHROPIC_API_KEY: ""
    })
  })

  it("blanks recursion and conflicting keys unless credentials supply them", () => {
    expect(Env.scrubRecursionMarkers({ CLAUDECODE: "1" })).toMatchObject({
      CLAUDECODE: "",
      CLAUDE_CODE_ENTRYPOINT: ""
    })
    expect(Env.blankConflictingKeys({ OPENAI_API_KEY: "inherited" })).toMatchObject({
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: ""
    })
  })

  it("redacts secret-like diagnostic values", () => {
    expect(
      Env.redactForDiagnostics({
        API_KEY: "value",
        AUTHORIZATION: "Bearer value",
        token: "value",
        PASSWORD_FILE: "value",
        PATH: "/bin"
      })
    ).toEqual({
      API_KEY: "<redacted>",
      AUTHORIZATION: "<redacted>",
      token: "<redacted>",
      PASSWORD_FILE: "<redacted>",
      PATH: "/bin"
    })
  })

  it("does not let adapter or user layers spoof durable run identity", () => {
    expect(
      Env.merge({
        runIdentity: { runId: "owned-run", nodeId: "owned-node", attempt: 2 },
        adapterDefaults: { FLOWS_RUN_ID: "adapter-run" },
        userOverrides: { FLOWS_NODE_ID: "override-node", FLOWS_ATTEMPT: "9" }
      })
    ).toMatchObject({
      FLOWS_RUN_ID: "owned-run",
      FLOWS_NODE_ID: "owned-node",
      FLOWS_ATTEMPT: "2"
    })
  })

  it("accepts a pre-rendered identity environment alongside the structured form", () => {
    // A caller which already resolved its identity variables passes a plain
    // environment; it must be applied verbatim rather than treated as empty.
    expect(
      Env.merge({ runIdentity: { FLOWS_RUN_ID: "pre-rendered", CUSTOM_TAG: "kept", DROPPED: undefined } })
    ).toMatchObject({ FLOWS_RUN_ID: "pre-rendered", CUSTOM_TAG: "kept" })
    expect(Env.merge({ runIdentity: { FLOWS_RUN_ID: "pre-rendered" } })).not.toHaveProperty("DROPPED")
  })

  it("omits identity variables whose value is absent or empty", () => {
    const merged = Env.merge({ runIdentity: { runId: "", nodeId: undefined, iteration: "", attempt: 0 } })
    expect(merged).not.toHaveProperty("FLOWS_RUN_ID")
    expect(merged).not.toHaveProperty("FLOWS_NODE_ID")
    expect(merged).not.toHaveProperty("FLOWS_ITERATION")
    // Attempt zero is a real attempt number and must survive.
    expect(merged.FLOWS_ATTEMPT).toBe("0")
  })

  it("produces only the blanked keys when every layer is absent", () => {
    expect(Env.merge({})).toEqual({
      CLAUDECODE: "",
      CLAUDE_CODE_ENTRYPOINT: "",
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: ""
    })
  })

  it("retains only the baseline inherited keys from the process environment", () => {
    expect(
      Env.merge({ processEnv: { PATH: "/bin", HOME: "/h", LANG: "en", TERM: "xterm", SECRET_TOKEN: "leak" } })
    ).toMatchObject({ PATH: "/bin", HOME: "/h", LANG: "en", TERM: "xterm" })
    expect(Env.merge({ processEnv: { SECRET_TOKEN: "leak" } })).not.toHaveProperty("SECRET_TOKEN")
  })

  it("renders a missing diagnostic value as an empty string rather than undefined", () => {
    expect(Env.redactForDiagnostics({ PLAIN: undefined })).toEqual({ PLAIN: "" })
  })
})
