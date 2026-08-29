const { contextBridge, ipcRenderer } = require('electron');
const platform = process.platform;

contextBridge.exposeInMainWorld('cue', {
  platform,
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  whisperModels: () => ipcRenderer.invoke('whisper:models'),
  whisperModelDownload: (modelId) => ipcRenderer.invoke('whisper:model-download', modelId),
  whisperModelCancel: (modelId) => ipcRenderer.invoke('whisper:model-cancel', modelId),
  whisperModelDelete: (modelId) => ipcRenderer.invoke('whisper:model-delete', modelId),
  whisperModelImport: (modelId) => ipcRenderer.invoke('whisper:model-import', modelId),
  platformInfo: () => ipcRenderer.invoke('platform:info'),
  ask: (payload) => ipcRenderer.send('ask', payload),
  captureToggle: () => ipcRenderer.invoke('capture:toggle').catch((err) => {
    console.error('[cue] captureToggle error', err);
    return false;
  }),
  captureState: () => ipcRenderer.invoke('capture:state'),
  micPcm: (arrayBuffer) => ipcRenderer.send('mic:pcm', arrayBuffer),
  systemPcm: (arrayBuffer) => ipcRenderer.send('system:pcm', arrayBuffer),
  // Phase 3: setIgnoreMouse removed — window always receives mouse input.
  hideWindow: () => ipcRenderer.send('window:hide'),
  setRegime: (regime) => ipcRenderer.send(regime === 'interactive' ? 'window:enter-interactive' : 'window:enter-passive'),
  getWindowSize: () => ipcRenderer.invoke('window:getSize'),
  setWindowSize: (w, h) => ipcRenderer.invoke('window:setSize', w, h),
  setBounds: (b) => ipcRenderer.send('window:setBounds', b),
  setPosition: (pos) => ipcRenderer.send('window:setPosition', pos),
  dragStart: () => ipcRenderer.send('window:drag-start'),
  moveWindow: (pos) => ipcRenderer.send('window:move', pos),
  dragEnd: () => ipcRenderer.send('window:drag-end'),
  clearTranscript: () => ipcRenderer.invoke('transcript:clear'),
  openPane: (url) => ipcRenderer.send('open-pane', url),
  appLinkState: () => ipcRenderer.invoke('applink:state'),
  appLinkRevoke: (callerId) => ipcRenderer.invoke('applink:revoke', callerId),
  appLinkConsentRespond: (id, allowed) => ipcRenderer.send('applink:consent-response', { id, allowed }),
  pickProfileDocument: () => ipcRenderer.invoke('profile:pickDocument'),
  quit: () => ipcRenderer.send('app:quit'),
  permissionsCheck: () => ipcRenderer.invoke('permissions:check'),
  permissionsRequest: () => ipcRenderer.invoke('permissions:request'),
  permissionsContinue: () => ipcRenderer.send('permissions:continue'),
  log: (msg) => ipcRenderer.send('log', msg),
  on: (channel, cb) => {
    const allowed = ['capture:state', 'llm:start', 'llm:token', 'llm:done', 'llm:error', 'status', 'transcript', 'stt:interim', 'stt:final', 'stt:status', 'vad:state', 'applink:consent-request', 'window:reveal', 'window:regime', 'whisper:download-progress', 'whisper:models-changed'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
