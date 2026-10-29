const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  screen,
  session,
  shell,
  Tray,
} = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const activeRecordings = new Map();
let mainWindow;
let recordingToolbarWindow;
let tray;
let isQuitting = false;
let rendererReady = false;
let queuedRecordingCommand;
let selectedSourceId;
let outputDirectory;
let annotationCanvasWindow;
let annotationToolbarWindow;
let latestRecordingState = {
  state: "idle",
  elapsedSeconds: 0,
  status: "Ready",
  error: "",
};

if (process.platform === "win32") {
  app.setName("FrameCapture");
  app.setAppUserModelId("app.framecapture.recorder");
}

const annotationTools = new Set([
  "cursor",
  "pen",
  "highlighter",
  "arrow",
  "rectangle",
  "spotlight",
]);

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

async function readSettings() {
  try {
    return JSON.parse(await fsp.readFile(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

async function saveSettings(settings) {
  await fsp.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fsp.writeFile(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
}

function safeRecordingName(value) {
  const stem = String(value || "Recording")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 90);

  return stem || "Recording";
}

function assertTrustedSender(event) {
  const senderUrl = event.senderFrame?.url || "";
  if (!senderUrl.startsWith("file://")) {
    throw new Error("This action is only available inside FrameCapture.");
  }
}

function sendExportProgress(progress) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("recording:export-progress", progress);
  }
}

async function getCaptureSources() {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 480, height: 270 },
    fetchWindowIcons: true,
  });

  const displays = screen.getAllDisplays();
  return sources.map((source) => {
    const type = source.id.startsWith("screen:") ? "screen" : "window";
    const display =
      type === "screen" && source.display_id
        ? displays.find(
            (candidate) => String(candidate.id) === source.display_id,
          )
        : undefined;
    return {
      id: source.id,
      name: source.name,
      type,
      thumbnail: source.thumbnail.toDataURL(),
      displayId: source.display_id || undefined,
      width: display
        ? Math.round(display.size.width * display.scaleFactor)
        : undefined,
      height: display
        ? Math.round(display.size.height * display.scaleFactor)
        : undefined,
    };
  });
}

function getFfmpegPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "ffmpeg.exe");
  }

  return path.join(__dirname, "../generated-artifacts/ffmpeg.exe");
}

function transcodeToMp4(inputPath, outputPath, durationMs) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-y",
      "-i",
      inputPath,
      "-c:v",
      "libx264",
      "-preset",
      "superfast",
      "-crf",
      "21",
      "-threads",
      String(Math.max(1, Math.floor(os.availableParallelism() / 2))),
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      "-progress",
      "pipe:1",
      "-nostats",
      outputPath,
    ];

    let outputTimeMs = 0;
    let settled = false;
    const processHandle = spawn(getFfmpegPath(), args, { windowsHide: true });

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    processHandle.once("error", fail);
    processHandle.stdout.setEncoding("utf8");
    processHandle.stdout.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        const match = line.match(/^out_time_ms=(\d+)/);
        if (match) {
          outputTimeMs = Number(match[1]) / 1000;
          const progress =
            durationMs > 0
              ? Math.min(99, Math.round((outputTimeMs / durationMs) * 100))
              : 0;
          sendExportProgress(progress);
        }
      }
    });

    let errorOutput = "";
    processHandle.stderr.setEncoding("utf8");
    processHandle.stderr.on("data", (chunk) => {
      errorOutput = `${errorOutput}${chunk}`.slice(-8000);
    });

    processHandle.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        sendExportProgress(100);
        resolve();
      } else {
        reject(
          new Error(
            errorOutput.trim() ||
              `FFmpeg exited with code ${code ?? "unknown"}.`,
          ),
        );
      }
    });
  });
}

function syncRecordingToolbarVisibility() {
  if (!recordingToolbarWindow || recordingToolbarWindow.isDestroyed()) return;
  if (annotationToolbarWindow && !annotationToolbarWindow.isDestroyed()) {
    recordingToolbarWindow.hide();
  } else if (!isQuitting) {
    recordingToolbarWindow.showInactive();
  }
}

