# Project Brain

## Project Overview

Diskloom is a local-first desktop disk space explorer for scanning folders, visualizing usage, finding duplicates, and benchmarking drives.

## Tech Stack

- Tauri 2 desktop shell with a Rust backend.
- React 19, TypeScript, Vite 6, Radix UI, and plain CSS for the frontend.
- pnpm 10 for JavaScript tooling; Cargo for Rust tests and builds.

## Architecture Notes

- `src/App.tsx` owns scan state and routes among Welcome, Disk Map, Duplicates, and Benchmark views.
- `src/Modal.tsx` centralizes modal focus trapping, Escape dismissal, background inertness, and focus restoration.
- `src/styles.css` is the shared visual and interaction system.
- `src/demo-api.ts` provides realistic local browser data for rendered UI verification.

## Current Feature

Save the supplied Apple design guidance as a project-local skill and apply it to all current Diskloom screens.

## Decisions

- Preserve the existing dark, compact Diskloom identity and information architecture.
- Apply the directive through shared CSS and modal behavior so every screen receives consistent immediate feedback, material depth, typography, and accessibility behavior.
- Use restrained, critically damped-feeling transitions for ordinary controls; do not add bounce where no momentum gesture exists.
- Keep destructive actions explicit and recoverable through the existing Trash confirmation flow.

## Assumptions

- “Our screens” means the shipped Welcome, scanning, Disk Map, Duplicates, Benchmark, notification, context-menu, and modal surfaces.
- No new gesture-driven component is necessary for this pass; current screens do not expose sheets, drawers, or draggable cards.
- Native-device visual QA is separate from browser-rendered and source verification.

## Testing Strategy

- Run `pnpm typecheck`, `pnpm test`, and a production frontend build.
- Use the built-in demo API to inspect representative views and modal interactions in the rendered app.
- Check reduced-motion, reduced-transparency, focus-visible, and high-contrast CSS contracts in the final diff.

## Known Issues

- No dedicated frontend unit-test runner is configured; UI verification uses type checking, production compilation, and rendered interaction checks.

## Completed Work

- 2026-08-12: Inspected the current React/Tauri architecture and translated the supplied Apple design directive into scoped acceptance criteria.
- 2026-08-12: Added `.agents/skills/apple-design/SKILL.md` and applied its interaction, material, typography, and accessibility rules across the shared UI system.
- 2026-08-12: Changed duplicate results to begin with no destructive selection and exposed the oldest-copy heuristic through an explicit “Select suggested copies” action.
- 2026-08-12: Ensured “Keep this” never creates a Trash selection and made selected-count changes an atomic polite announcement for assistive technology.
- 2026-08-12: Verified the welcome, Disk Map, Duplicates, Benchmark, and modal flows with the demo API; TypeScript, production compilation, and all 12 Rust tests pass.
