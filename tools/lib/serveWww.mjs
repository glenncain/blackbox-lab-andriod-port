// ======================================================
// BLACKBOX LAB — STATIC SERVER FOR THE WEB BUILD
// ======================================================
//
// The Android build has to be served over http to be tested
// at all: module workers are refused on file://, which is
// exactly the difference between the phone and the desktop.
//
// Shared by tools/android-smoke.mjs and tools/profile-load.mjs.
//
// ======================================================

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".bbl": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

export async function serveWww(root, port) {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(request.url.split("?")[0]);
    const relative = normalize(path).replace(/^(\.\.[/\\])+/, "");
    const file = join(root, relative === "/" ? "index.html" : relative);

    try {
      const info = await stat(file);

      if (!info.isFile()) {
        throw new Error("not a file");
      }

      response.writeHead(200, {
        "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
        "Content-Length": info.size
      });

      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end("not found");
    }
  });

  await new Promise((resolve) => server.listen(port, resolve));

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => server.close()
  };
}
