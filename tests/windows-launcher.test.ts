import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Exercise the actual batch file, stopping at its lock gate before any Git/network operation.
for (const stale of [false, true]) test(`Windows launcher refuses a ${stale ? 'stale nonempty' : 'fresh'} lock in a Unicode path`, { skip: process.platform !== 'win32' }, () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pm-launcher-'));
  const dir = path.join(parent, 'Türkçe path !');
  mkdirSync(dir);
  const lock = path.join(dir, 'run-lock');
  mkdirSync(lock);
  if (stale) {
    // A nonempty directory cannot be removed by plain rmdir; the launcher must not claim it was.
    writeFileSync(path.join(lock, 'held'), 'fixture');
    const old = new Date(Date.now() - 4 * 3600_000);
    utimesSync(lock, old, old);
  }
  const template = readFileSync(new URL('../scripts/residential-launch.cmd', import.meta.url), 'utf8');
  writeFileSync(path.join(dir, 'residential-launch.cmd'), template.replace(/\r?\n/g, '\r\n'), 'ascii');
  try {
    const run = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', '.\\residential-launch.cmd'], {
      cwd: dir, encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 3, run.stderr);
    assert.ok(existsSync(lock));
    assert.match(readFileSync(path.join(dir, 'refused.log'), 'utf8'), /another run held the lock/);
    if (stale) {
      const log = readFileSync(path.join(dir, 'residential.log'), 'utf8');
      assert.match(log, /could not remove the stale lock/);
      assert.doesNotMatch(log, /removed a lock/);
    } else assert.equal(existsSync(path.join(dir, 'residential.log')), false);
    assert.equal(existsSync(path.join(dir, 'checkout')), false);
  } finally {
    assert.equal(path.dirname(parent), path.resolve(tmpdir()));
    rmSync(parent, { recursive: true, force: true });
  }
});
