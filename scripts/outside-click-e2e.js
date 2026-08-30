// outside-click-e2e.js — ISOLATED end-to-end runtime test (NOT part of the product).
// Uses the REAL src/mouse-observer.js, REAL preload.js and REAL renderer files,
// with the exact live window geometry from the user's settings
// (windowX=-400 windowY=36 windowWidth=1536 windowHeight=608) then fires REAL
// Win32 clicks (SetCursorPos + mouse_event) exactly like a human click.
//
// Run:  node_modules\.bin\electron scripts\outside-click-e2e.js
'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const koffi = require('koffi');

const mouseObserver = require('../src/mouse-observer');

const user32 = koffi.load('user32.dll');
const SetCursorPos = user32.func('SetCursorPos', 'bool', ['int', 'int']);
const mouse_event = user32.func('mouse_event', 'void', ['int', 'int', 'int', 'int', 'int']);
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const VK_A = 0x41;
const keybd_event = user32.func('keybd_event', 'void', ['int', 'int', 'int', 'int']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null;
let outsideRegion = null; // { rects: [...] } as the fixed main.js stores it

app.setPath('userData', path.join(app.getPath('temp'), 'cue-e2e-' + Date.now()));

// ---- minimal IPC surface the real renderer uses during boot + reveal ----
ipcMain.handle('settings:get', () => ({ smart: false, onboarded: true, provider: 'openai', apiKeys: {} }));
ipcMain.handle('settings:set', (_e, p) => p);
ipcMain.handle('platform:info', () => ({ platform: process.platform, winBuild: 0, winSupportsContentProtection: true }));
ipcMain.handle('capture:state', () => ({ active: false, streaming: false, mode: 'assist' }));
ipcMain.handle('whisper:models', () => []);
ipcMain.handle('applink:state', () => ({}));
ipcMain.handle('window:getSize', () => (win && !win.isDestroyed()) ? win.getSize() : [700, 600]);
ipcMain.handle('window:setSize', (_e, w, h) => { if (win && !win.isDestroyed()) win.setSize(w, h); });
ipcMain.handle('transcript:clear', () => ({ ok: true }));
ipcMain.on('log', (_e, m) => console.log('[renderer]', m));
ipcMain.on('mouse:ignore', () => {});
ipcMain.on('app:quit', () => {});
ipcMain.on('window:setBounds', (_e, b) => { if (win && !win.isDestroyed()) win.setBounds(b, false); });
ipcMain.on('window:setPosition', (_e, p) => { if (win && !win.isDestroyed()) win.setPosition(p.x, p.y); });
ipcMain.on('window:drag-start', () => {});
ipcMain.on('window:move', () => {});
ipcMain.on('window:drag-end', () => {});
ipcMain.on('window:outside-region', (_e, r) => { outsideRegion = r; });
ipcMain.on('window:hide', () => {
  if (mouseObserver.isRunning()) mouseObserver.stop();
  if (win && !win.isDestroyed()) win.hide();
  console.log('[e2e] window hidden via renderer window:hide (blur path)');
});

// ---- same observer wiring as the fixed main.js revealAnswer() ----
function startObserver() {
  if (mouseObserver.isRunning()) { mouseObserver.rearm(); return; }
  mouseObserver.start(
    () => {
      if (!win || win.isDestroyed()) return null;
      const b = win.getBounds();
      const d = screen.getDisplayMatching(b);
      const scale = d.scaleFactor || 1;
      if (outsideRegion && outsideRegion.rects && outsideRegion.rects.length) {
        const rects = [];
        for (const rr of outsideRegion.rects) {
          const l = Math.max(b.x, b.x + rr.x) * scale;
          const t = Math.max(b.y, b.y + rr.y) * scale;
          const ri = Math.min(b.x + b.width, b.x + rr.x + rr.width) * scale;
          const bo = Math.min(b.y + b.height, b.y + rr.y + rr.height) * scale;
          if (ri > l && bo > t) rects.push({ left: Math.round(l), top: Math.round(t), right: Math.round(ri), bottom: Math.round(bo) });
        }
        if (rects.length) return { rects };
      }
      return { x: b.x, y: b.y, width: b.width, height: b.height, scale };
    },
    () => {
      if (mouseObserver) mouseObserver.stop();
      if (win && !win.isDestroyed()) win.hide();
      console.log('[e2e] window hidden via OBSERVER (outside click)');
    }
  );
}

function reveal() {
  win.showInactive();
  win.webContents.send('window:reveal', {});
  startObserver();
  console.log('[e2e] revealed (showInactive + observer started)');
}

function clickAt(x, y) {
  SetCursorPos(x, y);
  sleep(60).then(() => {
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    return sleep(60);
  }).then(() => {
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
  });
  console.log(`[e2e] sent real click at physical (${x}, ${y})`);
}
async function elementCenterPhysical(sel) {
  const r = await win.webContents.executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
  if (!r) return null;
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b);
  const s = d.scaleFactor || 1;
  return {
    x: Math.round((b.x + r.left + r.width / 2) * s),
    y: Math.round((b.y + r.top + r.height / 2) * s)
  };
}

