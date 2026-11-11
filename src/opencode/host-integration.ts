/**
 * Production OpenCode integration. The upstream Codex harness patched
 * `~/.codex/config.toml`; OpenCode instead discovers providers from its global
 * `opencode.json` and plugins from the sibling `plugins/` directory. This
 * module installs, verifies, disconnects, reconnects and removes:
 *
 * - `providers["opencode-chatgpt-web"]` in the user's real `opencode.json`,
 *   merged into (never replacing) their existing providers and settings;
 * - a self-contained `plugins/chatgpt-web-identity.js` bundle plus its JSON
 *   sidecar naming the bridge URL and the signing key file;
 * - the turn signing key shared with the launcher-owned bridge, kept in the
 *   private application home rather than OpenCode's config.
 *
 * A journal in the application home records what existed before, so reinstall
 * is idempotent and uninstall restores a pre-existing provider entry and
 * removes files this installer created.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir, type AppConfig } from "../config";
import {
  OPENCODE_IDENTITY_PLUGIN_FILE, OPENCODE_IDENTITY_SETTINGS_FILE, parseOpenCodeIdentitySettings,
  type OpenCodeIdentitySettings,
} from "./identity-settings";
import { buildOpenCodeProviderEntry, OPENCODE_PROVIDER_ID, OPENCODE_PROVIDER_PACKAGE, type OpenCodeProviderEntry } from "./provider-catalog";
import { opencodeGlobalConfigDir } from "./provider-limits";
import { parseTurnSigningKey } from "./turn-binding";

/** First line of every managed plugin file; identifies files this installer may replace or remove. */
export const OPENCODE_PLUGIN_MARKER = "// Managed by opencode-chatgpt-web; removed by the launcher's Remove integration.";
const PREBUILT_PLUGIN_BUNDLE = "opencode-identity-plugin.js";
/** OpenCode never reads this value: the bridge authenticates the signed turn header instead. */
const PROVIDER_API_KEY = "local-bridge-signed-turns";

export interface OpenCodeIntegrationPaths {
  configDir: string;
  configFile: string;
  pluginsDir: string;
  pluginFile: string;
  settingsFile: string;
  keyFile: string;
  journalFile: string;
}

export interface OpenCodeIntegrationJournal {
  version: 1;
  active: boolean;
  reconnectOnStartup?: true;
  configFile: string;
  /** The installer created opencode.json; uninstall removes it again when nothing else was added. */
  createdConfigFile: boolean;
  /** The installer added the top-level `providers` object. */
  createdProvidersKey: boolean;
  /** A user-authored provider entry that existed under the same id before the first install. */
  previousProvider?: unknown;
  installed: { baseURL: string; provider: OpenCodeProviderEntry; models: number };
  pluginSha256: string;
  settingsSha256: string;
}

export interface OpenCodeIntegrationStatus {
  installed: boolean;
  active: boolean;
  reconnectOnStartup?: boolean;
  configPath: string;
  pluginPath: string;
  routeUrl?: string;
  models: number;
  errors: string[];
}

