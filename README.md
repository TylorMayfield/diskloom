# Diskloom

A fast, private disk space explorer built with Electron, TypeScript, React, and Radix UI.

[Support this free project on Ko-fi](https://ko-fi.com/tylormayfield)

## Development

```bash
pnpm install
pnpm dev
```

## Build

```bash
pnpm build
```

To enable anonymous GA4 usage analytics, copy `.env.example` to `.env.production` and set the Web data stream measurement ID before building. When the ID is absent, analytics are disabled. On first launch, users are asked to opt in and can change their choice from the footer; the GA script is not loaded before consent. Events include app version/platform, screen and feature usage, and coarse operation counts/timing. Filesystem paths, filenames, file contents, hashes, drive names, and benchmark results are never collected. In GA4, register `app_version`, `app_platform`, `app_arch`, and `electron_version` as user-scoped custom dimensions to report on them.

Symlinks are not followed, inaccessible paths are skipped, and scans never upload files.
