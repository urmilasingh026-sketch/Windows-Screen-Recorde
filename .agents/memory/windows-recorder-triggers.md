---
name: Windows recorder triggers
description: Safe capture startup from a floating toolbar or system tray in the FrameCapture desktop app.
---

For Windows recording started from the floating toolbox or system tray, the command reaches the main renderer through IPC rather than a click in that renderer. Use Electron's desktop `getUserMedia` constraints with the selected desktop source for this external-control path; retain `getDisplayMedia` for a direct in-window click. Electron classifies desktop `chromeMediaSource` capture as `display-capture`, separate from microphone/camera `media`; both permission-check and permission-request handlers must allow the trusted local renderer.

**Why:** Screen-capture APIs may require transient user activation, which an IPC message from another window does not provide. Electron also denies desktop capture if the app only grants the `media` permission. The user still explicitly starts the capture from the toolbox or tray.

**How to apply:** Keep the selected source ID synchronized before accepting toolbox starts. Have the renderer signal readiness after subscribing to commands; once that signal arrives, do not gate delivery on `webContents.isLoading()` or a queued command can become stranded. Treat resolution/FPS as capture targets: compare target size with physical display pixels (`Display.size × scaleFactor`) and report the media track's actual settings instead of implying upscaling creates native detail. Verify capture and audio paths on Windows hardware before claiming they work on every device.