export function openCodeIntegrationPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  appHome = getConfigDir(),
): OpenCodeIntegrationPaths {
  const configDir = opencodeGlobalConfigDir(env, platform);
  const pluginsDir = join(configDir, "plugins");
  return {
    configDir,
    configFile: join(configDir, "opencode.json"),
    pluginsDir,
    pluginFile: join(pluginsDir, OPENCODE_IDENTITY_PLUGIN_FILE),
    settingsFile: join(pluginsDir, OPENCODE_IDENTITY_SETTINGS_FILE),
    keyFile: join(appHome, "opencode", "turn-signing.key"),
    journalFile: join(appHome, "opencode", "integration-journal.json"),
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Dotfile managers often symlink opencode.json; write through to the real file instead of replacing the link. */
function resolveWriteTarget(path: string): string {
  try {
    if (lstatSync(path).isSymbolicLink()) return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return path;
}

/** Atomic replace that keeps the user's file mode and never tightens the OpenCode config directory. */
function writeUserFile(path: string, text: string, defaultMode: number): void {
  const target = resolveWriteTarget(path);
  mkdirSync(dirname(target), { recursive: true });
  let mode = defaultMode;
  try { mode = statSync(target).mode & 0o777; } catch { /* new file */ }
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temporary, text, { flag: "wx", mode });
    try { chmodSync(temporary, mode); } catch { /* Windows ignores POSIX modes */ }
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function lineEnding(text: string | undefined): string {
  return text?.includes("\r\n") ? "\r\n" : "\n";
}

function serializeConfig(document: Record<string, unknown>, previousText: string | undefined): string {
  const eol = lineEnding(previousText);
  return `${JSON.stringify(document, null, 2).replace(/\n/g, eol)}${eol}`;
}

/**
 * opencode.json is parsed strictly. OpenCode tolerates JSONC comments there,
 * but rewriting such a file would silently drop the user's comments, so the
 * installer refuses and names the file instead.
 */
function parseOpenCodeConfig(path: string, text: string | undefined): Record<string, unknown> {
  if (text === undefined || text.trim() === "") return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text.replace(/^﻿/, "")); }
  catch {
    throw new Error(
      `OpenCode config is not plain JSON (comments or a syntax error): ${path}. `
      + "Remove the comments or fix the syntax, then install the OpenCode integration again.",
    );
  }
  if (!isRecord(parsed)) throw new Error(`OpenCode config must be a JSON object: ${path}`);
  if (parsed.providers !== undefined && !isRecord(parsed.providers)) {
    throw new Error(`OpenCode config has a non-object "providers" value: ${path}`);
  }
  return parsed;
}

export function readOpenCodeIntegrationJournal(paths = openCodeIntegrationPaths()): OpenCodeIntegrationJournal | undefined {
  const text = readText(paths.journalFile);
  if (text === undefined) return undefined;
  const journal = JSON.parse(text) as OpenCodeIntegrationJournal;
  if (journal?.version !== 1 || typeof journal.configFile !== "string" || !isRecord(journal.installed)) {
    throw new Error(`OpenCode integration journal is invalid: ${paths.journalFile}`);
  }
  return journal;
}

function writeJournal(paths: OpenCodeIntegrationPaths, journal: OpenCodeIntegrationJournal): void {
  atomicWriteFile(paths.journalFile, `${JSON.stringify(journal, null, 2)}\n`);
}

/** Creates the bridge/plugin signing key once; later installs and upgrades reuse it. */
export function ensureOpenCodeTurnSigningKey(path: string): Buffer {
  const existing = readText(path);
  if (existing !== undefined) return parseTurnSigningKey(existing.trim());
  atomicWriteFile(path, `${randomBytes(32).toString("hex")}\n`);
  return parseTurnSigningKey(readFileSync(path, "utf8").trim());
}

/** The production bridge reads the same key the installed plugin signs with. */
export function readOpenCodeTurnSigningKey(path = openCodeIntegrationPaths().keyFile): Buffer | undefined {
  const text = readText(path);
  return text === undefined ? undefined : parseTurnSigningKey(text.trim());
}

/**
 * The packaged runtime ships a prebuilt bundle next to its CLI; a source
 * checkout builds the same entry on demand. Either way the installed plugin
 * has no import that depends on where this runtime lives.
 */
export async function loadOpenCodeIdentityPluginBundle(directory = import.meta.dir): Promise<string> {
  const prebuilt = join(directory, PREBUILT_PLUGIN_BUNDLE);
  if (existsSync(prebuilt)) return readFileSync(prebuilt, "utf8");
  const entry = join(directory, "identity-plugin-entry.ts");
  if (!existsSync(entry)) throw new Error(`OpenCode identity plugin bundle is missing from this runtime: ${prebuilt}`);
  const build = await Bun.build({ entrypoints: [entry], target: "node", format: "esm", minify: false });
  if (!build.success || build.outputs.length !== 1) {
    throw new Error(`OpenCode identity plugin build failed: ${build.logs.map(log => log.message).join("; ")}`);
  }
  return await build.outputs[0]!.text();
}

export function renderOpenCodePlugin(bundle: string): string {
  return `${OPENCODE_PLUGIN_MARKER}\n${bundle.endsWith("\n") ? bundle : `${bundle}\n`}`;
}

function assertReplaceablePlugin(path: string, journal: OpenCodeIntegrationJournal | undefined): void {
  const current = readText(path);
  if (current === undefined || current.startsWith(OPENCODE_PLUGIN_MARKER)) return;
  if (journal && sha256(current) === journal.pluginSha256) return;
  throw new Error(`Refusing to overwrite an OpenCode plugin this installer did not create: ${path}`);
}

export function openCodeBridgeBaseURL(config: Pick<AppConfig, "host" | "port">): string {
  return `http://${config.host}:${config.port}/v1`;
}

export function preflightOpenCodeIntegration(paths = openCodeIntegrationPaths()): void {
  const journal = readOpenCodeIntegrationJournal(paths);
  parseOpenCodeConfig(paths.configFile, readText(paths.configFile));
  assertReplaceablePlugin(paths.pluginFile, journal);
}

interface Snapshot { path: string; text: string | undefined }

function snapshot(path: string): Snapshot {
  return { path: resolveWriteTarget(path), text: readText(path) };
}

function restore(snapshots: Snapshot[]): string[] {
  const failures: string[] = [];
  for (const item of [...snapshots].reverse()) {
    try {
      if (item.text === undefined) rmSync(item.path, { force: true });
      else writeUserFile(item.path, item.text, 0o600);
    } catch (error) {
      failures.push(`${item.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

function transaction<T>(paths: string[], body: () => T): T {
  const snapshots = paths.map(snapshot);
  try {
    return body();
  } catch (error) {
    const failures = restore(snapshots);
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(failures.length ? `${primary}; OpenCode integration rollback also failed: ${failures.join("; ")}` : primary);
  }
}

function withProvider(
  document: Record<string, unknown>,
  provider: OpenCodeProviderEntry | undefined,
  previousProvider: unknown,
  dropEmptyProviders: boolean,
): Record<string, unknown> {
  const providers = isRecord(document.providers) ? { ...document.providers } : {};
  if (provider) providers[OPENCODE_PROVIDER_ID] = provider;
  else if (previousProvider !== undefined) providers[OPENCODE_PROVIDER_ID] = previousProvider;
  else delete providers[OPENCODE_PROVIDER_ID];
  const next = { ...document };
  if (Object.keys(providers).length === 0 && dropEmptyProviders) delete next.providers;
  else next.providers = providers;
  return next;
}

function isOurProvider(value: unknown): boolean {
  return isRecord(value) && value.package === OPENCODE_PROVIDER_PACKAGE && isRecord(value.settings)
    && value.settings.apiKey === PROVIDER_API_KEY;
}

export interface InstallOpenCodeIntegrationOptions {
  paths?: OpenCodeIntegrationPaths;
  /** The bundled identity plugin source (see loadOpenCodeIdentityPluginBundle). */
  pluginBundle: string;
  /** Keep a launcher-disconnected integration disconnected while upgrading its files. */
  preserveDisconnected?: boolean;
}

export function installOpenCodeIntegration(
  config: AppConfig,
  options: InstallOpenCodeIntegrationOptions,
): OpenCodeIntegrationJournal {
  const paths = options.paths ?? openCodeIntegrationPaths();
  const existing = readOpenCodeIntegrationJournal(paths);
  if (existing && existing.configFile !== paths.configFile) {
    throw new Error(`OpenCode integration journal targets ${existing.configFile}, not ${paths.configFile}; remove it first`);
  }
  assertReplaceablePlugin(paths.pluginFile, existing);
  const baseURL = openCodeBridgeBaseURL(config);
  const { provider } = buildOpenCodeProviderEntry(config, { baseURL, apiKey: PROVIDER_API_KEY });
  const configText = readText(paths.configFile);
  const document = parseOpenCodeConfig(paths.configFile, configText);
  const currentProvider = isRecord(document.providers) ? document.providers[OPENCODE_PROVIDER_ID] : undefined;
  const pluginText = renderOpenCodePlugin(options.pluginBundle);
  const settings: OpenCodeIdentitySettings = {
    version: 1,
    providerID: OPENCODE_PROVIDER_ID,
    bridgeURL: baseURL.replace(/\/v1$/, ""),
    keyFile: paths.keyFile,
  };
  const settingsText = `${JSON.stringify(settings, null, 2)}\n`;
  const active = options.preserveDisconnected && existing && !existing.active ? false : true;
  const journal: OpenCodeIntegrationJournal = existing
    ? { ...existing, active, installed: { baseURL, provider, models: Object.keys(provider.models).length } }
    : {
        version: 1,
        active,
        configFile: paths.configFile,
        createdConfigFile: configText === undefined,
        createdProvidersKey: !isRecord(document.providers),
        ...(currentProvider !== undefined && !isOurProvider(currentProvider) ? { previousProvider: currentProvider } : {}),
        installed: { baseURL, provider, models: Object.keys(provider.models).length },
        pluginSha256: "",
        settingsSha256: "",
      };
  if (active) delete journal.reconnectOnStartup;
  journal.pluginSha256 = sha256(pluginText);
  journal.settingsSha256 = sha256(settingsText);

  return transaction([paths.configFile, paths.pluginFile, paths.settingsFile, paths.journalFile, paths.keyFile], () => {
    ensureOpenCodeTurnSigningKey(paths.keyFile);
    mkdirSync(paths.pluginsDir, { recursive: true });
    writeUserFile(paths.pluginFile, pluginText, 0o644);
    writeUserFile(paths.settingsFile, settingsText, 0o644);
    if (active) {
      const next = withProvider(document, provider, undefined, journal.createdProvidersKey);
      writeUserFile(paths.configFile, serializeConfig(next, configText), configText === undefined ? 0o644 : 0o600);
    }
    writeJournal(paths, journal);
    const status = inspectOpenCodeIntegration(paths);
    if (status.errors.length > 0) {
      throw new Error(`OpenCode integration did not verify after install: ${status.errors.join("; ")}`);
    }
    return journal;
  });
}

export interface SetOpenCodeIntegrationActiveResult { changed: boolean; active: boolean }

/** Removes the provider from opencode.json while the bridge cannot serve it; plugin files stay installed. */
export function deactivateOpenCodeIntegration(
  options: { forRuntimeRecovery?: boolean; paths?: OpenCodeIntegrationPaths } = {},
): SetOpenCodeIntegrationActiveResult {
  const paths = options.paths ?? openCodeIntegrationPaths();
  const journal = readOpenCodeIntegrationJournal(paths);
  if (!journal) return { changed: false, active: false };
  if (!journal.active) {
    if (!options.forRuntimeRecovery && journal.reconnectOnStartup) {
      const { reconnectOnStartup: _cancelled, ...rest } = journal;
      writeJournal(paths, rest);
    }
    return { changed: false, active: false };
  }
  const configText = readText(paths.configFile);
  const document = parseOpenCodeConfig(paths.configFile, configText);
  const next = withProvider(document, undefined, journal.previousProvider, journal.createdProvidersKey);
  const updated: OpenCodeIntegrationJournal = { ...journal, active: false };
  if (options.forRuntimeRecovery) updated.reconnectOnStartup = true;
  else delete updated.reconnectOnStartup;
  transaction([paths.configFile, paths.journalFile], () => {
    if (configText !== undefined) writeUserFile(paths.configFile, serializeConfig(next, configText), 0o600);
    writeJournal(paths, updated);
  });
  return { changed: true, active: false };
}

export function activateOpenCodeIntegration(
  options: { recoveryOnly?: boolean; paths?: OpenCodeIntegrationPaths } = {},
): SetOpenCodeIntegrationActiveResult {
  const paths = options.paths ?? openCodeIntegrationPaths();
  const journal = readOpenCodeIntegrationJournal(paths);
  if (!journal) throw new Error("OpenCode integration is not installed");
  if (journal.active) {
    const status = inspectOpenCodeIntegration(paths);
    if (status.errors.length) throw new Error(`OpenCode integration is inconsistent: ${status.errors.join("; ")}`);
    return { changed: false, active: true };
  }
  if (options.recoveryOnly && !journal.reconnectOnStartup) return { changed: false, active: false };
  const configText = readText(paths.configFile);
  const document = parseOpenCodeConfig(paths.configFile, configText);
  const next = withProvider(document, journal.installed.provider, undefined, journal.createdProvidersKey);
  const updated: OpenCodeIntegrationJournal = { ...journal, active: true };
  delete updated.reconnectOnStartup;
  transaction([paths.configFile, paths.journalFile], () => {
    writeUserFile(paths.configFile, serializeConfig(next, configText), configText === undefined ? 0o644 : 0o600);
    writeJournal(paths, updated);
    const status = inspectOpenCodeIntegration(paths);
    if (status.errors.length) throw new Error(`OpenCode integration did not verify after reconnect: ${status.errors.join("; ")}`);
  });
  return { changed: true, active: true };
}

export function uninstallOpenCodeIntegration(
  paths = openCodeIntegrationPaths(),
): { changed: boolean; warnings: string[] } {
  const journal = readOpenCodeIntegrationJournal(paths);
  if (!journal) return { changed: false, warnings: [] };
  const warnings: string[] = [];
  const configText = readText(paths.configFile);
  transaction([paths.configFile, paths.pluginFile, paths.settingsFile, paths.journalFile], () => {
    if (configText !== undefined) {
      const document = parseOpenCodeConfig(paths.configFile, configText);
      const next = withProvider(document, undefined, journal.previousProvider, journal.createdProvidersKey);
      const remaining = Object.keys(next).filter(key => key !== "$schema");
      if (journal.createdConfigFile && remaining.length === 0) rmSync(resolveWriteTarget(paths.configFile), { force: true });
      else writeUserFile(paths.configFile, serializeConfig(next, configText), 0o600);
    }
    for (const [path, expected] of [[paths.pluginFile, journal.pluginSha256], [paths.settingsFile, journal.settingsSha256]] as const) {
      const current = readText(path);
      if (current === undefined) continue;
      if (sha256(current) !== expected && !current.startsWith(OPENCODE_PLUGIN_MARKER) && path === paths.pluginFile) {
        warnings.push(`Left a modified plugin file in place: ${path}`);
        continue;
      }
      rmSync(path, { force: true });
    }
    rmSync(paths.journalFile, { force: true });
  });
  return { changed: true, warnings };
}

export function inspectOpenCodeIntegration(paths = openCodeIntegrationPaths()): OpenCodeIntegrationStatus {
  const errors: string[] = [];
  let journal: OpenCodeIntegrationJournal | undefined;
  try { journal = readOpenCodeIntegrationJournal(paths); }
  catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  const base = { configPath: paths.configFile, pluginPath: paths.pluginFile };
  if (!journal) return { ...base, installed: false, active: false, models: 0, errors };
  let models = 0;
  try {
    const document = parseOpenCodeConfig(paths.configFile, readText(paths.configFile));
    const provider = isRecord(document.providers) ? document.providers[OPENCODE_PROVIDER_ID] : undefined;
    if (journal.active) {
      if (!isRecord(provider)) errors.push(`opencode.json has no providers["${OPENCODE_PROVIDER_ID}"] entry: ${paths.configFile}`);
      else {
        if (provider.package !== OPENCODE_PROVIDER_PACKAGE) errors.push("OpenCode provider package no longer matches this installation");
        if (!isRecord(provider.settings) || provider.settings.baseURL !== journal.installed.baseURL) {
          errors.push("OpenCode provider baseURL no longer points at the local bridge");
        }
        models = isRecord(provider.models) ? Object.keys(provider.models).length : 0;
        if (models === 0) errors.push("OpenCode provider lists no models");
      }
    } else if (isOurProvider(provider)) {
      errors.push("A disconnected OpenCode integration still has its provider in opencode.json");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const plugin = readText(paths.pluginFile);
  if (plugin === undefined) errors.push(`OpenCode identity plugin is missing: ${paths.pluginFile}`);
  else if (sha256(plugin) !== journal.pluginSha256) errors.push(`OpenCode identity plugin changed after install: ${paths.pluginFile}`);
  const settingsText = readText(paths.settingsFile);
  if (settingsText === undefined) errors.push(`OpenCode identity plugin settings are missing: ${paths.settingsFile}`);
  else {
    try {
      const settings = parseOpenCodeIdentitySettings(settingsText);
      if (settings.keyFile !== paths.keyFile) errors.push("OpenCode identity plugin points at a different signing key");
      if (`${settings.bridgeURL}/v1` !== journal.installed.baseURL) errors.push("OpenCode identity plugin points at a different bridge");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    if (!readOpenCodeTurnSigningKey(paths.keyFile)) errors.push(`OpenCode turn signing key is missing: ${paths.keyFile}`);
  } catch (error) {
    errors.push(`OpenCode turn signing key is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    ...base,
    installed: true,
    active: journal.active,
    ...(journal.reconnectOnStartup ? { reconnectOnStartup: true } : {}),
    routeUrl: journal.installed.baseURL,
    models,
    errors,
  };
}
