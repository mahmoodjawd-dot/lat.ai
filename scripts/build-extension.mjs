// Copies the shared modules from web/shared into extension/shared. Chrome
// only loads files inside the extension folder, and web/shared is the single
// source of truth, so run this after changing anything in web/shared.

import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sharedSourceDirectory = join(projectRoot, "web", "shared");
const sharedExtensionDirectory = join(projectRoot, "extension", "shared");

rmSync(sharedExtensionDirectory, { recursive: true, force: true });
cpSync(sharedSourceDirectory, sharedExtensionDirectory, { recursive: true });
console.log("Copied web/shared → extension/shared. Reload the extension in chrome://extensions.");
