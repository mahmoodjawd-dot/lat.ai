// Copies the SDK (web/cursor-agent.js) into the extension. Chrome only loads
// files inside the extension folder, and web/cursor-agent.js is the single
// source of truth, so run this after changing the SDK.

import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
copyFileSync(join(projectRoot, "web", "cursor-agent.js"), join(projectRoot, "extension", "cursor-agent.js"));
console.log("Copied web/cursor-agent.js → extension/cursor-agent.js. Reload the extension in chrome://extensions.");
