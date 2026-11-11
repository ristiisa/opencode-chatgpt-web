/**
 * The production installer writes into the user's real OpenCode config. These
 * tests pin its contract: the provider and identity plugin land where OpenCode
 * V2 discovers them, existing settings survive install/reinstall/uninstall,
 * and status reports success only when every installed piece verifies.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultConfig } from "../src/config";
import {
  activateOpenCodeIntegration,
  deactivateOpenCodeIntegration,
  inspectOpenCodeIntegration,
  installOpenCodeIntegration,
  loadOpenCodeIdentityPluginBundle,
  OPENCODE_PLUGIN_MARKER,
  openCodeIntegrationPaths,
  preflightOpenCodeIntegration,
  readOpenCodeIntegrationJournal,
  readOpenCodeTurnSigningKey,
  uninstallOpenCodeIntegration,
  type OpenCodeIntegrationPaths,
} from "../src/opencode/host-integration";
import { opencodeConfigPath, opencodeGlobalConfigDir } from "../src/opencode/provider-limits";
import { parseOpenCodeIdentitySettings } from "../src/opencode/identity-settings";

const PROVIDER = "opencode-chatgpt-web";
const BUNDLE = "export default { id: \"fixture\", setup() {} };\n";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; paths: OpenCodeIntegrationPaths; config: ReturnType<typeof defaultConfig> } {
  const root = mkdtempSync(join(tmpdir(), "opencode-host-integration-"));
  roots.push(root);
  const paths = openCodeIntegrationPaths({ XDG_CONFIG_HOME: join(root, "xdg") }, "linux", join(root, "app-home"));
  const config = { ...defaultConfig("full"), browserInteractionMode: "automatic" as const, solAvailable: true };
  return { root, paths, config };
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("OpenCode config discovery paths", () => {
  test("follow OpenCode's XDG and home rules, including Windows %USERPROFILE%", () => {
    expect(opencodeGlobalConfigDir({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" }, "linux")).toBe(join("/xdg", "opencode"));
    expect(opencodeGlobalConfigDir({ HOME: "/home/u" }, "darwin")).toBe(join("/home/u", ".config", "opencode"));
    // npm/PowerShell installs on Windows: OpenCode uses os.homedir() (USERPROFILE), never an MSYS HOME.
    expect(opencodeGlobalConfigDir({ USERPROFILE: "C:\\Users\\me", HOME: "/c/Users/me" }, "win32"))
      .toBe(join("C:\\Users\\me", ".config", "opencode"));
    expect(opencodeGlobalConfigDir({ XDG_CONFIG_HOME: "D:\\cfg", USERPROFILE: "C:\\Users\\me" }, "win32"))
      .toBe(join("D:\\cfg", "opencode"));
    expect(opencodeConfigPath({ USERPROFILE: "C:\\Users\\me" }, "win32"))
      .toBe(join("C:\\Users\\me", ".config", "opencode", "opencode.json"));
    const paths = openCodeIntegrationPaths({ USERPROFILE: "C:\\Users\\me" }, "win32", "C:\\Users\\me\\.codex-chatgpt-web");
    expect(paths.pluginFile).toBe(join("C:\\Users\\me", ".config", "opencode", "plugins", "chatgpt-web-identity.js"));
    expect(paths.keyFile).toBe(join("C:\\Users\\me\\.codex-chatgpt-web", "opencode", "turn-signing.key"));
  });
});

describe("production OpenCode integration", () => {
  test("a fresh install registers the provider, plugin, sidecar and signing key and verifies", () => {
    const { paths, config } = fixture();
    const journal = installOpenCodeIntegration(config, { paths, pluginBundle: BUNDLE });
    const document = readJson(paths.configFile);
    const provider = document.providers[PROVIDER];
    expect(provider.package).toBe("@opencode/ai/providers/openai/responses");
    expect(provider.settings.baseURL).toBe(`http://127.0.0.1:${config.port}/v1`);
    expect(Object.keys(provider.models).length).toBeGreaterThan(0);
    for (const [suffix, model] of Object.entries<any>(provider.models)) {
      expect(model.modelID).toBe(`${PROVIDER}/${suffix}`);
      expect(model.limit.context).toBeGreaterThan(0);
    }
    // Production never takes over the user's default model or writes a legacy plugin list.
    expect(document.model).toBeUndefined();
    expect(document.plugins).toBeUndefined();
    expect(readFileSync(paths.pluginFile, "utf8").startsWith(OPENCODE_PLUGIN_MARKER)).toBe(true);
    const settings = parseOpenCodeIdentitySettings(readFileSync(paths.settingsFile, "utf8"));
    expect(settings).toEqual({
      version: 1, providerID: PROVIDER, bridgeURL: `http://127.0.0.1:${config.port}`, keyFile: paths.keyFile,
    });
    expect(readOpenCodeTurnSigningKey(paths.keyFile)?.length).toBe(32);
    expect(journal.createdConfigFile).toBe(true);
    const status = inspectOpenCodeIntegration(paths);
    expect(status).toMatchObject({ installed: true, active: true, errors: [], models: Object.keys(provider.models).length });
  });

  test("merges into an existing config without losing providers, plugins or user settings", () => {
    const { paths, config } = fixture();
    mkdirSync(join(paths.configDir, "plugins"), { recursive: true });
    const userPlugin = join(paths.configDir, "plugins", "my-plugin.ts");
    writeFileSync(userPlugin, "export default {}\n");
    const original = {
      $schema: "https://opencode.ai/config.json",
      model: "anthropic/claude-sonnet",
      theme: "tokyonight",
      provider: { ollama: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://localhost:11434/v1" } } },
      providers: { anthropic: { settings: { apiKey: "{env:ANTHROPIC_API_KEY}" } } },
      plugins: ["opencode-wakatime"],
      mcp: { files: { type: "local", command: ["npx", "files-mcp"] } },
    };
    writeFileSync(paths.configFile, `${JSON.stringify(original, null, 2)}\n`);
    installOpenCodeIntegration(config, { paths, pluginBundle: BUNDLE });
    const merged = readJson(paths.configFile);
    expect(Object.keys(merged)).toEqual(Object.keys(original));
    expect({ ...merged, providers: { anthropic: merged.providers.anthropic } }).toEqual(original);
    expect(merged.providers[PROVIDER]).toBeDefined();
    expect(readFileSync(userPlugin, "utf8")).toBe("export default {}\n");

    uninstallOpenCodeIntegration(paths);
    expect(readJson(paths.configFile)).toEqual(original);
    expect(existsSync(paths.pluginFile)).toBe(false);
    expect(existsSync(paths.settingsFile)).toBe(false);
    expect(existsSync(userPlugin)).toBe(true);
    expect(inspectOpenCodeIntegration(paths)).toMatchObject({ installed: false, active: false });
  });

  test("reinstall is idempotent and an upgrade rewrites only managed values", () => {
    const { paths, config } = fixture();
    installOpenCodeIntegration(config, { paths, pluginBundle: BUNDLE });
    const firstConfig = readFileSync(paths.configFile, "utf8");
    const firstJournal = readOpenCodeIntegrationJournal(paths);
    const firstKey = readFileSync(paths.keyFile, "utf8");
    installOpenCodeIntegration(config, { paths, pluginBundle: BUNDLE });
    expect(readFileSync(paths.configFile, "utf8")).toBe(firstConfig);
    expect(readOpenCodeIntegrationJournal(paths)).toEqual(firstJournal);
    expect(readFileSync(paths.keyFile, "utf8")).toBe(firstKey);
    expect(Object.keys(readJson(paths.configFile).providers)).toEqual([PROVIDER]);

    // Upgrade: new bridge port and plugin build replace the managed values in place.
    installOpenCodeIntegration({ ...config, port: config.port + 7 }, { paths, pluginBundle: `${BUNDLE}// v2\n` });
    expect(readJson(paths.configFile).providers[PROVIDER].settings.baseURL).toBe(`http://127.0.0.1:${config.port + 7}/v1`);
    expect(readFileSync(paths.pluginFile, "utf8")).toContain("// v2");
    expect(readFileSync(paths.keyFile, "utf8")).toBe(firstKey);
    expect(readOpenCodeIntegrationJournal(paths)?.createdConfigFile).toBe(true);
    expect(inspectOpenCodeIntegration(paths).errors).toEqual([]);

    // The installer created opencode.json, so uninstall removes it again.
    uninstallOpenCodeIntegration(paths);
    expect(existsSync(paths.configFile)).toBe(false);
  });

  test("restores a user-authored provider entry that shared the provider id", () => {
    const { paths, config } = fixture();
    mkdirSync(paths.configDir, { recursive: true });
    const custom = { name: "My hand-written entry", settings: { baseURL: "http://127.0.0.1:9999/v1" } };
    writeFileSync(paths.configFile, JSON.stringify({ providers: { [PROVIDER]: custom } }));
    installOpenCodeIntegration(config, { paths, pluginBundle: BUNDLE });
    installOpenCodeIntegration(config, { paths, pluginBundle: BUNDLE });
    expect(readJson(paths.configFile).providers[PROVIDER].name).toBe("OpenCode ChatGPT");
    uninstallOpenCodeIntegration(paths);
    expect(readJson(paths.configFile)).toEqual({ providers: { [PROVIDER]: custom } });
  });

  test("disconnect removes only the provider; connect and recovery restore it", () => {
    const { paths, config } = fixture();
    installOpenCodeIntegration(config, { paths, pluginBundle: BUNDLE });
    expect(deactivateOpenCodeIntegration({ paths, forRuntimeRecovery: true })).toEqual({ changed: true, active: false });
    expect(readJson(paths.configFile).providers?.[PROVIDER]).toBeUndefined();
    expect(existsSync(paths.pluginFile)).toBe(true);
    expect(inspectOpenCodeIntegration(paths)).toMatchObject({ installed: true, active: false, reconnectOnStartup: true, errors: [] });
    expect(activateOpenCodeIntegration({ paths, recoveryOnly: true })).toEqual({ changed: true, active: true });
    expect(readJson(paths.configFile).providers[PROVIDER]).toBeDefined();

    // An explicit disconnect is not undone by startup recovery.
    deactivateOpenCodeIntegration({ paths });
    expect(activateOpenCodeIntegration({ paths, recoveryOnly: true })).toEqual({ changed: false, active: false });
    // A disconnected integration stays disconnected across a setup upgrade when asked.
    installOpenCodeIntegration(config, { paths, pluginBundle: BUNDLE, preserveDisconnected: true });
    expect(inspectOpenCodeIntegration(paths)).toMatchObject({ active: false, errors: [] });
    expect(activateOpenCodeIntegration({ paths })).toEqual({ changed: true, active: true });
    expect(inspectOpenCodeIntegration(paths)).toMatchObject({ active: true, errors: [] });
  });

  test("status reports failure when installed pieces are missing or changed", () => {
    const { paths, config } = fixture();
    expect(inspectOpenCodeIntegration(paths)).toMatchObject({ installed: false, active: false });
    installOpenCodeIntegration(config, { paths, pluginBundle: BUNDLE });
    rmSync(paths.pluginFile);
    expect(inspectOpenCodeIntegration(paths).errors.join("\n")).toContain("identity plugin is missing");
    installOpenCodeIntegration(config, { paths, pluginBundle: BUNDLE });
    const document = readJson(paths.configFile);
    delete document.providers[PROVIDER];
    writeFileSync(paths.configFile, JSON.stringify(document));
    expect(inspectOpenCodeIntegration(paths).errors.join("\n")).toContain(`no providers["${PROVIDER}"]`);
    rmSync(paths.keyFile);
    expect(inspectOpenCodeIntegration(paths).errors.join("\n")).toContain("signing key is missing");
  });

  test("refuses to drop JSONC comments or overwrite a foreign plugin, and rolls back on failure", () => {
    const { paths, config } = fixture();
    mkdirSync(join(paths.configDir, "plugins"), { recursive: true });
    const commented = "{\n  // my theme\n  \"theme\": \"nord\"\n}\n";
    writeFileSync(paths.configFile, commented);
    expect(() => preflightOpenCodeIntegration(paths)).toThrow("not plain JSON");
    expect(() => installOpenCodeIntegration(config, { paths, pluginBundle: BUNDLE })).toThrow("not plain JSON");
    expect(readFileSync(paths.configFile, "utf8")).toBe(commented);
    expect(existsSync(paths.pluginFile)).toBe(false);

    writeFileSync(paths.configFile, "{\"theme\":\"nord\"}\n");
    writeFileSync(paths.pluginFile, "export default { id: \"someone-else\" }\n");
    expect(() => installOpenCodeIntegration(config, { paths, pluginBundle: BUNDLE })).toThrow("did not create");
    expect(readFileSync(paths.configFile, "utf8")).toBe("{\"theme\":\"nord\"}\n");
    expect(existsSync(paths.journalFile)).toBe(false);
  });

  test("keeps CRLF line endings and writes through a symlinked opencode.json", () => {
    const { root, paths, config } = fixture();
    mkdirSync(paths.configDir, { recursive: true });
    const dotfile = join(root, "dotfiles-opencode.json");
    writeFileSync(dotfile, "{\r\n  \"theme\": \"nord\"\r\n}\r\n");
    symlinkSync(dotfile, paths.configFile);
    installOpenCodeIntegration(config, { paths, pluginBundle: BUNDLE });
    expect(readFileSync(dotfile, "utf8")).toContain("\r\n");
    expect(readFileSync(dotfile, "utf8").replace(/\r\n/g, "")).not.toContain("\n");
    expect(JSON.parse(readFileSync(dotfile, "utf8")).providers[PROVIDER]).toBeDefined();
    uninstallOpenCodeIntegration(paths);
    expect(JSON.parse(readFileSync(dotfile, "utf8"))).toEqual({ theme: "nord" });
    expect(readFileSync(paths.configFile, "utf8")).toBe(readFileSync(dotfile, "utf8"));
  });
});

describe("installed identity plugin bundle", () => {
  test("is self-contained and loads as an OpenCode V2 plugin from the plugins directory", async () => {
    const { paths, config } = fixture();
    const bundle = await loadOpenCodeIdentityPluginBundle(join(import.meta.dir, "..", "src", "opencode"));
    // Nothing may resolve relative to this repository or runtime once copied into OpenCode.
    const imports = [...bundle.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(match => match[1]);
    expect(imports.every(specifier => specifier!.startsWith("node:"))).toBe(true);
    installOpenCodeIntegration(config, { paths, pluginBundle: bundle });
    const loaded = await import(`${pathToFileURL(paths.pluginFile).href}?t=${Date.now()}`);
    expect(loaded.default.id).toBe("opencode-chatgpt-web-identity");
    expect(typeof loaded.default.setup).toBe("function");
    expect(inspectOpenCodeIntegration(paths).errors).toEqual([]);
  });
});
