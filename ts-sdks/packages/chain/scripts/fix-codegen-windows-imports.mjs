import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';

// @mysten/codegen (as of 0.12.19) computes each generated module's relative
// import to contracts/utils using OS path separators without normalizing to
// POSIX for the ESM import specifier, so on Windows it emits literal
// backslashes glued onto a bogus "./src\contracts\utils\index.js" path
// instead of "../utils/index.js". Node's ESM resolver rejects backslashes
// outright, so every generated module fails to import until this runs.
// Re-run after every `npm run codegen` (the codegen script already does).
const dir = new URL('../src/contracts/octap', import.meta.url).pathname.replace(/^\/([a-zA-Z]):/, '$1:');
const broken = /from ['"]\.\/[^'"]*utils[\\/]index\.js['"]/;

for (const file of readdirSync(dir)) {
  if (!file.endsWith('.ts')) continue;
  const path = join(dir, file);
  const contents = readFileSync(path, 'utf8');
  if (!broken.test(contents)) continue;
  const fixed = contents.replace(broken, "from '../utils/index.js'");
  writeFileSync(path, fixed);
  console.log(`fixed codegen import in ${file}`);
}
