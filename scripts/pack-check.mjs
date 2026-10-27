import { execSync } from 'node:child_process'

// Files npm would publish.
const out = execSync('npm pack --dry-run --json', {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
})
const [pack] = JSON.parse(out)
const files = pack.files.map((f) => f.path)
const errors = []

const allowed = /^(dist\/|package\.json$|README\.md$|LICENSE$|CHANGELOG\.md$)/
for (const file of files) if (!allowed.test(file)) errors.push('unexpected file: ' + file)
for (const required of ['dist/index.mjs', 'dist/index.cjs', 'dist/index.d.ts', 'package.json']) {
  if (!files.includes(required)) errors.push('missing file: ' + required)
}

if (errors.length > 0) {
  console.error('pack-check failed:\n  ' + errors.join('\n  '))
  process.exit(1)
}
console.log('pack-check: ' + files.length + ' files, ' + (pack.size / 1024).toFixed(1) + 'kb')
