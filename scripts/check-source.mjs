/**
 * The repository's lint gate: dependency-free, and it fails on real defects.
 *
 * Two rules, both of which have cost this repository something:
 *
 * 1. Every exported declaration in `src` carries a JSDoc block. These packages
 *    are consumed as source, so the doc comment above an export is the whole
 *    of its documentation. An overload group needs one block, not one per
 *    signature.
 * 2. No focused test survives a commit. `describe.only` or `it.only` silently
 *    narrows a suite to one case while the run still reports green, which is
 *    the failure class this repository's suites exist to catch.
 *
 * Run per package (`pnpm run lint`) or over everything (`pnpm run lint` at the
 * root). The package directory is the argument; it defaults to the caller's
 * working directory.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const root = resolve(process.argv[2] ?? process.cwd())

const walk = (directory) => {
  let files = []
  let entries
  try {
    entries = readdirSync(directory)
  } catch {
    return files
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) files = files.concat(walk(full))
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) files.push(full)
  }
  return files
}

const problems = []

const overloadName = (line) => {
  const match = /^export (?:declare )?function ([A-Za-z0-9_$]+)/.exec(line)
  return match === null ? undefined : match[1]
}

for (const file of walk(join(root, "src"))) {
  const lines = readFileSync(file, "utf8").split("\n")
  let documentedOverload
  lines.forEach((line, index) => {
    if (!line.startsWith("export ")) return
    const name = overloadName(line)
    let cursor = index - 1
    while (cursor >= 0 && lines[cursor].trim() === "") cursor--
    if ((lines[cursor] ?? "").trim().endsWith("*/")) {
      documentedOverload = name
      return
    }
    // A second or third signature of an overload group shares the block above
    // the first one.
    if (name !== undefined && name === documentedOverload) return
    problems.push(`${relative(root, file)}:${index + 1}: exported without a JSDoc block: ${line.trim().slice(0, 70)}`)
  })
}

for (const file of walk(join(root, "test"))) {
  readFileSync(file, "utf8").split("\n").forEach((line, index) => {
    if (/\b(?:describe|it|test)\.only\b/.test(line)) {
      problems.push(`${relative(root, file)}:${index + 1}: a focused test would hide the rest of the suite`)
    }
  })
}

if (problems.length > 0) {
  console.error(problems.join("\n"))
  process.exit(1)
}

console.log(`lint: ${relative(resolve(root, ".."), root)} clean`)
