/**
 * The egress policy: validation, delivery, redaction, and the allow/deny
 * behaviour case 23 pinned.
 *
 * The allow/deny suite is not a mock. It starts a real origin server and a real
 * forward proxy that refuses every host but one, then runs a real child process
 * through the kit with the environment the kit produced. A denied host is
 * blocked at the proxy and an allowed host is served, and the harness's own
 * proxy environment is unchanged either way.
 */
import { RemoteChildProcessSpawner } from "@smthrs/sandbox"
import { Effect, Result, Stream } from "effect"
import { spawn } from "node:child_process"
import { createServer, request as httpRequest, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as CommandProvider from "../src/CommandProvider.ts"
import * as Egress from "../src/Egress.ts"
import type { Session } from "../src/Session.ts"

describe("Egress.normalize", () => {
  it("answers undefined for an absent policy", () => {
    for (const value of [undefined, null, false]) {
      expect(Result.getOrThrow(Egress.normalize(value))).toBeUndefined()
    }
  })

  it("joins a noProxy array into the comma form every runtime reads", () => {
    const config = Result.getOrThrow(Egress.normalize({ noProxy: ["127.0.0.1", "localhost"] }))

    expect(config?.noProxy).toBe("127.0.0.1,localhost")
  })

  it("refuses a policy that names both a CA body and a CA path", () => {
    const result = Egress.normalize({ caCertPem: "pem", caCertPath: "/ca.crt" })

    expect(result._tag).toBe("Failure")
  })

  it("refuses an env key that is not a variable name", () => {
    const result = Egress.normalize({ env: { "not a name": "x" } })

    expect(result._tag).toBe("Failure")
  })

  it("allows a secret binding key that is not a variable name", () => {
    const config = Result.getOrThrow(Egress.normalize({ secretBindings: { "sk-proxy-anthropic": "anthropic" } }))

    expect(config?.secretBindings).toEqual({ "sk-proxy-anthropic": "anthropic" })
  })
})

describe("Egress.environment", () => {
  it("projects the proxy triple a sandboxed command reads", () => {
    const config = Result.getOrThrow(
      Egress.normalize({ httpProxy: "http://p:1", httpsProxy: "http://p:2", noProxy: "localhost" })
    )

    expect(Egress.environment(config)).toEqual({
      HTTP_PROXY: "http://p:1",
      HTTPS_PROXY: "http://p:2",
      NO_PROXY: "localhost"
    })
  })

  it("points NODE_EXTRA_CA_CERTS at the delivered bundle", () => {
    const config = Result.getOrThrow(Egress.normalize({ caCertPem: "pem" }))

    expect(Egress.environment(config)["NODE_EXTRA_CA_CERTS"]).toBe(Egress.caWorkspacePath)
  })
})

describe("Egress.redact", () => {
  it("keeps env key names and hides every value", () => {
    const config = Result.getOrThrow(Egress.normalize({ env: { TOKEN: "s3cret" }, httpsProxy: "http://u:p@h:1" }))

    expect(Egress.redact(config)).toEqual({
      env: { TOKEN: "[redacted]" },
      httpsProxy: "[redacted]"
    })
  })

  it("hides a secret binding's name, which identifies the credential", () => {
    const config = Result.getOrThrow(Egress.normalize({ secretBindings: { "sk-live-abc": "anthropic" } }))

    expect(Egress.redact(config)).toEqual({ secretBindings: { binding_1: "[redacted]" } })
  })
})

describe("egress allow and deny through a real proxy", () => {
  let origin: Server
  let proxy: Server
  let originPort = 0
  let proxyPort = 0
  let allowedHost = ""

  const runThroughSession = (
    egress: unknown,
    target: string
  ): Promise<{ readonly stdout: string; readonly exitCode: number }> => {
    // The vendor session stand-in: it runs the command the kit hands it as a
    // real local process with exactly the environment the kit produced.
    const session: Session = {
      remoteId: "local",
      writeFile: () => Effect.void,
      readFile: () => Effect.succeed(""),
      exec: (command, options) =>
        Effect.sync(() => {
          const child = spawn("node", ["-e", command], {
            env: { PATH: process.env["PATH"] ?? "", ...options.env } as NodeJS.ProcessEnv
          })
          const chunks: Array<Uint8Array> = []
          child.stdout.on("data", (chunk: Buffer) => chunks.push(new Uint8Array(chunk)))
          return {
            stdout: Stream.fromArray([]),
            stderr: Stream.fromArray([]),
            exitCode: Effect.callback<number, RemoteChildProcessSpawner.ProviderError>((resume) => {
              child.on("close", (code) => {
                collected = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
                resume(Effect.succeed(code ?? -1))
              })
            })
          }
        })
    }
    let collected = ""
    const provider = Result.getOrThrow(CommandProvider.make({
      id: "test-host",
      session: "run-1",
      open: () => Effect.succeed(session),
      egress
    }))
    const script =
      `const u=new URL(process.env.HTTP_PROXY??"http://127.0.0.1:0");const t=${JSON.stringify(target)};` +
      `const no=(process.env.NO_PROXY??"").split(",").filter(Boolean);` +
      `const tu=new URL(t);const direct=no.some((h)=>tu.hostname===h);` +
      `const opts=direct?{hostname:tu.hostname,port:tu.port,path:tu.pathname}:` +
      `{hostname:u.hostname,port:u.port,path:t,headers:{host:tu.host}};` +
      `require("node:http").get(opts,(r)=>{let b="";r.on("data",(c)=>b+=c);r.on("end",()=>{` +
      `console.log(JSON.stringify({status:r.statusCode,body:b}));process.exit(r.statusCode===200?0:1)})})` +
      `.on("error",(e)=>{console.log(JSON.stringify({error:e.message}));process.exit(2)})`
    return Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        yield* provider.open("run-1")
        const started = yield* provider.spawn(script, {})
        const exitCode = yield* started.exitCode
        return { stdout: collected, exitCode }
      }))
    )
  }

  beforeAll(async () => {
    origin = createServer((_, response) => {
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("origin-ok")
    })
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve))
    originPort = (origin.address() as AddressInfo).port
    allowedHost = `127.0.0.1:${originPort}`

    proxy = createServer((clientRequest, clientResponse) => {
      const target = new URL(clientRequest.url ?? "")
      if (target.host !== allowedHost) {
        clientResponse.writeHead(403, { "content-type": "text/plain" })
        clientResponse.end("egress denied")
        return
      }
      const upstream = httpRequest(
        { hostname: target.hostname, port: target.port, path: target.pathname },
        (response) => {
          clientResponse.writeHead(response.statusCode ?? 502)
          response.pipe(clientResponse)
        }
      )
      upstream.on("error", () => {
        clientResponse.writeHead(502)
        clientResponse.end("upstream failed")
      })
      upstream.end()
    })
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
    proxyPort = (proxy.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => origin.close(() => resolve()))
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
  })

  it("passes an allowed host through the proxy", async () => {
    const outcome = await runThroughSession(
      { httpProxy: `http://127.0.0.1:${proxyPort}` },
      `http://127.0.0.1:${originPort}/`
    )

    expect(outcome.exitCode).toBe(0)
    expect(JSON.parse(outcome.stdout)).toEqual({ status: 200, body: "origin-ok" })
  })

  it("blocks a denied host at the proxy", async () => {
    const outcome = await runThroughSession(
      { httpProxy: `http://127.0.0.1:${proxyPort}` },
      "http://denied.invalid/"
    )

    expect(outcome.exitCode).toBe(1)
    expect(JSON.parse(outcome.stdout)).toEqual({ status: 403, body: "egress denied" })
  })

  it("lets a noProxy host bypass the proxy entirely", async () => {
    const outcome = await runThroughSession(
      { httpProxy: `http://127.0.0.1:${proxyPort}`, noProxy: ["127.0.0.1"] },
      `http://127.0.0.1:${originPort}/`
    )

    expect(outcome.exitCode).toBe(0)
    expect(JSON.parse(outcome.stdout).body).toBe("origin-ok")
  })

  it("never reconfigures the harness that launched the sandbox", async () => {
    const before = process.env["HTTP_PROXY"]

    await runThroughSession({ httpProxy: `http://127.0.0.1:${proxyPort}` }, `http://127.0.0.1:${originPort}/`)

    expect(process.env["HTTP_PROXY"]).toBe(before)
  })

  it("keeps a command from unsetting the policy through its own environment", async () => {
    const session: Session = {
      remoteId: "local",
      writeFile: () => Effect.void,
      readFile: () => Effect.succeed(""),
      exec: (_command, options) =>
        Effect.sync(() => {
          seen = options.env ?? {}
          return {
            stdout: Stream.fromArray([]),
            stderr: Stream.fromArray([]),
            exitCode: Effect.succeed(0)
          }
        })
    }
    let seen: Readonly<Record<string, string | undefined>> = {}
    const provider = Result.getOrThrow(CommandProvider.make({
      id: "test-host",
      session: "run-1",
      open: () => Effect.succeed(session),
      egress: { httpProxy: "http://policy:8080" }
    }))

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* provider.open("run-1")
      yield* provider.spawn("true", { env: { HTTP_PROXY: "http://escape:1" } })
    })))

    expect(seen["HTTP_PROXY"]).toBe("http://policy:8080")
  })

  it("scrubs the proxy URL out of a remote failure", async () => {
    const provider = Result.getOrThrow(CommandProvider.make({
      id: "test-host",
      session: "run-1",
      open: () =>
        Effect.succeed({
          remoteId: "local",
          writeFile: () => Effect.void,
          readFile: () => Effect.succeed(""),
          exec: () =>
            Effect.fail(
              new RemoteChildProcessSpawner.ProviderError({
                code: "spawn_error",
                message: "dial http://user:pass@proxy.internal:8080 failed"
              })
            )
        } satisfies Session),
      egress: { httpProxy: "http://user:pass@proxy.internal:8080" }
    }))

    const outcome = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        yield* provider.open("run-1")
        return yield* Effect.result(provider.spawn("true", {}))
      }))
    )

    expect(outcome._tag).toBe("Failure")
    expect(outcome._tag === "Failure" ? outcome.failure.message : "").not.toContain("pass@")
    expect(outcome._tag === "Failure" ? outcome.failure.message : "").toContain("[redacted]")
  })
})
