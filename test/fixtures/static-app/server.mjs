/**
 * A signed-in app for the page capture test: `node server.mjs <port>`.
 * Pages need the `session=ok` cookie (from the test's storageState file),
 * otherwise they redirect to /login. /moved always redirects to /.
 */
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const TOKEN =
  "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.c2lnbmVkLWJ5LW5vYm9keQ";
const page = (body) => `<!doctype html>
<html lang="en" class="light" data-theme="light">
<head><link rel="stylesheet" href="/app.css"><script>window.__boot = 1;</script></head>
<body class="app"><div data-testid="shell"><nav><a href="/">Home</a></nav>${body}</div></body>
</html>`;

const routes = {
  "/": page(
    `<main><h1>Home</h1><p>Welcome back.</p><img alt="logo" src="/logo.svg"></main>`,
  ),
  "/leaky": page(
    `<main><h1>Leaky</h1><p data-token="${TOKEN}">debug</p></main>`,
  ),
  "/login": page(`<main><h1>Sign in</h1></main>`),
  "/app.css": `@font-face{font-family:"App Sans";src:url("/fonts/app-sans.woff2") format("woff2")}
body{font-family:"App Sans",sans-serif;margin:0}
main{padding:24px;background:url("/dots.svg")}`,
  "/logo.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>`,
  "/dots.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><circle r="1"/></svg>`,
  "/fonts/app-sans.woff2": "wOF2-app-sans-bytes",
};
const TYPES = { css: "text/css", svg: "image/svg+xml", woff2: "font/woff2" };

createServer((request, response) => {
  const { pathname } = new URL(request.url, "http://x");
  const signedIn = /(?:^|;\s*)session=ok\b/.test(request.headers.cookie ?? "");
  // A page that moved: the capture records it as a redirect.
  if (pathname === "/moved")
    return response.writeHead(302, { location: "/" }).end();
  if (!(pathname in routes)) return response.writeHead(404).end();
  const ext = pathname.split(".").pop();
  if (!(ext in TYPES) && pathname !== "/login" && !signedIn) {
    return response.writeHead(302, { location: "/login" }).end();
  }
  response.writeHead(200, {
    "content-type": TYPES[ext] ?? "text/html; charset=utf-8",
  });
  response.end(routes[pathname]);
}).listen(port, "127.0.0.1");