function destroyAnnotationOverlays(restoreRecordingToolbar = true) {
  const windows = [annotationToolbarWindow, annotationCanvasWindow];
  annotationToolbarWindow = null;
  annotationCanvasWindow = null;
  for (const overlayWindow of windows) {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  }
  if (restoreRecordingToolbar) syncRecordingToolbarVisibility();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function sendRecordingCommand(command) {
  if (command === "open") {
    showMainWindow();
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!rendererReady) {
    queuedRecordingCommand = command;
    return;
  }
  mainWindow.webContents.send("recording:control", command);
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const state = latestRecordingState.state;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open FrameCapture", click: showMainWindow },
      { type: "separator" },
      {
        label: "Start recording",
        enabled: state === "idle",
        click: () => sendRecordingCommand("start"),
      },
      {
        label: "Pause recording",
        enabled: state === "recording",
        click: () => sendRecordingCommand("pause"),
      },
      {
        label: "Resume recording",
        enabled: state === "paused",
        click: () => sendRecordingCommand("resume"),
      },
      {
        label: "Stop and save",
        enabled: state === "recording" || state === "paused",
        click: () => sendRecordingCommand("stop"),
      },
      { type: "separator" },
      {
        label: "Quit FrameCapture",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  if (process.platform !== "win32" || tray) return;
  tray = new Tray(path.join(__dirname, "icon.ico"));
  tray.setToolTip("FrameCapture");
  tray.on("click", showMainWindow);
  tray.on("double-click", showMainWindow);
  updateTrayMenu();
}

function createRecordingToolbar(display) {
  if (process.platform !== "win32" || recordingToolbarWindow) return;
  const toolbarWidth = 420;
  const toolbarHeight = 76;
  recordingToolbarWindow = new BrowserWindow({
    x: display.bounds.x + Math.round((display.bounds.width - toolbarWidth) / 2),
    y: display.bounds.y + 22,
    width: toolbarWidth,
    height: toolbarHeight,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    minimizable: false,
    maximizable: false,
    movable: true,
    focusable: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "overlay-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  recordingToolbarWindow.setAlwaysOnTop(true, "screen-saver");
  recordingToolbarWindow.setContentProtection(true);
  recordingToolbarWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });
  recordingToolbarWindow.webContents.setWindowOpenHandler(() => ({
    action: "deny",
  }));
  recordingToolbarWindow.once("closed", () => {
    recordingToolbarWindow = null;
  });
  recordingToolbarWindow
    .loadFile(path.join(__dirname, "../dist/public/index.html"), {
      hash: "recording-toolbar",
    })
    .then(() => syncRecordingToolbarVisibility())
    .catch(() => recordingToolbarWindow?.destroy());
}

async function openAnnotationOverlays(display) {
  destroyAnnotationOverlays(false);
  const preloadPath = path.join(__dirname, "overlay-preload.cjs");
  const overlayPage = path.join(__dirname, "../dist/public/index.html");
  const bounds = display.bounds;

  annotationCanvasWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    minimizable: false,
    maximizable: false,
    movable: false,
    focusable: true,
    skipTaskbar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  annotationCanvasWindow.setAlwaysOnTop(true, "floating");
  annotationCanvasWindow.setIgnoreMouseEvents(true, { forward: true });
  annotationCanvasWindow.webContents.setWindowOpenHandler(() => ({
    action: "deny",
  }));

  const toolbarWidth = Math.min(980, Math.max(400, bounds.width - 24));
  const toolbarHeight = bounds.width < 900 ? 116 : 72;
  annotationToolbarWindow = new BrowserWindow({
    x: bounds.x + Math.round((bounds.width - toolbarWidth) / 2),
    y: bounds.y + 18,
    width: toolbarWidth,
    height: toolbarHeight,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    minimizable: false,
    maximizable: false,
    movable: false,
    focusable: true,
    skipTaskbar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  annotationToolbarWindow.setAlwaysOnTop(true, "screen-saver");
  annotationToolbarWindow.setContentProtection(true);
  annotationToolbarWindow.webContents.setWindowOpenHandler(() => ({
    action: "deny",
  }));

  try {
    await annotationCanvasWindow.loadFile(overlayPage, {
      hash: "annotation-canvas",
    });
    await annotationToolbarWindow.loadFile(overlayPage, {
      hash: "annotation-toolbar",
    });
    annotationCanvasWindow.showInactive();
    annotationToolbarWindow.showInactive();
    syncRecordingToolbarVisibility();
  } catch (error) {
    destroyAnnotationOverlays();
    throw error;
  }
}

function registerIpcHandlers() {
  ipcMain.handle("capture:get-sources", async (event) => {
    assertTrustedSender(event);
    return getCaptureSources();
  });

  ipcMain.handle("capture:select-source", async (event, sourceId) => {
    assertTrustedSender(event);
    if (typeof sourceId !== "string" || sourceId.length > 512) {
      throw new Error("Choose a valid capture source.");
    }

    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 0, height: 0 },
    });
    if (!sources.some((source) => source.id === sourceId)) {
      throw new Error("That screen or window is no longer available.");
    }

    selectedSourceId = sourceId;
    return true;
  });

  ipcMain.handle("annotation:open", async (event, sourceId) => {
    assertTrustedSender(event);
    if (typeof sourceId !== "string" || sourceId !== selectedSourceId) {
      throw new Error("Select the screen you want to annotate.");
    }

    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
    });
    const captureSource = sources.find((source) => source.id === sourceId);
    if (!captureSource?.display_id) {
      throw new Error("FrameCapture could not identify the selected display.");
    }

    const display = screen
      .getAllDisplays()
      .find((candidate) => String(candidate.id) === captureSource.display_id);
    if (!display) {
      throw new Error("The selected display is no longer available.");
    }

    await openAnnotationOverlays(display);
    return true;
  });

  ipcMain.handle("annotation:close", async (event) => {
    assertTrustedSender(event);
    destroyAnnotationOverlays();
    return true;
  });

  ipcMain.on("annotation:action", (event, action) => {
    if (
      !event.senderFrame?.url?.startsWith("file://") ||
      event.sender !== annotationToolbarWindow?.webContents ||
      !annotationCanvasWindow ||
      annotationCanvasWindow.isDestroyed() ||
      !action ||
      typeof action !== "object"
    ) {
      return;
    }

    if (action.type === "tool" && annotationTools.has(action.tool)) {
      annotationCanvasWindow.setIgnoreMouseEvents(action.tool === "cursor", {
        forward: true,
      });
      annotationCanvasWindow.webContents.send("annotation:action", {
        type: "tool",
        tool: action.tool,
      });
      return;
    }
    if (
      action.type === "color" &&
      typeof action.color === "string" &&
      /^#[0-9a-f]{6}$/i.test(action.color)
    ) {
      annotationCanvasWindow.webContents.send("annotation:action", {
        type: "color",
        color: action.color,
      });
      return;
    }
    if (action.type === "undo" || action.type === "clear") {
      annotationCanvasWindow.webContents.send("annotation:action", {
        type: action.type,
      });
    }
  });

  ipcMain.on("recording:state", (event, status) => {
    if (
      event.sender !== mainWindow?.webContents ||
      !event.senderFrame?.url?.startsWith("file://") ||
      !status ||
      !["idle", "starting", "recording", "paused", "stopping"].includes(
        status.state,
      ) ||
      !Number.isFinite(status.elapsedSeconds)
    ) {
      return;
    }

    latestRecordingState = {
      state: status.state,
      elapsedSeconds: Math.max(
        0,
        Math.min(24 * 60 * 60, Math.floor(status.elapsedSeconds)),
      ),
      status:
        typeof status.status === "string" ? status.status.slice(0, 140) : "",
      error:
        typeof status.error === "string" ? status.error.slice(0, 240) : "",
    };
    if (
      annotationToolbarWindow &&
      !annotationToolbarWindow.isDestroyed()
    ) {
      annotationToolbarWindow.webContents.send(
        "recording:state",
        latestRecordingState,
      );
    }
    if (recordingToolbarWindow && !recordingToolbarWindow.isDestroyed()) {
      recordingToolbarWindow.webContents.send(
        "recording:state",
        latestRecordingState,
      );
    }
    updateTrayMenu();
    syncRecordingToolbarVisibility();
    if (status.state === "idle" && latestRecordingState.error) {
      showMainWindow();
    }
  });

  ipcMain.on("recording:renderer-ready", (event) => {
    if (
      event.sender !== mainWindow?.webContents ||
      !event.senderFrame?.url?.startsWith("file://")
    ) {
      return;
    }
    rendererReady = true;
    if (queuedRecordingCommand) {
      const command = queuedRecordingCommand;
      queuedRecordingCommand = undefined;
      sendRecordingCommand(command);
    }
  });

  ipcMain.on("recording:request-state", (event) => {
    if (
      (event.sender !== annotationToolbarWindow?.webContents &&
        event.sender !== recordingToolbarWindow?.webContents) ||
      !event.senderFrame?.url?.startsWith("file://")
    ) {
      return;
    }
    event.sender.send("recording:state", latestRecordingState);
  });

  ipcMain.on("recording:control", (event, command) => {
    if (
      (event.sender !== annotationToolbarWindow?.webContents &&
        event.sender !== recordingToolbarWindow?.webContents) ||
      !event.senderFrame?.url?.startsWith("file://") ||
      !["start", "pause", "resume", "stop", "open"].includes(command)
    ) {
      return;
    }
    if (command === "open") {
      showMainWindow();
      return;
    }
    sendRecordingCommand(command);
  });

  ipcMain.handle("settings:get-output-directory", async (event) => {
    assertTrustedSender(event);
    return outputDirectory;
  });

  ipcMain.handle("settings:choose-output-directory", async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose recording folder",
      defaultPath: outputDirectory,
      properties: ["openDirectory", "createDirectory"],
    });

    if (result.canceled || !result.filePaths[0]) return null;

    outputDirectory = result.filePaths[0];
    await fsp.mkdir(outputDirectory, { recursive: true });
    const settings = await readSettings();
    await saveSettings({ ...settings, outputDirectory });
    return outputDirectory;
  });

  ipcMain.handle("recordings:list", async (event) => {
    assertTrustedSender(event);
    await fsp.mkdir(outputDirectory, { recursive: true });
    const files = await fsp.readdir(outputDirectory, { withFileTypes: true });
    const recordings = [];

    for (const file of files) {
      if (!file.isFile() || !file.name.toLowerCase().endsWith(".mp4")) continue;
      const fullPath = path.join(outputDirectory, file.name);
      const stats = await fsp.stat(fullPath);
      let metadata = {};
      try {
        metadata = JSON.parse(
          await fsp.readFile(`${fullPath}.json`, "utf8"),
        );
      } catch {
        // Older or manually added MP4 files still appear in the library.
      }
      recordings.push({
        id: metadata.id || file.name,
        name: file.name,
        path: fullPath,
        createdAt: metadata.createdAt || stats.mtime.toISOString(),
        size: stats.size,
        duration: Number(metadata.duration) || 0,
      });
    }

    return recordings.sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  });

  ipcMain.handle("recordings:reveal", async (event, filePath) => {
    assertTrustedSender(event);
    if (typeof filePath !== "string") {
      throw new Error("Choose a recording to reveal.");
    }
    const absolutePath = path.resolve(filePath);
    const relativePath = path.relative(outputDirectory, absolutePath);
    if (
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath) ||
      !absolutePath.toLowerCase().endsWith(".mp4")
    ) {
      throw new Error("That file is outside the recordings folder.");
    }
    await shell.showItemInFolder(absolutePath);
  });

  ipcMain.handle("recording:begin", async (event, requestedName) => {
    assertTrustedSender(event);
    if (activeRecordings.size > 0) {
      throw new Error("A recording is already in progress.");
    }
    await fsp.mkdir(outputDirectory, { recursive: true });

    const id = randomUUID();
    const stem = safeRecordingName(requestedName);
    const timeLabel = new Date().toISOString().replace(/[:.]/g, "-");
    const baseName = `${stem}-${timeLabel}`;
    const tempDirectory = path.join(app.getPath("temp"), "FrameCapture", "recordings");
    await fsp.mkdir(tempDirectory, { recursive: true });
    const webmPath = path.join(tempDirectory, `${baseName}-${id}.webm`);
    const mp4Path = path.join(outputDirectory, `${baseName}-${id.slice(0, 8)}.mp4`);
    const stream = fs.createWriteStream(webmPath, { flags: "wx" });

    await new Promise((resolve, reject) => {
      stream.once("open", resolve);
      stream.once("error", reject);
    });

    activeRecordings.set(id, {
      id,
      baseName,
      webmPath,
      mp4Path,
      stream,
      startedAt: Date.now(),
    });
    return { id };
  });

  ipcMain.handle("recording:write-chunk", async (event, id, chunk) => {
    assertTrustedSender(event);
    const recording = activeRecordings.get(id);
    if (!recording) throw new Error("The recording session has ended.");

    const bytes =
      chunk instanceof ArrayBuffer
        ? Buffer.from(chunk)
        : ArrayBuffer.isView(chunk)
          ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : null;
    if (!bytes || bytes.byteLength > 32 * 1024 * 1024) {
      throw new Error("The recording data chunk is invalid or too large.");
    }

    await new Promise((resolve, reject) => {
      recording.stream.write(bytes, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return true;
  });

  ipcMain.handle("recording:finish", async (event, id, durationSeconds) => {
    assertTrustedSender(event);
    const recording = activeRecordings.get(id);
    if (!recording) throw new Error("The recording session has ended.");
    activeRecordings.delete(id);

    await new Promise((resolve, reject) => {
      recording.stream.once("error", reject);
      recording.stream.end(resolve);
    });

    const elapsedSeconds = Number(durationSeconds);
    const duration = Number.isFinite(elapsedSeconds)
      ? Math.max(0, Math.min(24 * 60 * 60, Math.round(elapsedSeconds)))
      : Math.max(0, Math.round((Date.now() - recording.startedAt) / 1000));
    sendExportProgress(0);
    try {
      await transcodeToMp4(
        recording.webmPath,
        recording.mp4Path,
        duration * 1000,
      );
      await fsp.rm(recording.webmPath, { force: true });
      const stats = await fsp.stat(recording.mp4Path);
      const createdAt = new Date(recording.startedAt).toISOString();
      const result = {
        id: recording.id,
        name: path.basename(recording.mp4Path),
        path: recording.mp4Path,
        createdAt,
        size: stats.size,
        duration,
      };
      await fsp.writeFile(
        `${recording.mp4Path}.json`,
        JSON.stringify(result, null, 2),
        "utf8",
      );
      return result;
    } catch (error) {
      await fsp.rm(recording.mp4Path, { force: true });
      throw new Error(
        `Could not export MP4. The temporary recording is at ${recording.webmPath}. ${error.message}`,
      );
    }
  });

  ipcMain.handle("recording:cancel", async (event, id) => {
    assertTrustedSender(event);
    const recording = activeRecordings.get(id);
    if (!recording) return false;
    activeRecordings.delete(id);
    recording.stream.destroy();
    await fsp.rm(recording.webmPath, { force: true });
    return true;
  });
}

function createWindow() {
  rendererReady = false;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 680,
    title: "FrameCapture",
    icon: path.join(__dirname, "icon.ico"),
    backgroundColor: "#10131a",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.loadFile(path.join(__dirname, "../dist/public/index.html"));
  mainWindow.on("close", (event) => {
    if (process.platform === "win32" && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    rendererReady = false;
    destroyAnnotationOverlays();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    const settings = await readSettings();
    outputDirectory =
      typeof settings.outputDirectory === "string" && settings.outputDirectory
        ? settings.outputDirectory
        : path.join(app.getPath("videos"), "FrameCapture");
    await fsp.mkdir(outputDirectory, { recursive: true });

    const allowedCapturePermissions = new Set(["media", "display-capture"]);
    const canAppRendererCapture = (webContents, permission) =>
      webContents === mainWindow?.webContents &&
      webContents?.getURL?.().startsWith("file://") &&
      allowedCapturePermissions.has(permission);

    // Electron checks display-capture separately from camera/microphone media.
    // Allow both only for the trusted local app renderer that the user controls.
    session.defaultSession.setPermissionCheckHandler(
      (webContents, permission) =>
        canAppRendererCapture(webContents, permission),
    );
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        callback(canAppRendererCapture(webContents, permission));
      },
    );

    session.defaultSession.setDisplayMediaRequestHandler(
      async (request, callback) => {
        try {
          const sources = await desktopCapturer.getSources({
            types: ["screen", "window"],
            thumbnailSize: { width: 0, height: 0 },
          });
          const source =
            sources.find((candidate) => candidate.id === selectedSourceId) ||
            sources.find((candidate) => candidate.id.startsWith("screen:"));
          if (!source) {
            callback(null);
            return;
          }

          callback({
            video: source,
            ...(request.audioRequested && process.platform === "win32"
              ? { audio: "loopback" }
              : {}),
          });
        } catch {
          callback(null);
        }
      },
      { useSystemPicker: false },
    );

    registerIpcHandlers();
    try {
      const sources = await getCaptureSources();
      selectedSourceId =
        sources.find((source) => source.type === "screen")?.id ||
        sources[0]?.id;
    } catch {
      selectedSourceId = undefined;
    }
    createWindow();
    createTray();
    if (process.platform === "win32") {
      createRecordingToolbar(screen.getPrimaryDisplay());
    }
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && process.platform !== "win32") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  if (tray && !tray.isDestroyed()) tray.destroy();
  if (recordingToolbarWindow && !recordingToolbarWindow.isDestroyed()) {
    recordingToolbarWindow.destroy();
  }
  destroyAnnotationOverlays();
});
