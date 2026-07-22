#!/usr/bin/env node
/**
 * Discover theme packages (dirs with theme.json), validate, zip, write catalog.json.
 *
 * Download URLs use per-theme release tags: `{id}-v{version}`.
 * The mutable GitHub release tag `catalog` hosts only catalog.json.
 *
 * Env:
 *   GITHUB_REPOSITORY  owner/repo (default LoganRickert/harborfm-themes)
 *   DOWNLOAD_BASE      optional absolute/relative URL prefix for zips + previews
 *                      (overrides GitHub per-theme URLs; e.g. /theme-gallery)
 *   CATALOG_NAME       top-level catalog name (default "HarborFM Themes")
 *   OUT_DIR            output directory (default ./dist)
 *   MAX_ZIP_BYTES      max packed size (default 10 MiB)
 */
import {
  createHash,
} from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR || join(ROOT, "dist");
const MAX_ZIP_BYTES = Number(process.env.MAX_ZIP_BYTES || 10 * 1024 * 1024);
const REPO = process.env.GITHUB_REPOSITORY || "LoganRickert/harborfm-themes";
const CATALOG_NAME = (process.env.CATALOG_NAME || "HarborFM Themes").trim() || "HarborFM Themes";

const PACKAGE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const PREVIEW_RE =
  /^images\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|jpe?g|gif|webp|svg)$/i;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const FONT_EXT = new Set([".woff2", ".ttf"]);
const ALLOWED_EXT = new Set([
  ".liquid",
  ".css",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
]);

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function walkFiles(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkFiles(full, rel));
    else out.push({ rel: rel.replace(/\\/g, "/"), full, size: st.size });
  }
  return out;
}

function isAllowedPackagePath(name) {
  if (name === "theme.json") return true;
  const ext = extname(name).toLowerCase();
  if (name.startsWith("fonts/")) {
    const rest = name.slice("fonts/".length);
    return FONT_EXT.has(ext) && !!rest && !rest.includes("/");
  }
  if (!ALLOWED_EXT.has(ext)) return false;
  if (name.startsWith("css/") || name.startsWith("images/")) {
    const rest = name.slice(name.indexOf("/") + 1);
    return !!rest && !rest.includes("/");
  }
  if (name.startsWith("templates/")) {
    const rest = name.slice("templates/".length);
    return !!rest && !rest.includes("/") && rest.toLowerCase().endsWith(".liquid");
  }
  return false;
}

function parseManifest(dir) {
  const raw = readFileSync(join(dir, "theme.json"), "utf8");
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    fail(`${relative(ROOT, dir)}/theme.json: invalid JSON`);
  }
  if (!json || typeof json !== "object") {
    fail(`${relative(ROOT, dir)}/theme.json: must be an object`);
  }
  const id = String(json.id ?? "");
  const name = String(json.name ?? "");
  const version = String(json.version ?? "");
  if (!PACKAGE_ID_RE.test(id) || id.length > 64) {
    fail(`${relative(ROOT, dir)}: invalid id "${id}"`);
  }
  if (!name || name.length > 120) fail(`${relative(ROOT, dir)}: invalid name`);
  if (!version || version.length > 64) fail(`${relative(ROOT, dir)}: invalid version`);
  const preview =
    json.preview === undefined || json.preview === null
      ? undefined
      : String(json.preview);
  if (preview !== undefined) {
    if (!PREVIEW_RE.test(preview)) {
      fail(`${relative(ROOT, dir)}: invalid preview path "${preview}"`);
    }
  }
  const homepage =
    json.homepage === undefined || json.homepage === null
      ? undefined
      : String(json.homepage).trim();
  if (homepage !== undefined) {
    if (!/^https:\/\/[^\s]+$/i.test(homepage) || homepage.length > 500) {
      fail(`${relative(ROOT, dir)}: invalid homepage URL "${homepage}"`);
    }
  }
  const catalog =
    json.catalog === undefined || json.catalog === null
      ? undefined
      : String(json.catalog).trim();
  if (catalog !== undefined) {
    if (!/^https?:\/\/[^\s]+$/i.test(catalog) || catalog.length > 500) {
      fail(`${relative(ROOT, dir)}: invalid catalog URL "${catalog}"`);
    }
  }
  const description =
    json.description === undefined || json.description === null
      ? undefined
      : String(json.description).trim();
  if (description !== undefined) {
    if (!description || description.length > 280) {
      fail(`${relative(ROOT, dir)}: description must be 1–280 characters`);
    }
  }
  const notFound =
    json.not_found === undefined || json.not_found === null
      ? undefined
      : String(json.not_found).trim();
  if (notFound !== undefined && !/^[a-z0-9][a-z0-9_-]*$/.test(notFound)) {
    fail(`${relative(ROOT, dir)}: invalid not_found template "${notFound}"`);
  }
  return {
    id,
    name,
    version,
    description,
    preview,
    homepage,
    catalog,
    index: json.index,
    not_found: notFound,
    pages: json.pages,
  };
}

