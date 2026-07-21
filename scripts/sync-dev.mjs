#!/usr/bin/env node
/**
 * Copy gallery themes into the sibling HarborFM DATA_DIR as server themes.
 * Thin wrapper around HarborFM's sync-gallery-themes script.
 *
 * Usage (from harborfm-themes/):
 *   node scripts/sync-dev.mjs
 *
 * Or from HarborFM root:
 *   pnpm themes:sync
 */
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const galleryRoot = resolve(here, "..");
const harborRoot = resolve(galleryRoot, "..");
const script = join(harborRoot, "server/src/scripts/sync-gallery-themes.ts");

if (!existsSync(script)) {
  console.error(
    `HarborFM sync script not found at ${script}\n` +
      "Clone harborfm-themes next to the HarborFM repo (sibling folder).",
  );
  process.exit(1);
}

const env = {
  ...process.env,
  GALLERY_THEMES_DIR: galleryRoot,
};

const result = spawnSync(
  "pnpm",
  ["--filter", "server", "exec", "tsx", script],
  {
    cwd: harborRoot,
    env,
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
