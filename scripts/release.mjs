import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

// pnpm release <patch|minor|major>: check, bump, roll changelog, commit, tag.
// Pushing the tag triggers the publish workflow.
const bump = process.argv[2]
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error('usage: pnpm release <patch|minor|major>')
  process.exit(1)
}

const run = (command) => execSync(command, { stdio: 'inherit' })

if (execSync('git status --porcelain').toString().trim()) {
  console.error('release: the working tree must be clean')
  process.exit(1)
}

if (!readFileSync('CHANGELOG.md', 'utf8').includes('## [Unreleased]')) {
  console.error('release: CHANGELOG.md needs an "## [Unreleased]" heading')
  process.exit(1)
}

run('pnpm check')

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const [major, minor, patch] = pkg.version.split('.').map(Number)
const next =
  bump === 'major'
    ? [major + 1, 0, 0]
    : bump === 'minor'
      ? [major, minor + 1, 0]
      : [major, minor, patch + 1]
const version = next.join('.')
pkg.version = version
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')

const date = new Date().toISOString().slice(0, 10)
const changelog = readFileSync('CHANGELOG.md', 'utf8')
writeFileSync(
  'CHANGELOG.md',
  changelog.replace('## [Unreleased]', '## [Unreleased]\n\n## [' + version + '] - ' + date),
)

run('git add package.json CHANGELOG.md')
run('git commit -m "🔖 release: v' + version + '"')
run('git tag v' + version)
console.log('\nreleased v' + version + '. Publish with: git push origin main v' + version)
