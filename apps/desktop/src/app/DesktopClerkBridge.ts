import { createClerkBridge } from "@clerk/electron";
import { storage } from "@clerk/electron/storage";
import * as Electron from "electron";
import { DESKTOP_HOST } from "../electron/ElectronProtocol.ts";
import type { DesktopUrlRegistration } from "./DesktopUrlRegistration.ts";
import { openClerkTokenStorage } from "./ClerkTokenStore.ts";

export function createDesktopClerkBridge(
  stateDir: string,
  registration: DesktopUrlRegistration,
  userDataPath: string,
) {
  const create = () =>
    createClerkBridge({
      storage: openClerkTokenStorage(
        stateDir,
        (directory) => storage({ path: directory }),
        userDataPath,
      ),
      manageSingleInstanceLock: false,
      passkeys: true,
      renderer: { scheme: registration.scheme, host: DESKTOP_HOST },
    });
  if (registration.platform !== "linux") return create();

  // Clerk registers synchronously and offers no opt-out. Keep OAuth delivery,
  // but leave Linux ownership to the shared desktop-entry/default transaction.
  const nativeRegister = Electron.app.setAsDefaultProtocolClient;
  Electron.app.setAsDefaultProtocolClient = function (scheme, ...args) {
    return scheme === registration.scheme
      ? false
      : nativeRegister.call(Electron.app, scheme, ...args);
  };
  try {
    return create();
  } finally {
    Electron.app.setAsDefaultProtocolClient = nativeRegister;
  }
}
