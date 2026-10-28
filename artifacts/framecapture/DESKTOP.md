# FrameCapture for Windows

FrameCapture is a local Windows desktop app. Screen video and audio stay on the
computer; there is no recording upload service. MP4 export uses FFmpeg 6.1.1;
the installer includes its license and build information.

## Build the Windows installer

Build from the Replit workspace, or from a machine with Node.js, pnpm, and
`makensis` (NSIS) available on `PATH`:

```sh
pnpm install
pnpm --filter @workspace/framecapture run desktop:win
```

The x64 NSIS installer is written to `artifacts/framecapture/release/`. It
installs for the current Windows user, creates Start menu and desktop shortcuts,
and offers to launch FrameCapture when setup finishes. An unsigned build may
show a Windows SmartScreen warning. The build downloads a pinned Windows FFmpeg
binary and verifies its SHA-256 before including it.

To build a portable executable instead, run:

```sh
pnpm --filter @workspace/framecapture run desktop:portable
```

The portable executable can be launched without installing the app.

FFmpeg license and build details are installed beside the application. The
corresponding FFmpeg source and build project are published at
https://github.com/eugeneware/ffmpeg-static and https://ffmpeg.org/download.html.

The capture presets request up to the selected resolution and frame rate.
Actual output depends on the captured display/window and the PC's recording and
encoding capacity. System-audio loopback is supported on Windows; microphone
capture requires a connected microphone and Windows permission.
