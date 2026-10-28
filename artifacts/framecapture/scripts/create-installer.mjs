import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);
const appExecutable = path.join(
  packageRoot,
  "release",
  "win-unpacked",
  "FrameCapture.exe",
);
const ffmpegExecutable = path.join(
  packageRoot,
  "release",
  "win-unpacked",
  "resources",
  "ffmpeg.exe",
);
const installerPath = path.join(
  packageRoot,
  "release",
  `FrameCapture-Setup-${packageJson.version}.exe`,
);
const nsisPath = (value) => value.split(path.sep).join("/");

if (!existsSync(appExecutable)) {
  throw new Error("Build the Windows app directory before creating its installer.");
}
if (!existsSync(ffmpegExecutable)) {
  throw new Error("The packaged FFmpeg executable is missing from the Windows app.");
}

rmSync(installerPath, { force: true });
const result = spawnSync(
  "makensis",
  [
    "-V2",
    `-DAPP_VERSION=${packageJson.version}`,
    `-DAPP_ROOT=${nsisPath(packageRoot)}`,
    `-DAPP_ICON=${nsisPath(path.join(packageRoot, "electron", "icon.ico"))}`,
    "electron/framecapture-installer.nsi",
  ],
  { cwd: packageRoot, stdio: "inherit" },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`NSIS exited with status ${result.status ?? "unknown"}.`);
}

const installerStats = statSync(installerPath);
if (installerStats.size < 10 * 1024 * 1024) {
  rmSync(installerPath, { force: true });
  throw new Error("The generated installer is unexpectedly small and was removed.");
}

const signature = readFileSync(installerPath).subarray(0, 2).toString();
if (signature !== "MZ") {
  rmSync(installerPath, { force: true });
  throw new Error("The generated installer is not a valid Windows executable.");
}

console.info(
  `Created ${path.basename(installerPath)} (${Math.round(installerStats.size / (1024 * 1024))} MB).`,
);
