/**
 * Entry point for the production OpenCode identity plugin. The installer
 * bundles this module into one self-contained `chatgpt-web-identity.js` inside
 * OpenCode's global `plugins/` directory, next to a JSON sidecar that names the
 * bridge URL and the signing key file shared with the launcher-owned bridge.
 * OpenCode only loads `.js`/`.ts` files and directories from `plugins/`, so the
 * sidecar is never mistaken for a plugin, and the key itself is never copied
 * into OpenCode's config. Only this module's default export is a plugin.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createOpenCodeIdentityPlugin } from "./identity-plugin";
import { OPENCODE_IDENTITY_SETTINGS_FILE, parseOpenCodeIdentitySettings } from "./identity-settings";

const settings = parseOpenCodeIdentitySettings(readFileSync(
  fileURLToPath(new URL(`./${OPENCODE_IDENTITY_SETTINGS_FILE}`, import.meta.url)), "utf8"));

export default createOpenCodeIdentityPlugin({
  providerID: settings.providerID,
  bridgeURL: settings.bridgeURL,
  keyFile: settings.keyFile,
});
