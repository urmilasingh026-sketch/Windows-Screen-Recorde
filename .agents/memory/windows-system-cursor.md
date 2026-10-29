---
name: Windows system cursor lifecycle
description: User expectations for FrameCapture's temporary Windows-wide cursor customization.
---

FrameCapture's custom pointer applies to the Windows arrow across applications while the desktop app is running, then restores the user's saved cursor scheme when FrameCapture quits. Keep the change temporary and reversible.

**Why:** The user asked for the mouse pointer to match the supplied styles everywhere while FrameCapture is in use.

**How to apply:** Keep global cursor changes confined to the Windows desktop app, explain that closing the main window hides the app to the tray, and restore the saved Windows pointer on quit. Browser preview cannot change the operating system pointer.
