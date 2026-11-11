/**
 * A small glob matcher for config paths: `**` (any number of folders), `*`
 * and `?` (within one name), `[A-Z]` classes and `{a,b}` alternatives.
 * Paths use `/`.
 */

/** @param {string} glob */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        out += slash ? "(?:[^/]*/)*" : ".*";
        i += slash ? 2 : 1;
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close < 0) out += "\\[";
      else {
        const body = glob.slice(i + 1, close).replace(/\\/g, "\\\\");
        out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = close;
      }
    } else if (ch === "{") {
      const close = glob.indexOf("}", i + 1);
      if (close < 0) out += "\\{";
      else {
        out += `(?:${glob
          .slice(i + 1, close)
          .split(",")
          .map((part) => globToRegExp(part).source.slice(1, -1))
          .join("|")})`;
        i = close;
      }
    } else out += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** @param {RegExp} pattern @param {string} path */
export function matchFile(pattern, path) {
  return pattern.test(path.replace(/\\/g, "/"));
}
