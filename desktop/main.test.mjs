import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { test } from "vitest";
import policy from './policy.cjs';

async function shell(t, settings = { themeMode: 'system' }) {
  const app = new EventEmitter();
  const windows = [];
  const errors = [];
  const config = { root: '/fixture/package', node: '/fixture/node', searchPath: '/fixture/bin' };
  let launchArgs;
  let complete;
  let quits = 0;
  const nativeTheme = { shouldUseDarkColors: false, themeSource: 'dark' };
  const settingsRequests = [];
  let onSettingsCompleted;
  let applicationMenu;
  app.setName = app.setPath = () => {};
  app.getPath = () => '/fixture/home';
  app.requestSingleInstanceLock = () => true;
  app.whenReady = async () => {};
  app.quit = () => { quits++; };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.setVisualZoomLevelLimits = async (...limits) => { this.webContents.zoomLimits = limits; };
      this.webContents.session = {
        setPermissionRequestHandler(handler) { this.permission = handler; },
        webRequest: { onCompleted(filter, handler) { onSettingsCompleted = { filter, handler }; } },
      };
      this.webContents.getURL = () => 'http://127.0.0.1:5174/';
      windows.push(this);
    }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    show() { this.visible = true; }
    focus() { this.focused = true; }
    async loadURL(url) { this.url = url; }
  }
  const electron = { app, BrowserWindow: Window, dialog: { showErrorBox: (...args) => errors.push(args) }, Menu: { buildFromTemplate: (menu) => menu, setApplicationMenu(menu) { applicationMenu = menu; } }, nativeTheme, shell: { openExternal: async () => {} } };
  const modules = { electron, 'node:child_process': { execFile: (...args) => { launchArgs = args; complete = args[3]; } }, 'node:fs': {}, 'node:path': path, './policy.cjs': policy };
  t.onTestFinished(() => {});
  vm.runInNewContext(await readFile(new URL('./main.cjs', import.meta.url), 'utf8'), {
    require: (name) => modules[name], URL,
    fetch: async (url, init) => {
      settingsRequests.push({ url: String(url), headers: init.headers });
      if (settings instanceof Error) throw settings;
      return { ok: true, json: async () => settings };
    },
    process: { env: { HUI_DESKTOP_LAUNCH: JSON.stringify(config) }, argv: [] },
  });
  await new Promise(setImmediate);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
  return {
    app, windows, errors, launchArgs, nativeTheme, settingsRequests, settle,
    setSettings: (next) => { settings = next; },
    completeSettings: (method) => onSettingsCompleted.handler({ method }),
    settingsFilter: () => onSettingsCompleted.filter,
    complete: (...args) => complete(...args), quits: () => quits,
    menu: () => applicationMenu,
  };
}

test('desktop starts or reuses the managed gateway and keeps window lifecycle independent', async (t) => {
  const state = await shell(t);
  assert.equal(state.windows.length, 0);
  assert.equal(state.launchArgs[0], '/fixture/node');
  assert.deepEqual(Array.from(state.launchArgs[1]), ['/fixture/package/bin/hui.mjs', 'gateway', 'start', '--json']);
  assert.equal(state.launchArgs[2].env.PATH, '/fixture/bin');
  state.complete(null, JSON.stringify({ status: 'running', url: 'http://127.0.0.1:5174/' }));
  await state.settle();
  const window = state.windows[0];
  assert.equal(window.url, 'http://127.0.0.1:5174/');
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  state.app.emit('second-instance');
  assert.equal(window.focused, true);
  window.emit('closed');
  state.app.emit('window-all-closed');
  assert.equal(state.quits(), 0);
  state.app.emit('activate');
  assert.equal(state.windows.length, 2);
  state.app.quit();
  assert.equal(state.quits(), 1);
  assert.deepEqual(state.errors, []);
});