function discoverPackages() {
  const packages = [];
  for (const entry of readdirSync(ROOT)) {
    if (entry.startsWith(".")) continue;
    if (entry === "scripts" || entry === "dist" || entry === "node_modules") continue;
    const dir = join(ROOT, entry);
    if (!statSync(dir).isDirectory()) continue;
    if (!existsSync(join(dir, "theme.json"))) continue;
    packages.push({ folder: entry, dir });
  }
  return packages.sort((a, b) => a.folder.localeCompare(b.folder));
}

function validatePackage({ folder, dir }) {
  const manifest = parseManifest(dir);
  if (manifest.id !== folder) {
    fail(`${folder}: folder name must match theme.json id "${manifest.id}"`);
  }
  if (!existsSync(join(dir, "templates", "podcast.liquid"))) {
    fail(`${folder}: missing templates/podcast.liquid`);
  }
  if (!existsSync(join(dir, "templates", "episode.liquid"))) {
    fail(`${folder}: missing templates/episode.liquid`);
  }
  if (manifest.not_found) {
    const nf = join(dir, "templates", `${manifest.not_found}.liquid`);
    if (!existsSync(nf) || !statSync(nf).isFile()) {
      fail(`${folder}: not_found template missing: templates/${manifest.not_found}.liquid`);
    }
  }
  if (manifest.preview) {
    const previewFull = join(dir, manifest.preview);
    if (!existsSync(previewFull) || !statSync(previewFull).isFile()) {
      fail(`${folder}: preview file not found: ${manifest.preview}`);
    }
    const ext = extname(manifest.preview).toLowerCase();
    if (!IMAGE_EXT.has(ext)) {
      fail(`${folder}: preview must be an image file`);
    }
  }

  const files = walkFiles(dir);
  for (const f of files) {
    if (!isAllowedPackagePath(f.rel)) {
      fail(`${folder}: disallowed path in package: ${f.rel}`);
    }
  }
  return { manifest, files };
}

function zipPackage(dir, zipPath) {
  mkdirSync(dirname(zipPath), { recursive: true });
  if (existsSync(zipPath)) rmSync(zipPath);
  const result = spawnSync(
    "zip",
    ["-r", "-q", zipPath, ".", "-x", "*.DS_Store", "*__MACOSX*", "*.git*"],
    { cwd: dir, encoding: "utf8" },
  );
  if (result.status !== 0) {
    fail(`zip failed for ${dir}: ${result.stderr || result.stdout || "unknown error"}`);
  }
  const size = statSync(zipPath).size;
  if (size > MAX_ZIP_BYTES) {
    fail(
      `${relative(ROOT, dir)}: zip is ${size} bytes (max ${MAX_ZIP_BYTES}). Shrink images or assets.`,
    );
  }
  return size;
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function themeReleaseTag(id, version) {
  return `${id}-v${version}`;
}

function main() {
  const downloadBaseEnv = (process.env.DOWNLOAD_BASE || "").trim().replace(/\/$/, "");

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const packages = discoverPackages();
  if (packages.length === 0) {
    console.log("No theme packages found (dirs with theme.json). Writing empty catalog.");
  }

  const catalog = {
    name: CATALOG_NAME,
    generatedAt: new Date().toISOString(),
    themes: [],
  };
  const publishManifest = {
    catalogName: CATALOG_NAME,
    themes: [],
  };

  for (const pkg of packages) {
    const { manifest } = validatePackage(pkg);
    const releaseTag = themeReleaseTag(manifest.id, manifest.version);
    const zipName = `${manifest.id}-${manifest.version}-theme.zip`;
    const zipPath = join(OUT_DIR, zipName);
    const byteSize = zipPackage(pkg.dir, zipPath);
    const sha256 = sha256File(zipPath);

    const themeDownloadBase =
      downloadBaseEnv ||
      `https://github.com/${REPO}/releases/download/${releaseTag}`;

    const entry = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      downloadUrl: `${themeDownloadBase}/${zipName}`,
      byteSize,
      sha256,
    };

    if (manifest.description) {
      entry.description = manifest.description;
    }

    if (manifest.homepage) {
      entry.homepage = manifest.homepage;
    }

    let previewAsset = null;
    if (manifest.preview) {
      const ext = extname(manifest.preview).toLowerCase();
      previewAsset = `${manifest.id}-preview${ext}`;
      cpSync(join(pkg.dir, manifest.preview), join(OUT_DIR, previewAsset));
      entry.preview = manifest.preview;
      entry.previewUrl = `${themeDownloadBase}/${previewAsset}`;
    }

    catalog.themes.push(entry);
    publishManifest.themes.push({
      id: manifest.id,
      version: manifest.version,
      releaseTag,
      zipName,
      previewAsset,
      byteSize,
      sha256,
    });
    console.log(`packed ${manifest.id}@${manifest.version} → ${releaseTag} (${byteSize} bytes)`);
  }

  writeFileSync(join(OUT_DIR, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  writeFileSync(
    join(OUT_DIR, "publish-manifest.json"),
    `${JSON.stringify(publishManifest, null, 2)}\n`,
  );
  console.log(`wrote ${join(OUT_DIR, "catalog.json")} (${catalog.themes.length} themes)`);
}

main();
