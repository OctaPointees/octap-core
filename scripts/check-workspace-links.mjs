// Fails when a workspace package would be installed from npm instead of linked from this repo.
//
// npm (unlike pnpm or yarn) has no `workspace:*`: when an `@octap/*` dependency's range does not
// cover the version of that package in this repo, npm quietly installs the published one from the
// registry, so the code under test is not the code in the repo. Two checks:
// 1. every dependency on a workspace package names a range its current version satisfies;
// 2. the lockfile links every workspace package, with no copy of one fetched from the registry.
//
// Ranges are kept to the forms this repo uses: an exact version, `^x.y.z` or `*`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const rootManifest = read('package.json');
const lock = read('package-lock.json');

const workspaces = new Map();
for (const dir of rootManifest.workspaces) {
  const manifest = read(join(dir, 'package.json'));
  workspaces.set(manifest.name, { dir, version: manifest.version, manifest });
}

const parse = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
};

/** Whether `version` satisfies `range`, for the forms above; `null` for a form not supported. */
function satisfies(version, range) {
  if (range === '*') return true;
  const have = parse(version);
  if (!have) return null;
  if (parse(range)) return range === version;
  if (!range.startsWith('^')) return null;
  const want = parse(range.slice(1));
  if (!want) return null;
  const [major, minor, patch] = want;
  const atLeast =
    have[0] > major || (have[0] === major && (have[1] > minor || (have[1] === minor && have[2] >= patch)));
  if (!atLeast) return false;
  // Caret: the first non-zero part is fixed (^0.2.0 is >=0.2.0 <0.3.0; ^0.0.3 is exactly 0.0.3).
  if (major > 0) return have[0] === major;
  if (minor > 0) return have[0] === 0 && have[1] === minor;
  return have[0] === 0 && have[1] === 0 && have[2] === patch;
}

const problems = [];
for (const { dir, manifest } of workspaces.values()) {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      const target = workspaces.get(name);
      if (!target) continue;
      const ok = satisfies(target.version, range);
      if (ok === null) problems.push(`${dir}: ${field}.${name} "${range}" is not an exact version, ^x.y.z or *`);
      else if (!ok)
        problems.push(
          `${dir}: ${field}.${name} "${range}" does not cover ${target.version} in ${target.dir}; ` +
            `npm would install the published one instead`,
        );
    }
  }
}

for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  const at = path.lastIndexOf('node_modules/');
  if (at < 0) continue;
  const name = path.slice(at + 'node_modules/'.length);
  if (workspaces.has(name) && !entry.link)
    problems.push(
      `package-lock.json: ${path} is ${entry.version ?? '?'} from the registry, not linked to the workspace`,
    );
}

if (problems.length) {
  console.error('Workspace packages would not be linked:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  console.error('\nFix the range to cover the workspace version, then run `npm install` to refresh the lockfile.');
  process.exit(1);
}
console.log(`Every dependency on the ${workspaces.size} workspace packages links to this repo.`);