test('gateway startup failure is visible rather than loading an unrelated page', async (t) => {
  const state = await shell(t);
  state.complete(new Error('Gateway could not be authenticated'));
  await new Promise(setImmediate);
  assert.equal(state.windows.length, 0);
  assert.equal(state.errors.length, 1);
  assert.match(state.errors[0][1], /could not be authenticated/);
  assert.equal(state.quits(), 1);
});

test('clipboard writes and fullscreen stay local and other renderer permissions remain denied', async (t) => {
  const state = await shell(t);
  state.complete(null, JSON.stringify({ status: 'running', url: 'http://127.0.0.1:5174/' }));
  await state.settle();
  const contents = state.windows[0].webContents;
  let granted;
  contents.session.permission(contents, 'clipboard-sanitized-write', (value) => { granted = value; });
  assert.equal(granted, true);
  contents.session.permission(contents, 'fullscreen', (value) => { granted = value; });
  assert.equal(granted, true);
  contents.session.permission(contents, 'media', (value) => { granted = value; });
  assert.equal(granted, false);
  contents.session.permission({ getURL: () => 'https://example.com' }, 'clipboard-sanitized-write', (value) => { granted = value; });
  assert.equal(granted, false);
});

test('window color scheme follows the saved HUI mode, defaulting to the OS', async (t) => {
  const state = await shell(t);
  assert.equal(state.nativeTheme.themeSource, 'system');
  state.complete(null, JSON.stringify({ status: 'running', url: 'http://127.0.0.1:5174/' }));
  await state.settle();
  assert.equal(state.nativeTheme.themeSource, 'system');
  assert.equal(state.settingsRequests[0].url, 'http://127.0.0.1:5174/__hui/settings');
  assert.equal(state.settingsRequests[0].headers['x-hui'], '1');
  assert.equal(state.windows[0].options.backgroundColor, '#fafaf9');
  assert.deepEqual(Array.from(state.settingsFilter().urls), ['http://127.0.0.1:5174/__hui/settings']);

  state.setSettings({ themeMode: 'light' });
  state.completeSettings('GET');
  await state.settle();
  assert.equal(state.nativeTheme.themeSource, 'system', 'reads alone do not resync');
  state.completeSettings('PUT');
  await state.settle();
  assert.equal(state.nativeTheme.themeSource, 'light');

  state.setSettings({ themeMode: 'dark' });
  state.windows[0].emit('focus');
  await state.settle();
  assert.equal(state.nativeTheme.themeSource, 'dark');

  state.setSettings({ themeMode: 'bogus' });
  state.completeSettings('PUT');
  await state.settle();
  assert.equal(state.nativeTheme.themeSource, 'system');

  state.setSettings(new Error('offline'));
  state.completeSettings('PUT');
  await state.settle();
  assert.equal(state.nativeTheme.themeSource, 'system');
});

test('zoom follows macOS conventions: Cmd+= zooms in and trackpad pinch is enabled', async (t) => {
  const state = await shell(t);
  const view = state.menu().find((menu) => menu.label === 'View');
  const zoomIn = view.submenu.filter((item) => item.role === 'zoomIn');
  assert.equal(zoomIn.filter((item) => item.visible !== false).length, 1, 'one visible Zoom In entry');
  const equals = zoomIn.find((item) => item.accelerator === 'CommandOrControl+=');
  assert.equal(equals?.visible, false);
  assert.equal(equals?.acceleratorWorksWhenHidden, true);
  for (const role of ['resetZoom', 'zoomOut', 'reload', 'toggleDevTools', 'togglefullscreen']) {
    assert.ok(view.submenu.some((item) => item.role === role), `keeps ${role}`);
  }

  state.complete(null, JSON.stringify({ status: 'running', url: 'http://127.0.0.1:5174/' }));
  await state.settle();
  const contents = state.windows[0].webContents;
  assert.equal(contents.zoomLimits, undefined);
  contents.emit('did-finish-load');
  assert.deepEqual(Array.from(contents.zoomLimits), [1, 3]);
  contents.zoomLimits = undefined;
  contents.emit('did-finish-load');
  assert.deepEqual(Array.from(contents.zoomLimits), [1, 3], 'reapplied after reload');
});
