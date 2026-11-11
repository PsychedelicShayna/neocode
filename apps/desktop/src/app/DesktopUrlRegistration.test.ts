import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "vite-plus/test";
import { resolveLinuxDesktopEntryName } from "./DesktopEarlyElectronStartup.ts";
import {
  escapeDesktopEntryExecArgument,
  hasConfiguredUrlHandler,
  renderUrlHandlerDesktopEntry,
  resolveDesktopUrlRegistration,
} from "./DesktopUrlRegistration.ts";

const withPrivateRoot = (run: (root: string) => void) => {
  const cache = join(homedir(), ".cache", "npi-canary");
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(join(cache, "url-registration-test-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("DesktopUrlRegistration", () => {
  it("skips default writes only for the first configured handler in the default section", () => {
    const canonical = "com.psychedelicshayna.NeoCode.desktop";
    assert.isTrue(
      hasConfiguredUrlHandler(
        `[Default Applications]\nx-scheme-handler/t3code=${canonical};older.desktop;\n`,
        "t3code",
        canonical,
      ),
    );
    assert.isFalse(
      hasConfiguredUrlHandler(
        `[Added Associations]\nx-scheme-handler/t3code=${canonical};\n`,
        "t3code",
        canonical,
      ),
    );
    assert.isFalse(
      hasConfiguredUrlHandler(
        `[Default Applications]\nx-scheme-handler/t3code=older.desktop;${canonical};\n`,
        "t3code",
        canonical,
      ),
    );
    assert.isFalse(
      hasConfiguredUrlHandler(
        `[Default Applications]\nx-scheme-handler/t3code-dev=${canonical};\n`,
        "t3code",
        canonical,
      ),
    );
  });

  it("preserves development origin and selects the stable packaged AppImage", () => {
    const plan = resolveDesktopUrlRegistration({
      platform: "linux",
      isPackaged: true,
      isDevelopment: true,
      explicitRegistration: false,
      execPath: "/transient/.mount_neocode/electron",
      appPath: "/source/main.cjs",
      appImagePath: '/Applications/Neo Code "100%".AppImage',
      devServerUrl: "http://127.0.0.1:5733",
      passwordStore: "basic",
    });
    assert.isTrue(plan.ownsScheme);
    assert.equal(plan.scheme, "t3code-dev");
    assert.include(plan.command, "VITE_DEV_SERVER_URL=http://127.0.0.1:5733");
    assert.deepEqual(plan.command.slice(-2), [
      '/Applications/Neo Code "100%".AppImage',
      "--password-store=basic",
    ]);
    assert.notInclude(plan.command, "/transient/.mount_neocode/electron");
  });

  it("retains desktop-entry escaping rather than dropping required quotes", () => {
    assert.equal(
      escapeDesktopEntryExecArgument('/home/al ice/Apps/T3 "100%" $HOME\\x.AppImage'),
      '"/home/al ice/Apps/T3 \\\\"100%%\\\\" \\\\$HOME\\\\\\\\x.AppImage"',
    );
  });

  it("makes configured and effective generic xdg-utils ownership agree with two candidates", () =>
    withPrivateRoot((root) => {
      for (const dir of [
        "home",
        "config",
        "data/applications",
        "cache",
        "runtime",
        "system-config",
        "system-data",
      ]) {
        mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
      }
      const plan = resolveDesktopUrlRegistration({
        platform: "linux",
        isPackaged: false,
        isDevelopment: false,
        explicitRegistration: true,
        execPath: '/real path/electron "quoted"',
        appPath: '/source app/main "entry".cjs',
      });
      const canonical = resolveLinuxDesktopEntryName(false);
      const applications = join(root, "data/applications");
      const upstreamPath = join(applications, "com.t3tools.T3Code.desktop");
      const upstreamEntry = "[Desktop Entry]\nType=Application\nName=T3 Code\nExec=/usr/bin/t3code %U\n";
      writeFileSync(upstreamPath, upstreamEntry);
      const entry = renderUrlHandlerDesktopEntry({
        displayName: "NeoCode",
        command: plan.command,
        scheme: plan.scheme,
      });
      writeFileSync(join(applications, canonical), entry);
      writeFileSync(
        join(applications, "old-handler.desktop"),
        '[Desktop Entry]\nType=Application\nName=Older app\nExec="/usr/bin/false" %U\nMimeType=x-scheme-handler/t3code;\n',
      );
      writeFileSync(
        join(applications, "mimeinfo.cache"),
        "[MIME Cache]\nx-scheme-handler/t3code=old-handler.desktop;\n",
      );
      const env = {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_RUNTIME_DIR: join(root, "runtime"),
        XDG_CONFIG_DIRS: join(root, "system-config"),
        XDG_DATA_DIRS: join(root, "system-data"),
        XDG_CURRENT_DESKTOP: "X-Generic",
        XDG_SESSION_TYPE: "none",
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/no-session-bus`,
      };
      const setDefault = spawnSync(
        "/usr/bin/xdg-mime",
        ["default", canonical, "x-scheme-handler/t3code"],
        { env, encoding: "utf8", timeout: 5000 },
      );
      assert.equal(setDefault.status, 0, setDefault.stderr);
      const configured = readFileSync(join(root, "config/mimeapps.list"), "utf8");
      const effective = spawnSync(
        "/usr/bin/xdg-mime",
        ["query", "default", "x-scheme-handler/t3code"],
        { env, encoding: "utf8", timeout: 5000 },
      );
      assert.include(configured, `x-scheme-handler/t3code=${canonical}`);
      assert.equal(effective.status, 0, effective.stderr);
      assert.equal(effective.stdout.trim(), canonical);
      assert.equal(readFileSync(join(applications, effective.stdout.trim()), "utf8"), entry);
      assert.equal(readFileSync(upstreamPath, "utf8"), upstreamEntry);
      assert.include(entry, '"/source app/main \\\\"entry\\\\".cjs" %U');
    }));
});
