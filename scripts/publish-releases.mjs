#!/usr/bin/env node
/**
 * Publish per-theme GitHub releases + update the mutable `catalog` release.
 *
 * Expects dist/ from validate-and-pack.mjs (catalog.json + publish-manifest.json + zips).
 *
 * Env:
 *   GH_TOKEN / GITHUB_TOKEN  required for gh CLI
 *   GITHUB_REPOSITORY        owner/repo
 *   DIST_DIR                 default ./dist
 *   SKIP_VERSION_CHECK       if "1", do not fail when same version has different sha
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = process.env.DIST_DIR || join(ROOT, "dist");
const REPO = process.env.GITHUB_REPOSITORY || "LoganRickert/harborfm-themes";
const SKIP_VERSION_CHECK = process.env.SKIP_VERSION_CHECK === "1";
const CATALOG_TAG = "catalog";

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function gh(args, opts = {}) {
  return spawnSync("gh", args, {
    encoding: "utf8",
    env: process.env,
    ...opts,
  });
}

function ghOk(args) {
  const result = gh(args);
  if (result.status !== 0) {
    fail(`gh ${args.join(" ")} failed: ${result.stderr || result.stdout || "unknown"}`);
  }
  return (result.stdout || "").trim();
}

function releaseExists(tag) {
  const result = gh(["release", "view", tag, "--repo", REPO], { stdio: "pipe" });
  return result.status === 0;
}

function ensureRelease(tag, title) {
  if (releaseExists(tag)) {
    console.log(`release ${tag} exists`);
    return;
  }
  console.log(`creating release ${tag}`);
  ghOk([
    "release",
    "create",
    tag,
    "--repo",
    REPO,
    "--title",
    title,
    "--notes",
    `Theme package release ${tag}`,
  ]);
}

async function fetchPublishedCatalog() {
  const url = `https://github.com/${REPO}/releases/download/${CATALOG_TAG}/catalog.json`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "harborfm-themes-publish" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function main() {
  const catalogPath = join(DIST_DIR, "catalog.json");
  const manifestPath = join(DIST_DIR, "publish-manifest.json");
  if (!existsSync(catalogPath) || !existsSync(manifestPath)) {
    fail("Run validate-and-pack.mjs first (missing dist/catalog.json or publish-manifest.json)");
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const localCatalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const published = await fetchPublishedCatalog();

  const publishedById = new Map();
  if (published?.themes && Array.isArray(published.themes)) {
    for (const t of published.themes) {
      if (t?.id) publishedById.set(t.id, t);
    }
  }

  for (const theme of manifest.themes) {
    const prev = publishedById.get(theme.id);
    if (
      prev &&
      prev.version === theme.version &&
      prev.sha256 &&
      prev.sha256 !== theme.sha256 &&
      !SKIP_VERSION_CHECK
    ) {
      fail(
        `${theme.id}@${theme.version}: package content changed but version was not bumped (sha ${prev.sha256.slice(0, 8)}… → ${theme.sha256.slice(0, 8)}…). Bump theme.json version.`,
      );
    }

    const zipPath = join(DIST_DIR, theme.zipName);
    if (!existsSync(zipPath)) fail(`missing ${theme.zipName}`);

    if (
      releaseExists(theme.releaseTag) &&
      prev?.version === theme.version &&
      prev?.sha256 === theme.sha256
    ) {
      console.log(`skip ${theme.releaseTag} (unchanged)`);
      continue;
    }

    ensureRelease(theme.releaseTag, `${theme.id} v${theme.version}`);
    const assets = [zipPath];
    if (theme.previewAsset) {
      const previewPath = join(DIST_DIR, theme.previewAsset);
      if (existsSync(previewPath)) assets.push(previewPath);
    }
    console.log(
      `uploading ${theme.releaseTag}: ${assets.map((a) => a.split("/").pop()).join(", ")}`,
    );
    ghOk([
      "release",
      "upload",
      theme.releaseTag,
      ...assets,
      "--repo",
      REPO,
      "--clobber",
    ]);
  }

  ensureRelease(CATALOG_TAG, "Theme catalog");
  console.log(`uploading ${CATALOG_TAG}/catalog.json (${localCatalog.themes.length} themes)`);
  ghOk([
    "release",
    "upload",
    CATALOG_TAG,
    catalogPath,
    "--repo",
    REPO,
    "--clobber",
  ]);
  console.log("publish complete");
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
