---
name: Windows recorder triggers
description: Safe capture startup from a floating toolbar or system tray in the FrameCapture desktop app.
---

For Windows recording started from the floating toolbox or system tray, the command reaches the main renderer through IPC rather than a click in that renderer. Use Electron's desktop `getUserMedia` constraints with the selected desktop source for this external-control path; retain `getDisplayMedia` for a direct in-window click.

**Why:** Screen-capture APIs may require transient user activation, which an IPC message from another window does not provide. The user still explicitly starts the capture from the toolbox or tray.

**How to apply:** Keep the selected source ID synchronized before accepting toolbox starts, and verify the capture and audio paths on Windows hardware before claiming they work on every device.
