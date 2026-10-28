---
name: Windows installer builds on Replit
description: Reliable process for creating Windows setup executables in this Linux workspace.
---

For this Replit workspace, package the Windows app directory with Electron Builder, then use the Nix `nsis` package's `makensis` to create the setup executable. A small custom installer can create its uninstaller at install time with `WriteUninstaller`, configure the app icon and shortcuts, and avoid running Wine.

**Why:** Electron Builder's built-in NSIS flow runs a generated installer under Wine to extract its uninstaller. The available Replit Wine launcher and headless services made that step unreliable, while a custom Electron Builder NSIS script left the uninstaller output unset.

**How to apply:** When maintaining this Windows app's installer pipeline, keep the direct NSIS build path and validate both the final Windows executable and its download route. Do not retry Wine-based NSIS packaging unless Wine availability changes.
