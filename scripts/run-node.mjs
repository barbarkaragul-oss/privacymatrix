// Use the operating system's trusted roots as well as Node's bundled roots. TLS verification
// stays enabled. This matters on Windows installations with an authorised HTTPS inspection CA.
import { spawn } from 'node:child_process';
const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 19) || (major === 24 && minor >= 6) || major > 24)) {
  console.error('Network commands require Node 22.19+ (22.x) or 24.6+ for NODE_USE_SYSTEM_CA.');
  process.exit(1);
}
const child = spawn(process.execPath, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA ?? '1' },
});
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
