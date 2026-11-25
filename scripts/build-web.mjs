import { cp, mkdir, readdir, rm, access, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const staticDir = join(dist, 'static');
await rm(dist, { recursive: true, force: true });
await mkdir(staticDir, { recursive: true });
await mkdir(join(dist, 'examples'), { recursive: true });
await cp(join(root, 'internal/workbench/index.html'), join(dist, 'index.html'));
const sourceStatic = join(root, 'internal/workbench/static');
for (const entry of await readdir(sourceStatic, { withFileTypes: true })) {
  if (entry.isFile() && /\.(js|css)$/.test(entry.name) && !/\.(test|spec|browser)\./.test(entry.name)) {
    await cp(join(sourceStatic, entry.name), join(staticDir, entry.name));
  }
}
const examples = (await readdir(join(root, 'examples'), { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name).sort();
for (const name of examples) await cp(join(root, 'examples', name), join(dist, 'examples', name));
await writeFile(join(dist, 'examples/index.json'), `${JSON.stringify(examples)}\n`);

execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', join(staticDir, 'synth.wasm'), './cmd/pipe-go-doep-wasm'], {
  cwd: root, env: { ...process.env, GOOS: 'js', GOARCH: 'wasm' }, stdio: 'inherit',
});
const goroot = execFileSync('go', ['env', 'GOROOT'], { cwd: root, encoding: 'utf8' }).trim();
let wasmExec = join(goroot, 'lib/wasm/wasm_exec.js');
try { await access(wasmExec); } catch { wasmExec = join(goroot, 'misc/wasm/wasm_exec.js'); }
await cp(wasmExec, join(staticDir, 'wasm_exec.js'));
console.log(`Built static browser workbench in ${dist}`);
