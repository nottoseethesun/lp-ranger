/**
 * @file scripts/swagger.js
 * @description Lightweight Swagger UI server for LP Ranger API docs.
 *   Serves swagger-ui-dist static files with the project's OpenAPI spec.
 *   Start with: npm run swagger
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 5556;
const DIST = path.dirname(require.resolve("swagger-ui-dist/package.json"));
const SPEC = path.join(__dirname, "..", "docs", "openapi.json");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".map": "application/json",
};

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>LP Ranger API Docs</title>
  <link rel="stylesheet" href="swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({ url: "/openapi.json", dom_id: "#swagger-ui" });
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(INDEX_HTML);
    return;
  }
  if (url === "/openapi.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    fs.createReadStream(SPEC).pipe(res);
    return;
  }
  const filePath = path.join(DIST, url);
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403);
    res.end();
    return;
  }
  const ext = path.extname(filePath);
  fs.access(filePath, fs.constants.R_OK, (err) => {
    if (err) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`Swagger UI: http://localhost:${PORT}`);
});
