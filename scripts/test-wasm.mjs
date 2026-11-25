import { access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const goroot = execFileSync('go', ['env', 'GOROOT'], { cwd: root, encoding: 'utf8' }).trim();
let runner = join(goroot, 'lib/wasm/go_js_wasm_exec');
try { await access(runner); } catch { runner = join(goroot, 'misc/wasm/go_js_wasm_exec'); }
// Go/WASM has a small startup argv/environment area. npm and CI inject many
// unrelated variables; only the toolchain, home and temporary paths are needed.
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'GOROOT', 'GOPATH', 'GOCACHE', 'GOTOOLCHAIN']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
execFileSync('go', ['test', '-exec', runner, './cmd/pipe-go-doep-wasm'], {
  cwd: root, env: { ...env, GOOS: 'js', GOARCH: 'wasm' }, stdio: 'inherit',
});
