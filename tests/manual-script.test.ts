import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openInBrowser, retryBaseReset } from '../scripts/manual.js';

test('openInBrowser hands the address to the protocol handler as one argument, with no shell (Codex HTTP audit)', () => {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const spawn = (command: string, args: string[], options: object) => {
    calls.push({ command, args, options: options as Record<string, unknown> });
    return {
      unref() {},
      on(_event: 'error', listener: (err: Error) => void) {
        errorListeners.push(listener);
        return this;
      },
    };
  };
  // cmd's start expanded %VARIABLE% inside the address; nothing here goes through a shell.
  openInBrowser('https://help.example/page?q=%PM_AUDIT_MARKER%&t=1', { spawn, platform: 'win32' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, 'rundll32.exe');
  assert.deepEqual(calls[0]!.args, ['url.dll,FileProtocolHandler', 'https://help.example/page?q=%PM_AUDIT_MARKER%&t=1']);
  assert.equal(calls[0]!.options.shell, undefined);
  assert.equal(calls[0]!.options.windowsVerbatimArguments, undefined);
  // Raw quotes and spaces reach it percent-encoded, never as argument syntax.
  openInBrowser('https://help.example/a b"c', { spawn, platform: 'win32' });
  assert.equal(calls[1]!.args[1], 'https://help.example/a%20b%22c');
  // Only web addresses: no file paths, other protocols, or plain http to another host.
  for (const bad of ['file:///C:/Windows/System32/calc.exe', String.raw`C:\Windows\notepad.exe`, 'javascript:alert(1)', 'http://example.com/']) openInBrowser(bad, { spawn, platform: 'win32' });
  assert.equal(calls.length, 2);
  openInBrowser('http://127.0.0.1:47813/?t=abc', { spawn, platform: 'linux' });
  assert.deepEqual([calls[2]!.command, calls[2]!.args], ['xdg-open', ['http://127.0.0.1:47813/?t=abc']]);
  // Every opener gets an error listener, so one that cannot start is logged instead of ending the process.
  assert.equal(errorListeners.length, 3);
  assert.doesNotThrow(() => errorListeners[2]!(new Error('spawn xdg-open ENOENT')));
});

test('retryBaseReset drops this save\'s own commit and moves to the new main (Codex probe 7)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-retry-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const commit = (file: string) => {
      writeFileSync(path.join(dir, file), file);
      git('add', '.');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', file);
    };
    git('init', '-q', '-b', 'main');
    commit('base.txt');
    const base = git('rev-parse', 'HEAD');
    git('branch', 'upstream');
    commit('reading.txt'); // the save's own commit
    git('checkout', '-q', 'upstream');
    commit('upstream.txt'); // main moved while the pages were being read
    const upstream = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    git('fetch', '-q', '.', 'upstream');
    assert.equal(retryBaseReset(git, base), upstream);
    assert.equal(git('rev-parse', 'HEAD'), upstream);

    // Anything but "old base plus one commit" is left alone: here a second, foreign commit.
    commit('mine.txt');
    commit('someone-else.txt');
    git('fetch', '-q', '.', 'upstream');
    assert.throws(() => retryBaseReset(git, upstream), /not main plus this save's own commit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
