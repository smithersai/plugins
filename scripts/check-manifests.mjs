/**
 * Refuses a `link:` specifier inside a package manifest.
 *
 * A published package whose dependency is a path on one machine installs
 * nowhere else. Development resolution belongs in `pnpm-workspace.yaml`
 * overrides, which never ship. This also pins the two versions the whole
 * repository has to agree on: `@smthrs/*` at 1.0.0-rc.0 and `effect` at
 * 4.0.0-rc.108, because two Effect instances do not share `Context` tags.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = new URL("..", import.meta.url).pathname
const packages = join(root, "packages")

const expected = new Map([
  ["effect", "4.0.0-rc.108"],
  ["@effect/platform-node", "4.0.0-rc.108"],
  ["@effect/platform-node-shared", "4.0.0-rc.108"],
  ["@effect/vitest", "4.0.0-rc.108"]
])

const problems = []

for (const name of readdirSync(packages)) {
  const path = join(packages, name, "package.json")
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    continue
  }
  for (const block of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [dependency, range] of Object.entries(manifest[block] ?? {})) {
      const where = `packages/${name}/package.json ${block}.${dependency}`
      if (typeof range !== "string") continue
      if (range.startsWith("link:") || range.startsWith("file:")) {
        problems.push(`${where}: ${range} is a path, not a version. Move it to pnpm-workspace.yaml overrides.`)
        continue
      }
      if (dependency.startsWith("@smthrs/") && range !== "1.0.0-rc.0") {
        problems.push(`${where}: ${range} should be 1.0.0-rc.0.`)
      }
      const pinned = expected.get(dependency)
      if (pinned !== undefined && range !== pinned) {
        problems.push(`${where}: ${range} should be ${pinned}.`)
      }
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"))
  process.exit(1)
}

console.log(`check:manifests: ${readdirSync(packages).length} manifests clean`)
