# Workspace Observer

This is a Windows-first local filesystem observer. Preserve the design documents in the parent outputs directory.

- Runtime: Node.js 24.16+, TypeScript, React/Vite, SQLite via node:sqlite, MCP SDK 1.x.
- Commands: npm ci; npm run build; npm test; npm start.
- Project files are read-only to this service. MCP tools must never expose project writes, deletion, arbitrary shell execution or root selection.
- Watcher events feed a persistent multi-reader history. Querying never consumes events. Acknowledgement is explicit and per client.
- Never print or commit generated local access credentials. Runtime data belongs in .observer-data or an explicitly selected directory outside the watched root.
- Test against disposable fixture directories under the repository's ignored .work/ directory. Do not write build or test output outside the checkout, or manufacture edits in user projects.
- Backend tests must cover real MCP transports, independent cursors, restart reconciliation, retention gaps, ignored files and root/HTTP access boundaries.
- Real AI-client compatibility must be reported separately from SDK-client test results.
- Desktop packaging: npm run desktop:pack. The single portable GUI EXE contains its own runtime and a self-contained Node SEA MCP connector. End users must not need Node.js, npm, PowerShell or a separately started service.
- NSIS portable launchers do not inherit STDIO handles. Export MCP configurations using the extracted stable MCP connector, and put that connector plus the GUI EXE in plugin packages. Do not point an MCP host directly at the NSIS GUI launcher.
- Builder 26.18.0 requires portable.unpackDirName=true to omit UNPACK_DIR_NAME and use the per-launch $PLUGINSDIR/app. Its documentation describes false, but the shipped NsisTarget.js treats false as a shared build directory. Validate repeated actual portable launches and resource survival when changing the builder or this setting.
- Verify the real MCP executable with npm run test:desktop using a child PATH without system Node/npm. The app serves MCP to AI tools; it must not call model APIs or AI CLIs for normal operation.
- Keep Electron renderer nodeIntegration disabled, contextIsolation and sandbox enabled. Native IPC is management-only and must verify the sender.
- Scroll-layout changes must verify long file previews inside the change-history page with the client section below, in addition to the standalone preview page. Assert that the workspace contains both columns and the client section starts after them at desktop and narrow sizes; do not rely on a z-index or clipping workaround.
