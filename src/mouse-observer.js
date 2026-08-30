// mouse-observer.js — Detects outside clicks using GetAsyncKeyState polling.
// NO hooks, NO SetWindowsHookEx, NO PowerShell, NO cursor manipulation.
// Just reads Windows key state and cursor position via FFI.

'use strict';

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');

// Struct definitions
const POINT = koffi.struct('ObsPOINT', { x: 'int32', y: 'int32' });
const RECT = koffi.struct('ObsRECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });

// Win32 API bindings
const GetAsyncKeyState = user32.func('GetAsyncKeyState', 'int16', ['int']);
const GetCursorPos = user32.func('GetCursorPos', 'bool', [koffi.out(koffi.pointer(POINT))]);

const VK_LBUTTON = 0x01;
const POLL_MS = 16; // ~60fps — fast enough to catch every click

let timer = null;
let prevState = 0;
let callback = null;
let boundsFn = null; // function returning {x, y, width, height, scale}
let fired = false;   // prevents multiple firings until re-armed

function poll() {
  try {
    const state = GetAsyncKeyState(VK_LBUTTON);
    const pressed = (state & 0x8000) !== 0;

    if (pressed && !prevState && !fired) {
      // Falling edge = button-down detected.
      // koffi marshals a plain JS object for an _Out_ POINT*, filling x/y in place.
      const pt = {};
      if (!GetCursorPos(pt)) { prevState = pressed; return; }

      const bounds = boundsFn ? boundsFn() : null;
      const hasRects = !!(bounds && bounds.rects && bounds.rects.length);
      if (!bounds || (!hasRects && (!bounds.width || !bounds.height))) { prevState = pressed; return; }

      let inside = false;

      if (hasRects) {
        // The visible-overlay path: boundsFn returns PHYSICAL {left,top,right,bottom}
        // rects for each visible Cue UI block. A click is INSIDE when it lands in
        // ANY of them (a single bounding union would swallow the gaps between
        // disjoint overlay pieces such as a floating transcript sidebar).
        for (const r of bounds.rects) {
          if (pt.x >= r.left && pt.x < r.right && pt.y >= r.top && pt.y < r.bottom) inside = true;
        }
      } else {
        // Whole-window fallback: bounds are DIP; convert to physical screen pixels.
        const scale = bounds.scale || 1;
        const left = Math.round(bounds.x * scale);
        const top = Math.round(bounds.y * scale);
        const right = Math.round((bounds.x + bounds.width) * scale);
        const bottom = Math.round((bounds.y + bounds.height) * scale);
        inside = pt.x >= left && pt.x < right && pt.y >= top && pt.y < bottom;
      }

      if (!inside) {
        fired = true; // prevent multiple firings
        if (callback) callback(pt.x, pt.y);
      }
    }

    prevState = pressed;
  } catch (err) {
    console.error(`[cue-obs] error: ${err.message}`);
    // Stop the observer cleanly to prevent repeated crash cycles
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    boundsFn = null;
    callback = null;
    fired = false;
    prevState = 0;
  }
}

module.exports = {
  start(bounds, cb) {
    this.stop();
    boundsFn = bounds;
    callback = cb;
    fired = false;
    // Initialize prev state so we don't fire on button already held
    prevState = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0;
    timer = setInterval(poll, POLL_MS);
  },

  stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    boundsFn = null;
    callback = null;
    fired = false;
    prevState = 0;
  },

  // Re-arm after a hide+reveal cycle so the next outside click is detected
  rearm() {
    fired = false;
  },

  isRunning() {
    return timer !== null;
  }
};
