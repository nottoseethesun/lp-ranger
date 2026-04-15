/**
 * @file scripts/api-doc.js
 * @description Local API reference server for LP Ranger.
 *   Serves the OpenAPI spec at `/openapi.json` and renders it with
 *   Scalar's standalone bundle from `@scalar/api-reference`. Scalar has
 *   a native dark theme that matches the rest of LP Ranger's palette
 *   out of the box. Start with: `npm run api-doc`.
 *
 *   Replaces the previous Swagger UI setup. The port (5556) is
 *   unchanged from the old `npm run swagger` command for muscle-memory
 *   reasons — only the renderer and the npm script name changed.
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 5556;
// Scalar's package.json has an `exports` field that deliberately doesn't
// expose internal paths, so `require.resolve('@scalar/api-reference/package.json')`
// fails with ERR_PACKAGE_PATH_NOT_EXPORTED. Use a direct filesystem path
// from the project root instead — the standalone bundle lives at a stable
// well-known path inside the package.
const SCALAR_JS = path.join(
  __dirname,
  "..",
  "node_modules",
  "@scalar",
  "api-reference",
  "dist",
  "browser",
  "standalone.js",
);
const SPEC = path.join(__dirname, "..", "docs", "openapi.json");

// Scalar's standalone bundle registers a <script id="api-reference"> hook
// that initialises the viewer when the bundle loads. `data-url` points at
// the OpenAPI spec; `data-configuration` carries runtime options as JSON.
// `theme: 'purple'` is Scalar's default dark palette — the `darkMode: true`
// flag forces dark even on light-mode OSes.
const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LP Ranger API Reference</title>
  </head>
  <body>
    <script
      id="api-reference"
      data-url="/openapi.json"
      data-configuration='{"darkMode":true,"hideDarkModeToggle":false}'
    ></script>
    <script src="/scalar-standalone.js"></script>
  </body>
</html>`;

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(INDEX_HTML);
    return;
  }
  if (url === "/openapi.json") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    fs.createReadStream(SPEC).pipe(res);
    return;
  }
  if (url === "/scalar-standalone.js") {
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
    });
    fs.createReadStream(SCALAR_JS).pipe(res);
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`LP Ranger API Reference: http://localhost:${PORT}`);
});
