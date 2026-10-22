import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { URL } from 'node:url';

// @mysten/codegen (as of 0.12.19) computes each generated module's relative
// import to contracts/utils using OS path separators without normalizing to
// POSIX for the ESM import specifier, so on Windows it emits literal
// backslashes glued onto a bogus "./src\contracts\utils\index.js" path
// instead of "../utils/index.js". Node's ESM resolver rejects backslashes
// outright, so every generated module fails to import until this runs.
// Walks subdirectories too: framework types the package uses (e.g. `0x2::table`)
// are generated under `octap/deps/`, so their correct specifier is deeper.
// Imports of those deps have a second, related bug: codegen leaves its internal
// "~root\deps\sui\table.js" placeholder (the package output dir, backslashed)
// unresolved instead of turning it into "./deps/sui/table.js".
// Re-run after every `npm run codegen` (the codegen script already does).
const toFsPath = (url) => url.pathname.replace(/^\/([a-zA-Z]):/, '$1:');
const contractsDir = toFsPath(new URL('../src/contracts', import.meta.url));
const dir = join(contractsDir, 'octap');
const utilsDir = join(contractsDir, 'utils');
const broken = /from ['"]\.\/[^'"]*utils[\\/]index\.js['"]/;
const unresolvedRoot = /from ['"]~root[\\/]([^'"]+)['"]/g;

/** POSIX relative ESM specifier from directory `from` to file `to`. */
function specifierFor(from, to) {
  const rel = relative(from, to).split('\\').join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function fixDir(current) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      fixDir(path);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    const contents = readFileSync(path, 'utf8');
    const fixed = contents
      .replace(broken, `from '${specifierFor(current, join(utilsDir, 'index.js'))}'`)
      .replace(unresolvedRoot, (_, rest) => `from '${specifierFor(current, join(dir, ...rest.split(/[\\/]/)))}'`);
    if (fixed === contents) continue;
    writeFileSync(path, fixed);
    console.log(`fixed codegen import in ${relative(dir, path)}`);
  }
}

fixDir(dir);
