/** Names and sidecar format shared by the installer and the installed identity plugin. */
export const OPENCODE_IDENTITY_PLUGIN_FILE = "chatgpt-web-identity.js";
export const OPENCODE_IDENTITY_SETTINGS_FILE = "chatgpt-web-identity.json";

export interface OpenCodeIdentitySettings {
  version: 1;
  providerID: string;
  bridgeURL: string;
  keyFile: string;
}

export function parseOpenCodeIdentitySettings(text: string): OpenCodeIdentitySettings {
  const value = JSON.parse(text) as Partial<OpenCodeIdentitySettings> | null;
  if (value?.version !== 1 || typeof value.providerID !== "string" || typeof value.bridgeURL !== "string"
    || typeof value.keyFile !== "string") {
    throw new Error("OpenCode chatgpt-web identity settings are invalid");
  }
  return value as OpenCodeIdentitySettings;
}
