/** Registers HUI as a macOS application. It assembles HUI.app from the bundled Electron with the window shell inside,
 * signs it ad hoc and only ever replaces a bundle HUI itself installed, recognized by its owner marker; the app keeps
 * launching the installed CLI. Runs from `hui install-app` and from postinstall on global npm installs on macOS. */
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { appIcon } from './icon.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
export const OWNER_MARKER = 'org.harnessui.desktop';
const marker = OWNER_MARKER;

export function launchConfig(packageRoot = root) {
  return { root: packageRoot, node: process.execPath, searchPath: process.env.PATH || '' };
}

/** The native app shares the web app's icon: the built favicon in an installed package, its source in a checkout. */
export async function webAppIconPng(packageRoot = root) {
  const candidates = [join(packageRoot, 'dist/pi-logo-3d.png'), join(packageRoot, 'public/pi-logo-3d.png')];
  for (const path of candidates) {
    const png = await readFile(path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    if (png) return png;
  }
  throw new Error(`Web app icon not found: expected ${candidates.join(' or ')}.`);
}

export function shouldInstallAutomatically(platform = process.platform, env = process.env) {
  return platform === 'darwin' && env.npm_config_global === 'true' && env.HUI_SKIP_APP_INSTALL !== '1';
}

/** Upstream Electron ships only linker signatures without sealed resources, so
 * re-signing just the outer bundle leaves Electron Framework.framework invalid
 * under strict verification. Ad-hoc sign every nested component, then verify. */
export function macSigningCommands(bundle) {
  return [
    ['--force', '--deep', '--sign', '-', '--timestamp=none', bundle],
    ['--verify', '--deep', '--strict', bundle],
  ];
}

export function updatePlist(plist, version) {
  const entries = { CFBundleDisplayName: 'HUI', CFBundleName: 'HUI', CFBundleIdentifier: marker, CFBundleIconFile: 'hui.icns', CFBundleShortVersionString: version, CFBundleVersion: version };
  for (const [key, value] of Object.entries(entries)) {
    const pattern = new RegExp(`<key>${key}</key>\\s*<string>[^<]*</string>`);
    const entry = `<key>${key}</key><string>${value}</string>`;
    plist = pattern.test(plist) ? plist.replace(pattern, entry) : plist.replace('</dict>', `${entry}</dict>`);
  }
  return plist;
}

/** Staging and ownership checks are testable without touching real applications. */
export async function installMacApp({ applications = join(homedir(), 'Applications'), electronApp, config = launchConfig(), version = '0.0.0', finalize = () => {}, icon }) {
  const { icns } = appIcon(icon ?? (await webAppIconPng()));
  await mkdir(applications, { recursive: true });
  const destination = join(applications, 'HUI.app');
  const previous = await lstat(destination).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  if (previous) {
    const owner = await readFile(join(destination, 'Contents/Resources/hui-owner'), 'utf8').catch(() => '');
    if (previous.isSymbolicLink() || owner !== marker) throw new Error(`Refusing to replace an application not installed by HUI: ${destination}`);
  }
  const staging = await mkdtemp(join(applications, '.hui-install-'));
  const candidate = join(staging, 'HUI.app');
  const backup = join(staging, 'previous.app');
  let preserveBackup = false;
  try {
    await cp(electronApp, candidate, { recursive: true, verbatimSymlinks: true });
    const resources = join(candidate, 'Contents/Resources');
    await rm(join(resources, 'default_app.asar'), { force: true });
    await mkdir(join(resources, 'app'), { recursive: true });
    await writeFile(join(resources, 'hui-owner'), marker);
    await writeFile(join(resources, 'hui.icns'), icns);
    await writeFile(join(resources, 'app/package.json'), JSON.stringify({ name: 'hui', productName: 'HUI', version, main: 'main.cjs' }));
    await writeFile(join(resources, 'app/launch.json'), JSON.stringify(config));
    // Keep the signed window shell inside the bundle; only the managed CLI
    // remains linked to the original installation and its active release.
    await cp(new URL('./main.cjs', import.meta.url), join(resources, 'app/main.cjs'));
    await cp(new URL('./policy.cjs', import.meta.url), join(resources, 'app/policy.cjs'));
    const plist = join(candidate, 'Contents/Info.plist');
    await writeFile(plist, updatePlist(await readFile(plist, 'utf8'), version));
    await finalize(candidate);
    if (previous) await rename(destination, backup);
    try { await rename(candidate, destination); }
    catch (error) {
      if (previous) {
        try { await rename(backup, destination); }
        catch (restoreError) {
          preserveBackup = true;
          throw new Error(`The previous app is preserved at ${backup}; restoration failed: ${restoreError.message}`, { cause: error });
        }
      }
      throw error;
    }
    return destination;
  } finally {
    if (!preserveBackup) await rm(staging, { recursive: true, force: true });
  }
}

export async function installApp(installationRoot = root) {
  if (process.platform !== 'darwin') {
    console.log('hui: system-app registration currently supports macOS; use hui desktop on this platform.');
    return;
  }
  const electron = require('electron');
  const electronApp = resolve(dirname(electron), '../..');
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const app = await installMacApp({ electronApp, version, config: launchConfig(installationRoot), finalize(candidate) {
    for (const args of macSigningCommands(candidate)) execFileSync('/usr/bin/codesign', args, { stdio: 'pipe' });
  } });
  const register = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  execFileSync(register, ['-f', app], { stdio: 'pipe' });
  console.log(`hui: installed ${app}. Open HUI from Spotlight or Finder.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const automatic = process.argv.includes('--postinstall');
  if (!automatic || shouldInstallAutomatically()) {
    try { await installApp(); }
    catch (error) {
      console.error(`hui: app registration failed: ${error.message}\nRun hui install-app to retry. The CLI remains installed.`);
      if (!automatic) process.exitCode = 1;
    }
  }
}
