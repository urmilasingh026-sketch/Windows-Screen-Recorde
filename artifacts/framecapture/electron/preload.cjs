const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("frameCapture", {
  getSources: () => ipcRenderer.invoke("capture:get-sources"),
  selectSource: (sourceId) =>
    ipcRenderer.invoke("capture:select-source", sourceId),
  getOutputDirectory: () =>
    ipcRenderer.invoke("settings:get-output-directory"),
  getWindowsCursorSettings: () =>
    ipcRenderer.invoke("settings:get-windows-cursor"),
  setWindowsCursorStyle: (style) =>
    ipcRenderer.invoke("settings:set-windows-cursor", style),
  chooseOutputDirectory: () =>
    ipcRenderer.invoke("settings:choose-output-directory"),
  listRecordings: () => ipcRenderer.invoke("recordings:list"),
  revealRecording: (filePath) =>
    ipcRenderer.invoke("recordings:reveal", filePath),
  beginRecording: (name) => ipcRenderer.invoke("recording:begin", name),
  writeRecordingChunk: (id, chunk) =>
    ipcRenderer.invoke("recording:write-chunk", id, chunk),
  finishRecording: (id, durationSeconds) =>
    ipcRenderer.invoke("recording:finish", id, durationSeconds),
  cancelRecording: (id) => ipcRenderer.invoke("recording:cancel", id),
  openAnnotationOverlay: (sourceId) =>
    ipcRenderer.invoke("annotation:open", sourceId),
  closeAnnotationOverlay: () => ipcRenderer.invoke("annotation:close"),
  onExportProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("recording:export-progress", listener);
    return () =>
      ipcRenderer.removeListener("recording:export-progress", listener);
  },
  reportRecordingState: (state, elapsedSeconds, status, error) =>
    ipcRenderer.send("recording:state", { state, elapsedSeconds, status, error }),
  rendererReady: () => ipcRenderer.send("recording:renderer-ready"),
  onRecordingControl: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on("recording:control", listener);
    return () => ipcRenderer.removeListener("recording:control", listener);
  },
});
