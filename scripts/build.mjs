import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// npm may visit a parent workspace before its nested libraries.
// The root manifest explicitly lists workspaces in dependency order.
const { workspaces } = JSON.parse(readFileSync('package.json', 'utf8'));
if (!process.env.npm_execpath) throw new Error('Run this script with npm run build.');
for (const workspace of workspaces) {
  execFileSync(process.execPath, [process.env.npm_execpath, 'run', 'build', '--workspace', workspace], {
    stdio: 'inherit',
  });
}
