import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installMacApp, launchConfig, macSigningCommands, shouldInstallAutomatically, updatePlist } from './install.mjs';
import { appIcon } from './icon.mjs';
import policy from './policy.cjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hui-app-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const electronApp = join(root, 'Electron.app');
  await mkdir(join(electronApp, 'Contents/Resources'), { recursive: true });
  await mkdir(join(electronApp, 'Contents/MacOS'), { recursive: true });
  await writeFile(join(electronApp, 'Contents/Info.plist'), '<plist><dict><key>CFBundleExecutable</key><string>Electron</string><key>CFBundleName</key><string>Electron</string></dict></plist>');
  await writeFile(join(electronApp, 'Contents/MacOS/Electron'), 'binary fixture', { mode: 0o755 });
  await writeFile(join(electronApp, 'Contents/Resources/default_app.asar'), 'default');
  return { applications: join(root, 'Applications with spaces'), electronApp, config: { root: join(root, "npm's package"), node: '/node path/node', searchPath: '/bin:/node path' } };
}

test('macOS install creates a discoverable bundle and updates only owned apps', async (t) => {
  const options = await fixture(t);
  const installed = await installMacApp(options);
  const webIcon = await readFile(new URL('../public/pi-logo-3d.png', import.meta.url));
  const icns = await readFile(join(installed, 'Contents/Resources/hui.icns'));
  assert.equal(icns.subarray(0, 4).toString(), 'icns');
  assert.equal(icns.subarray(8, 12).toString(), 'ic09');
  assert.ok(icns.subarray(16).equals(webIcon), 'the bundle embeds the web app icon byte for byte');
  const plist = await readFile(join(installed, 'Contents/Info.plist'), 'utf8');
  assert.match(plist, /<key>CFBundleName<\/key><string>HUI<\/string>/);
  assert.match(plist, /<key>CFBundleIdentifier<\/key><string>org.harnessui.desktop<\/string>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>Electron<\/string>/);
  assert.deepEqual(JSON.parse(await readFile(join(installed, 'Contents/Resources/app/launch.json'), 'utf8')), options.config);
  const main = await readFile(join(installed, 'Contents/Resources/app/main.cjs'), 'utf8');
  assert.equal(main, await readFile(new URL('./main.cjs', import.meta.url), 'utf8'));
  assert.equal(await readFile(join(installed, 'Contents/Resources/app/policy.cjs'), 'utf8'), await readFile(new URL('./policy.cjs', import.meta.url), 'utf8'));
  await assert.rejects(readFile(join(installed, 'Contents/Resources/default_app.asar')), { code: 'ENOENT' });
  await installMacApp({ ...options, version: '1.2.3' });
  assert.match(await readFile(join(installed, 'Contents/Info.plist'), 'utf8'), /<string>1.2.3<\/string>/);
});

test('failed signing keeps the previous app intact', async (t) => {
  const options = await fixture(t);
  const installed = await installMacApp(options);
  await assert.rejects(installMacApp({ ...options, version: '9.0.0', finalize() { throw new Error('signing failed'); } }), /signing failed/);
  assert.match(await readFile(join(installed, 'Contents/Info.plist'), 'utf8'), /<string>0.0.0<\/string>/);
});

test('foreign apps and symlinks are not replaced', async (t) => {
  const options = await fixture(t);
  const destination = join(options.applications, 'HUI.app');
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'keep'), 'user data');
  await assert.rejects(installMacApp(options), /Refusing to replace/);
  assert.equal(await readFile(join(destination, 'keep'), 'utf8'), 'user data');
  const other = { ...options, applications: join(options.applications, 'other') };
  await mkdir(other.applications);
  await symlink(destination, join(other.applications, 'HUI.app'));
  await assert.rejects(installMacApp(other), /Refusing to replace/);
});

test('launch metadata excludes credentials and plist edits are idempotent', async () => {
  assert.deepEqual(Object.keys(launchConfig()).sort(), ['node', 'root', 'searchPath']);
  const plist = '<plist><dict></dict></plist>';
  assert.equal(updatePlist(updatePlist(plist, '1.0.0'), '1.0.0'), updatePlist(plist, '1.0.0'));
  const { png, icns } = appIcon(await readFile(new URL('../public/pi-logo-3d.png', import.meta.url)));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(icns.subarray(0, 4).toString(), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  assert.ok(icns.subarray(16).equals(png));
  assert.throws(() => appIcon(Buffer.alloc(24)), /not a PNG/);
  const resized = Buffer.from(png.subarray(0, 24));
  resized.writeUInt32BE(300, 16);
  assert.throws(() => appIcon(Buffer.concat([resized, png.subarray(24)])), /square/);
});

test('desktop navigation remains local and external launching rejects executable protocols', () => {
  const origin = 'http://127.0.0.1:5174';
  assert.equal(policy.isInternal(`${origin}/sessions`, origin), true);
  for (const url of ['http://127.0.0.1:5175/', 'https://127.0.0.1:5174', 'https://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'not a URL']) assert.equal(policy.isInternal(url, origin), false);
  for (const url of ['https://example.com', 'http://example.com', 'mailto:user@example.com']) assert.equal(policy.isExternal(url), true);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'hui:run', 'not a URL']) assert.equal(policy.isExternal(url), false);
});

test('automatic registration runs only for non-opted-out global macOS installs', () => {
  assert.equal(shouldInstallAutomatically('darwin', { npm_config_global: 'true' }), true);
  assert.equal(shouldInstallAutomatically('darwin', {}), false);
  assert.equal(shouldInstallAutomatically('linux', { npm_config_global: 'true' }), false);
  assert.equal(shouldInstallAutomatically('darwin', { npm_config_global: 'true', HUI_SKIP_APP_INSTALL: '1' }), false);
});

test('desktop uses only a running gateway address returned by the managed CLI', () => {
  assert.equal(policy.gatewayUrl(JSON.stringify({ status: 'running', url: 'http://127.0.0.1:4173' })), 'http://127.0.0.1:4173/');
  assert.equal(policy.gatewayUrl(JSON.stringify({ status: 'running', url: 'http://100.64.0.10:4173' })), 'http://100.64.0.10:4173/');
  for (const value of [{ status: 'stopped', url: 'http://127.0.0.1' }, { status: 'running', url: 'https://example.com' }, { status: 'running', url: 'file:///tmp/a' }]) assert.throws(() => policy.gatewayUrl(JSON.stringify(value)));
});

test('theme source accepts only Electron-supported modes', () => {
  assert.equal(policy.themeSource('light'), 'light');
  assert.equal(policy.themeSource('dark'), 'dark');
  for (const value of ['system', undefined, '', 'auto', 42]) assert.equal(policy.themeSource(value), 'system');
});

test('macOS signing seals nested Electron components before strict verification', () => {
  const [sign, verify] = macSigningCommands('/Apps/HUI.app');
  assert.deepEqual(sign, ['--force', '--deep', '--sign', '-', '--timestamp=none', '/Apps/HUI.app']);
  assert.deepEqual(verify, ['--verify', '--deep', '--strict', '/Apps/HUI.app']);
});
