import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'dist')
// Flags: --no-types skips the tsc declaration emit; --sourcemap writes .map files (pnpm build:map).
const withTypes = !process.argv.includes('--no-types')
const withMap = process.argv.includes('--sourcemap')

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

// Bundle twice (ESM + CJS); node:* and packages stay external.
const common = {
  entryPoints: [path.join(ROOT, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  packages: 'external',
  sourcemap: withMap,
  keepNames: true,
  legalComments: 'none',
  logLevel: 'info',
}
await Promise.all([
  build({ ...common, format: 'esm', outfile: path.join(OUT, 'index.mjs') }),
  build({ ...common, format: 'cjs', outfile: path.join(OUT, 'index.cjs') }),
])

// Shared .d.ts for both formats.
if (withTypes) {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.error('build: tsc declaration emit failed')
    process.exit(result.status || 1)
  }
}

// version.txt: <version>+<sha8|local>.
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
const sha = (process.env.GITHUB_SHA || 'local').slice(0, 8)
await writeFile(path.join(OUT, 'version.txt'), pkg.version + '+' + sha + '\n')

console.log('dist ready: ' + path.relative(ROOT, OUT).split(path.sep).join('/'))
