const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeHost, openCodeConfigDir } = require("../electron/runtime.cjs");

test("OpenCode's config directory follows XDG, POSIX HOME and Windows %USERPROFILE%", () => {
  assert.equal(openCodeConfigDir({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" }, "linux"), path.join("/xdg", "opencode"));
  assert.equal(openCodeConfigDir({ HOME: "/Users/u" }, "darwin"), path.join("/Users/u", ".config", "opencode"));
  // npm/PowerShell OpenCode on Windows ignores an MSYS/Git-Bash HOME.
  assert.equal(
    openCodeConfigDir({ USERPROFILE: "C:\\Users\\me", HOME: "/c/Users/me" }, "win32"),
    path.join("C:\\Users\\me", ".config", "opencode"),
  );
});

test("a failed setup can restore the OpenCode provider, identity plugin and signing key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-checkpoint-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  try {
    const coreHome = path.join(root, "core");
    const host = new RuntimeHost({
      app: { getPath: () => path.join(root, "user-data"), getVersion: () => "1.0.0" },
      logger: { info() {}, warn() {}, error() {} },
      sourceRoot: "/source",
      browserDescriptorPath: path.join(root, "launcher-browser.json"),
      coreHome,
      codexHome: path.join(root, "codex"),
      supervisor: { configPath: path.join(coreHome, "config.json"), coreHome },
    });
    const configDir = path.join(root, "xdg", "opencode");
    fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(configDir, "opencode.json"), "{\"theme\":\"nord\"}\n");
    const checkpoint = host.captureSetupCheckpoint({ owner: "launcher", config: {} });
    const captured = checkpoint.map(snapshot => snapshot.path);
    for (const expected of [
      path.join(configDir, "opencode.json"),
      path.join(configDir, "plugins", "chatgpt-web-identity.js"),
      path.join(configDir, "plugins", "chatgpt-web-identity.json"),
      path.join(coreHome, "opencode", "integration-journal.json"),
      path.join(coreHome, "opencode", "turn-signing.key"),
    ]) assert.ok(captured.includes(expected), `checkpoint misses ${expected}`);

    fs.writeFileSync(path.join(configDir, "opencode.json"), "{\"theme\":\"nord\",\"providers\":{}}\n");
    fs.writeFileSync(path.join(configDir, "plugins", "chatgpt-web-identity.js"), "export default {}\n");
    assert.equal(host.setupCheckpointChanged(checkpoint), true);
    host.restoreSetupCheckpoint(checkpoint);
    assert.equal(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8"), "{\"theme\":\"nord\"}\n");
    assert.equal(fs.existsSync(path.join(configDir, "plugins", "chatgpt-web-identity.js")), false);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
