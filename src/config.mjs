/**
 * design-kit.config.json: finding it, validating it against the v1 schema
 * shipped in this package (schema/design-kit.config.schema.json), and
 * resolving it into the shape the captures use. A config error names the
 * field and exits 2.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_NAME = "design-kit.config.json";
export const SCHEMA_PATH = fileURLToPath(
  new URL("../schema/design-kit.config.schema.json", import.meta.url),
);
export const DEFAULT_FIXED_TIME = "2026-01-01T12:00:00.000Z";
export const DEFAULT_PAGE_WIDTHS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

/** A problem with the config or the command line: exit 2. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

let schemaCache = null;
export function configSchema() {
  schemaCache ??= JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  return schemaCache;
}

// ── validation (the subset of JSON Schema the shipped schema uses) ──────────

function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function fieldName(path) {
  return path.length ? path.join("").replace(/^\./, "") : "(the config)";
}

/**
 * Every place `value` breaks `schema`, as "<field>: <problem>" strings, in
 * document order.
 */
export function validate(value, schema = configSchema(), root = schema) {
  const errors = [];
  const walk = (node, rule, path) => {
    if (rule.$ref) {
      const name = rule.$ref.replace(/^#\/\$defs\//, "");
      walk(node, { ...root.$defs[name], ...rule, $ref: undefined }, path);
      return;
    }
    const field = fieldName(path);
    const actual = typeOf(node);
    if (rule.type) {
      const ok =
        actual === rule.type ||
        (rule.type === "number" && actual === "integer");
      if (!ok) {
        errors.push(`${field}: must be ${an(rule.type)}, not ${an(actual)}`);
        return;
      }
    }
    if (rule.enum && !rule.enum.includes(node)) {
      errors.push(
        `${field}: must be ${rule.enum.map((v) => JSON.stringify(v)).join(" or ")}`,
      );
    }
    if (actual === "string") {
      if (rule.minLength && node.length < rule.minLength)
        errors.push(`${field}: must not be empty`);
      if (rule.pattern && !new RegExp(rule.pattern).test(node))
        errors.push(`${field}: must match ${rule.pattern}`);
    }
    if (
      (actual === "integer" || actual === "number") &&
      rule.minimum !== undefined
    ) {
      if (node < rule.minimum)
        errors.push(`${field}: must be at least ${rule.minimum}`);
    }
    if (actual === "array") {
      if (rule.minItems && node.length < rule.minItems)
        errors.push(
          `${field}: needs at least ${rule.minItems} item${rule.minItems === 1 ? "" : "s"}`,
        );
      if (rule.items)
        node.forEach((item, index) =>
          walk(item, rule.items, [...path, `[${index}]`]),
        );
    }
    if (actual === "object") {
      for (const key of rule.required ?? []) {
        if (!(key in node))
          errors.push(`${fieldName([...path, `.${key}`])}: is required`);
      }
      for (const [key, child] of Object.entries(node)) {
        const childPath = [...path, `.${key}`];
        if (rule.properties && key in rule.properties) {
          walk(child, rule.properties[key], childPath);
        } else if (rule.additionalProperties === false) {
          errors.push(`${fieldName(childPath)}: unknown key`);
        } else if (
          rule.additionalProperties &&
          typeof rule.additionalProperties === "object"
        ) {
          walk(child, rule.additionalProperties, childPath);
        }
      }
    }
  };
  walk(value, schema, []);
  return errors;
}

function an(type) {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

// ── loading ─────────────────────────────────────────────────────────────────

/** The nearest design-kit.config.json at or above `from`, or null. */
export function findConfig(from = process.cwd()) {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, CONFIG_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Reads, validates and resolves a config. `file` defaults to the nearest
 * design-kit.config.json above the working directory.
 */
export function loadConfig(file) {
  const path = file ? resolve(file) : findConfig();
  if (!path) {
    throw new ConfigError(
      `no ${CONFIG_NAME} here or in any folder above; pass --config <file>`,
    );
  }
  if (!existsSync(path)) throw new ConfigError(`${path}: no such file`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`${path}: not valid JSON (${error.message})`);
  }
  return resolveConfig(raw, path);
}

/** Validates a parsed config and resolves its paths against `path`'s folder. */
export function resolveConfig(raw, path) {
  const errors = validate(raw);
  if (!errors.length && !raw.stories && !raw.pages) {
    errors.push("(the config): needs a stories or a pages section");
  }
  raw.stories?.widths?.forEach((width, index) => {
    try {
      new RegExp(width.titles);
    } catch (error) {
      errors.push(
        `stories.widths[${index}].titles: not a regular expression (${error.message})`,
      );
    }
  });
  for (const [key, section] of [
    ["stories", raw.stories],
    ["pages", raw.pages],
  ]) {
    if (section?.fixedTime && Number.isNaN(Date.parse(section.fixedTime)))
      errors.push(`${key}.fixedTime: not an ISO 8601 date`);
  }
  if (raw.pages?.auth?.storageState && raw.pages?.auth?.setup) {
    errors.push("pages.auth: give storageState or setup, not both");
  }
  if (raw.pages?.startCommand && !raw.pages?.waitUrl) {
    errors.push("pages.waitUrl: is required with pages.startCommand");
  }
  const names = new Set();
  raw.pages?.pages?.forEach((page, index) => {
    if (names.has(page?.name))
      errors.push(`pages.pages[${index}].name: "${page.name}" is used twice`);
    names.add(page?.name);
  });
  if (!errors.length && raw.storage) errors.push(...storageErrors(raw.storage));
  if (errors.length) {
    throw new ConfigError(
      `${path}:\n${errors.map((error) => `  ${error}`).join("\n")}`,
    );
  }

  const configDir = dirname(path);
  const at = (value) =>
    value === undefined ? undefined : resolve(configDir, value);
  const config = {
    file: path,
    configDir,
    raw,
    out: at(raw.out),
    storage: raw.storage ? { ...raw.storage } : { type: "github" },
    theme: raw.theme ? normalizeTheme(raw.theme) : undefined,
  };
  if (raw.stories) {
    const s = raw.stories;
    const root = at(s.root ?? ".");
    config.stories = {
      root,
      storybookDir: at(s.storybookDir),
      buildCommand: s.buildCommand,
      staticDir: s.staticDir ? resolve(root, s.staticDir) : undefined,
      viewport: s.viewport ?? { width: 1280, height: 800 },
      widths: (s.widths ?? []).map((w) => ({
        titles: new RegExp(w.titles),
        width: w.width,
        height: w.height,
      })),
      fonts: s.fonts ? { dir: at(s.fonts.dir), faces: s.fonts.faces } : null,
      fixedTime: s.fixedTime ?? DEFAULT_FIXED_TIME,
      gaps: s.gaps
        ? {
            sourceRoot: s.gaps.sourceRoot ? at(s.gaps.sourceRoot) : root,
            componentGlob: s.gaps.componentGlob,
          }
        : null,
    };
  }
  if (raw.pages) {
    const p = raw.pages;
    config.pages = {
      source: p.source ?? null,
      baseUrl: p.baseUrl,
      startCommand: p.startCommand,
      waitUrl: p.waitUrl,
      cwd: at(p.cwd) ?? configDir,
      startTimeoutMs: p.startTimeoutMs ?? 120_000,
      auth: {
        storageState: at(p.auth?.storageState),
        setup: at(p.auth?.setup),
      },
      hooks: at(p.hooks),
      widths: p.widths ?? DEFAULT_PAGE_WIDTHS,
      fixedTime: p.fixedTime ?? DEFAULT_FIXED_TIME,
      shellReady: p.shellReady,
      layout: p.layout
        ? { ...p.layout, default: p.layout.default ?? "default" }
        : null,
      fontsPath: p.fontsPath ?? null,
      copyFonts: p.copyFonts ?? true,
      timeoutMs: p.timeoutMs ?? 30_000,
      forbidStrings: p.forbidStrings ?? [],
      pages: p.pages,
    };
  }
  return config;
}

/** The keys each storage type takes, and which of them it needs. */
const STORAGE_KEYS = {
  github: { allowed: [], required: [] },
  codepress: { allowed: ["url", "apiUrl"], required: [] },
  s3: {
    allowed: ["bucket", "prefix", "region", "endpoint"],
    required: ["bucket"],
  },
  r2: {
    allowed: ["accountId", "bucket", "prefix"],
    required: ["accountId", "bucket"],
  },
};

/** What the schema cannot say about `storage`: the keys each type takes. */
function storageErrors(storage) {
  const keys = STORAGE_KEYS[storage.type];
  if (!keys) return [];
  const errors = [];
  for (const key of keys.required)
    if (!(key in storage))
      errors.push(`storage.${key}: is required for ${storage.type} storage`);
  for (const key of Object.keys(storage)) {
    if (key === "type") continue;
    if (!keys.allowed.includes(key))
      errors.push(
        `storage.${key}: not used by ${storage.type} storage${key === "endpoint" && storage.type === "r2" ? " (r2 derives it from accountId)" : ""}`,
      );
    else if (/^TODO/.test(String(storage[key])))
      errors.push(`storage.${key}: still ${storage[key]}`);
    else if (key === "accountId" && !/^[A-Za-z0-9]+$/.test(storage[key]))
      errors.push(
        "storage.accountId: must be your Cloudflare account id, letters and digits only",
      );
  }
  return errors;
}

/** The theme as the manifest records it, with its defaults filled in. */
export function normalizeTheme(theme) {
  const attribute = theme.attribute ?? "class";
  return {
    attribute,
    dark: theme.dark ?? "dark",
    ...(theme.light ? { light: theme.light } : {}),
    targets:
      theme.targets ?? (attribute === "class" ? ["html", "body"] : ["html"]),
  };
}
