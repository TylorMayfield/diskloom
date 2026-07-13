# Diskloom — Free Disk Space Analyzer for macOS, Windows, and Linux

Diskloom is a fast, private, open-source disk space analyzer and storage visualizer for macOS, Windows, and Linux. Scan drives and folders, explore disk usage, find large files, and identify duplicate files without uploading your data.

Built with Electron, TypeScript, React, and Radix UI.

![Diskloom disk space analyzer showing an interactive storage map](docs/images/diskloom-disk-space-analyzer.png)

## Download Diskloom

Download the latest Diskloom desktop app for your platform:

| Platform | Download |
| --- | --- |
| macOS — Apple Silicon (M1–M4) | [Download DMG](https://github.com/TylorMayfield/diskloom/releases/latest/download/Diskloom-mac-arm64.dmg) |
| macOS — Intel | [Download DMG](https://github.com/TylorMayfield/diskloom/releases/latest/download/Diskloom-mac-x64.dmg) |
| Windows — 64-bit installer | [Download EXE](https://github.com/TylorMayfield/diskloom/releases/latest/download/Diskloom-windows-x64.exe) |
| Windows — portable 64-bit | [Download ZIP](https://github.com/TylorMayfield/diskloom/releases/latest/download/Diskloom-windows-x64.zip) |
| Linux — 64-bit | [Download AppImage](https://github.com/TylorMayfield/diskloom/releases/latest/download/Diskloom-linux-x86_64.AppImage) |
| Ubuntu, Debian, and Mint — 64-bit | [Download DEB](https://github.com/TylorMayfield/diskloom/releases/latest/download/Diskloom-linux-amd64.deb) |

[View all releases and release notes](https://github.com/TylorMayfield/diskloom/releases)

## Features

- Visualize disk usage and quickly find what is taking up space.
- Scan drives or individual folders locally.
- Find large files and duplicate files.
- Keep filenames, paths, file contents, and scan results private.
- Run on macOS, Windows, and Linux.

Symlinks are not followed, inaccessible paths are skipped, and scans never upload files.

### Find duplicate files

Diskloom privately compares likely matches, shows how much space duplicate files consume, and lets you choose which copy to keep.

![Diskloom duplicate file finder showing reclaimable storage](docs/images/diskloom-duplicate-file-finder.png)

## Development

```bash
pnpm install
pnpm dev
```

## Build

```bash
pnpm build
```

## Support

[Support this free and open-source project on Ko-fi](https://ko-fi.com/tylormayfield).
