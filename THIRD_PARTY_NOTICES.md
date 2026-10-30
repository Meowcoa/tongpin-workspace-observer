# Third-party components

Tongpin's original source code is licensed under MIT. Dependencies and bundled runtimes retain their upstream licenses.

The production dependency list and exact versions are recorded in `package-lock.json`. It includes the MCP TypeScript SDK, Express, chokidar, diff, React, react-markdown, remark-gfm, DOMPurify, PDF.js, fast-xml-parser, Papa Parse, fflate and zod.

`npm run desktop:bundle` collects the installed production packages' license files, the PDF.js font/character-map notices, Electron's license and the pinned Node.js license under `third_party/nodejs/`. The Node version must match `.nvmrc`; update the recorded license and checksum when upgrading it. The generated `release/THIRD_PARTY_LICENSES.txt` is included in the portable app and public distribution bundles. Electron's own distribution also carries its Chromium license notices.

Generated notices are build output and are not committed. Do not replace upstream notices with this project's MIT license when redistributing a build.