let failures = 0;
function check(label, cond) {
  console.log(`[e2e] ${cond ? 'PASS' : 'FAIL'} — ${label}`);
  if (!cond) failures++;
}

app.whenReady().then(async () => {
  const GEOM = { x: -400, y: 36, width: 1536, height: 608 };
  win = new BrowserWindow({
    width: GEOM.width, height: GEOM.height, x: GEOM.x, y: GEOM.y,
    frame: false, transparent: true, hasShadow: false, resizable: true,
    skipTaskbar: true, alwaysOnTop: true, fullscreenable: false, show: false,
    minWidth: 380, minHeight: 280, type: 'toolbar',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  win.on('blur', () => { win.webContents.send('window:blur', {}); });
  win.on('focus', () => { if (mouseObserver.isRunning()) mouseObserver.stop(); });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await sleep(700); // renderer boot
  console.log(`[e2e] window bounds (DIP): ${JSON.stringify(win.getBounds())}`);
  console.log(`[e2e] initial region: ${JSON.stringify(outsideRegion)}`);

  // ---- Round 1: reveal -> click INSIDE the answer panel -> must stay visible ----
  reveal();
  await sleep(900); // let the renderer receive reveal and re-sync the region
  console.log(`[e2e] region after reveal: ${JSON.stringify(outsideRegion)}`);
  const panelCenter = await elementCenterPhysical('#panel-wrap');
  console.log(`[e2e] panel center physical: ${JSON.stringify(panelCenter)}`);
  clickAt(panelCenter.x, panelCenter.y);
  await sleep(700);
  check('Round1: Cue stays visible after clicking the answer panel', win.isVisible());

  // ---- Round 2: reveal -> click at the user's exact reported point (1345,655) ----
  reveal();
  await sleep(900);
  clickAt(1345, 655); // inside HWND, outside the visible panel
  await sleep(900);
  check('Round2: Cue HIDES on the FIRST click right of the panel (1345,655)', !win.isVisible());

  // ---- Round 3: reveal -> click input -> type -> stays visible ----
  reveal();
  await sleep(900);
  const inputCenter = await elementCenterPhysical('#input');
  console.log(`[e2e] input center physical: ${JSON.stringify(inputCenter)}`);
  clickAt(inputCenter.x, inputCenter.y);
  await sleep(700);
  keybd_event(VK_A, 0, 0, 0); keybd_event(VK_A, 0, 2, 0); // 'a' (down+up)
  await sleep(150);
  const inputValue = await win.webContents.executeJavaScript('document.getElementById("input").value');
  console.log(`[e2e] input value after typing: "${inputValue}"`);
  check('Round3: Cue stays visible after clicking input + typing', win.isVisible());
  check('Round3: typing reached the focused textarea', inputValue === 'a');

  // ---- Round 4: inside click (focus) then outside click -> hide on FIRST outside ----
  reveal();
  await sleep(900);
  clickAt(panelCenter.x, panelCenter.y); // inside -> focus
  await sleep(700);
  clickAt(1345, 655); // outside the visible panel (blur path after focus)
  await sleep(900);
  check('Round4: Cue hides on the FIRST outside click after an inside click', !win.isVisible());

  console.log(`[e2e] ${failures === 0 ? 'ALL E2E CHECKS PASSED' : failures + ' E2E CHECK(S) FAILED'}`);
  app.exit(failures === 0 ? 0 : 1);
});