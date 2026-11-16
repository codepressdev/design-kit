/**
 * Requests that honour HTTPS_PROXY / HTTP_PROXY / NO_PROXY, with no
 * dependency. `node:https` ignores those variables, and a network sandbox
 * that lets traffic out only through its proxy (the Claude sandbox does)
 * then fails every request with ENOTFOUND, while curl, `gh` and `aws` work.
 *
 * - https through a proxy: an HTTP `CONNECT host:port` tunnel (with
 *   `Proxy-Authorization: Basic …` when the proxy URL carries credentials),
 *   then TLS over that socket with `servername` set. This is an
 *   `https.Agent` whose `createConnection` answers the tunnelled TLS socket.
 * - http through a proxy: the request goes to the proxy with the absolute
 *   URL as its path.
 * - No proxy variable, or a NO_PROXY match: a direct request, as before.
 *
 * Messages never carry the proxy's credentials or the URL's query string:
 * `reachMessage` names only the target host and a status or error code.
 */
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import tls from "node:tls";

import { StorageError } from "./common.mjs";

const DEFAULT_PORT = { "http:": "80", "https:": "443" };

/** `[name, value]` of the first non-empty variable among `names`. */
function firstSet(env, names) {
  for (const name of names)
    if (typeof env[name] === "string" && env[name].trim())
      return [name, env[name].trim()];
  return [undefined, undefined];
}

const bare = (host) => host.replace(/^\[(.*)\]$/, "$1").toLowerCase();

/**
 * Whether NO_PROXY (or no_proxy) says `hostname`:`port` goes direct. Entries
 * are comma- or space-separated: `*` matches everything; `example.com`,
 * `.example.com` and `*.example.com` match example.com and every subdomain;
 * an entry may end in `:port`, and then only that port matches.
 */
export function bypassesProxy(hostname, port, env = process.env) {
  const [, list] = firstSet(env, ["no_proxy", "NO_PROXY"]);
  if (!list) return false;
  const host = bare(hostname).replace(/\.$/, "");
  for (const raw of list.split(/[\s,]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    let entryPort;
    const withPort =
      entry.match(/^\[([^\]]+)\](?::(\d+))?$/) ??
      (entry.split(":").length === 2 ? entry.match(/^(.*):(\d+)$/) : null);
    if (withPort) {
      entry = withPort[1];
      entryPort = withPort[2];
    }
    if (entryPort && entryPort !== String(port)) continue;
    const domain = entry.replace(/^\*?\./, "").replace(/\.$/, "");
    if (!domain) continue;
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/**
 * The proxy for `url` (a URL or string) as a URL, or null for a direct
 * request: `https_proxy`/`HTTPS_PROXY` for https, `http_proxy`/`HTTP_PROXY`
 * for http (the lowercase name wins), unless NO_PROXY matches the host. A
 * proxy written without a scheme is taken as `http://`.
 */
export function proxyFor(url, env = process.env) {
  const target = url instanceof URL ? url : new URL(url);
  const names =
    target.protocol === "https:"
      ? ["https_proxy", "HTTPS_PROXY"]
      : target.protocol === "http:"
        ? ["http_proxy", "HTTP_PROXY"]
        : [];
  const [name, value] = firstSet(env, names);
  if (!value) return null;
  const port = target.port || DEFAULT_PORT[target.protocol];
  if (bypassesProxy(target.hostname, port, env)) return null;
  let proxy;
  try {
    proxy = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`,
    );
  } catch {
    throw new StorageError("invalid_proxy", `${name} is not a URL`);
  }
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:")
    throw new StorageError(
      "invalid_proxy",
      `${name} must be an http:// or https:// proxy`,
    );
  return proxy;
}

/** The `Proxy-Authorization` header for a proxy URL with credentials. */
function proxyAuth(proxy) {
  if (!proxy.username && !proxy.password) return {};
  const user = decodeURIComponent(proxy.username);
  const pass = decodeURIComponent(proxy.password);
  return {
    "Proxy-Authorization": `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
  };
}

/** Options for a request to the proxy itself. */
function proxyTarget(proxy) {
  return {
    protocol: proxy.protocol,
    hostname: bare(proxy.hostname),
    port: proxy.port || DEFAULT_PORT[proxy.protocol],
  };
}

/** A proxy that refused the tunnel: `status` is its answer. */
class ProxyRefused extends Error {
  constructor(status) {
    super(`the proxy answered ${status}`);
    this.proxyStatus = status;
  }
}

/** An https.Agent whose sockets are TLS over a CONNECT tunnel. */
class TunnelAgent extends https.Agent {
  constructor(proxy, timeout) {
    super({ keepAlive: false });
    this.proxy = proxy;
    this.connectTimeout = timeout;
  }

  createConnection(options, done) {
    const host = bare(options.host ?? options.hostname ?? "localhost");
    const port = options.port ?? 443;
    const authority = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
    const client = this.proxy.protocol === "https:" ? https : http;
    const connect = client.request({
      ...proxyTarget(this.proxy),
      method: "CONNECT",
      path: authority,
      headers: { Host: authority, ...proxyAuth(this.proxy) },
      timeout: this.connectTimeout,
      agent: false,
    });
    let settled = false;
    const finish = (error, socket) => {
      if (settled) return;
      settled = true;
      done(error, socket);
    };
    connect.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        finish(new ProxyRefused(res.statusCode));
        return;
      }
      // With `socket` given, TLS runs over the tunnel; the request's own
      // path and agent are not TLS options.
      const { path: _path, agent: _agent, ...rest } = options;
      const secure = tls.connect({
        ...rest,
        socket,
        servername: isIP(host) ? undefined : (options.servername ?? host),
      });
      finish(null, secure);
    });
    connect.on("response", (res) => {
      // A proxy that answers CONNECT with an ordinary response refused it.
      res.resume();
      finish(new ProxyRefused(res.statusCode));
    });
    connect.on("timeout", () =>
      connect.destroy(new Error("the proxy did not answer in time")),
    );
    connect.on("error", (error) => finish(error));
    connect.end();
    return undefined;
  }
}

/**
 * Starts a request to `url` as `http.request` would, through the proxy the
 * environment names: `{req, proxied}`. `options` takes `method`, `headers`
 * and `timeout`; `onResponse` gets the response.
 */
export function openRequest(url, options, onResponse, env = process.env) {
  const target = url instanceof URL ? url : new URL(url);
  const proxy = proxyFor(target, env);
  if (!proxy) {
    const client = target.protocol === "http:" ? http : https;
    return { req: client.request(target, options, onResponse), proxied: false };
  }
  if (target.protocol === "https:") {
    const agent = new TunnelAgent(proxy, options.timeout);
    return {
      req: https.request(target, { ...options, agent }, onResponse),
      proxied: true,
    };
  }
  const client = proxy.protocol === "https:" ? https : http;
  const req = client.request(
    {
      ...proxyTarget(proxy),
      method: options.method ?? "GET",
      path: target.href,
      headers: { Host: target.host, ...options.headers, ...proxyAuth(proxy) },
      timeout: options.timeout,
      agent: false,
    },
    onResponse,
  );
  return { req, proxied: true };
}

/**
 * The reason a request to `host` failed, for a one-line error: `could not
 * reach <host> (<code>)`, or `… through the proxy (<status or code>)`. It
 * names no proxy address, credential or query string.
 */
export function reachMessage(host, error, proxied) {
  const why = error.proxyStatus ?? error.code ?? error.message;
  return proxied
    ? `could not reach ${host} through the proxy (${why})`
    : `could not reach ${host} (${why})`;
}
