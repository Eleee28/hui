import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from "vitest";
import { OWNER_MARKER } from './install.mjs';
import { launchDesktop } from './launch.mjs';

function recorder({ fail = false } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.unref = () => { child.unrefed = true; };
    calls.push({ command, args, options, child });
    setImmediate(() => fail ? child.emit('error', new Error('ENOENT')) : child.emit('spawn'));
    return child;
  };
  return { calls, spawnImpl };
}

async function applications(t, owner) {
  const dir = await mkdtemp(join(tmpdir(), 'hui-launch-'));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  if (owner !== undefined) {
    await mkdir(join(dir, 'HUI.app/Contents/Resources'), { recursive: true });
    await writeFile(join(dir, 'HUI.app/Contents/Resources/hui-owner'), owner);
  }
  return dir;
}

test('macOS opens the registered HUI.app and returns the terminal', async (t) => {
  const { calls, spawnImpl } = recorder();
  const dir = await applications(t, OWNER_MARKER);
  const result = await launchDesktop('/pkg', { platform: 'darwin', applications: dir, spawnImpl, electron: () => assert.fail('no Electron') });
  assert.equal(result, 'app');
  assert.equal(calls[0].command, '/usr/bin/open');
  assert.deepEqual(calls[0].args, [join(dir, 'HUI.app')]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].child.unrefed, true);
});

test('without an owned bundle, Electron is started detached and a Spotlight hint is shown on macOS', async (t) => {
  for (const owner of [undefined, 'someone.else']) {
    const { calls, spawnImpl } = recorder();
    const logs = [];
    const dir = await applications(t, owner);
    const result = await launchDesktop('/pkg', { platform: 'darwin', applications: dir, spawnImpl, electron: () => '/electron', log: (line) => logs.push(line) });
    assert.equal(result, 'electron');
    assert.equal(calls[0].command, '/electron');
    assert.match(calls[0].args[0], /desktop\/main\.cjs$/);
    assert.equal(calls[0].options.detached, true);
    assert.equal(JSON.parse(calls[0].options.env.HUI_DESKTOP_LAUNCH).root, '/pkg');
    assert.equal(calls[0].child.unrefed, true);
    assert.match(logs.join('\n'), /hui install-app/);
  }
});

test('other platforms launch Electron without the macOS hint; spawn failures surface', async (t) => {
  const dir = await applications(t, OWNER_MARKER);
  const ok = recorder();
  const logs = [];
  assert.equal(await launchDesktop('/pkg', { platform: 'linux', applications: dir, spawnImpl: ok.spawnImpl, electron: () => '/electron', log: (l) => logs.push(l) }), 'electron');
  assert.deepEqual(logs, []);
  const failing = recorder({ fail: true });
  await assert.rejects(launchDesktop('/pkg', { platform: 'linux', applications: dir, spawnImpl: failing.spawnImpl, electron: () => '/electron' }), /ENOENT/);
});
