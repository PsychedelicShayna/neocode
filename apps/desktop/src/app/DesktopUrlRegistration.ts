export interface DesktopUrlRegistration {
  readonly platform: NodeJS.Platform;
  readonly ownsScheme: boolean;
  // Development still needs its separate portal identity without claiming a default.
  readonly prepareEntry: boolean;
  readonly scheme: string;
  readonly command: readonly string[];
}

// Source launches share the production scheme, but only a deliberate registration
// may replace an installed handler. Development has its own scheme and identity.
export function resolveDesktopUrlRegistration(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly isDevelopment: boolean;
  readonly explicitRegistration: boolean;
  readonly execPath: string;
  readonly appPath: string;
  readonly appImagePath?: string | undefined;
  readonly desktopLauncherPath?: string | undefined;
  readonly devServerUrl?: string;
  readonly passwordStore?: string | null;
}): DesktopUrlRegistration {
  const switches = input.passwordStore ? [`--password-store=${input.passwordStore}`] : [];
  return {
    platform: input.platform,
    ownsScheme: input.isPackaged || input.explicitRegistration,
    prepareEntry: input.isPackaged || input.explicitRegistration || input.isDevelopment,
    scheme: input.isDevelopment ? "t3code-dev" : "t3code",
    command: [
      // A valid, unquoted executable also works with generic xdg-utils, whose
      // first_word parser does not understand desktop-entry quote marks.
      "/usr/bin/env",
      "-u",
      "ELECTRON_RUN_AS_NODE",
      "-u",
      "VITE_DEV_SERVER_URL",
      ...(input.isDevelopment && input.devServerUrl
        ? [`VITE_DEV_SERVER_URL=${input.devServerUrl}`]
        : []),
      ...(input.isPackaged
        ? [input.desktopLauncherPath || input.appImagePath || input.execPath, ...switches]
        : [input.execPath, ...switches, input.appPath]),
    ],
  };
}

const escapeDesktopEntryString = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");

export function escapeDesktopEntryExecArgument(value: string): string {
  // Generic xdg-open retains quote marks on safe arguments such as -u.
  // Keep required desktop-entry quoting for whitespace and metacharacters.
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(value)) return value;
  const quoted = value
    .replaceAll("\\", () => "\\\\")
    .replaceAll("`", () => "\\`")
    .replaceAll("$", () => "\\$")
    .replaceAll('"', () => '\\"')
    .replaceAll("%", () => "%%");
  return escapeDesktopEntryString(`"${quoted}"`);
}

export function renderUrlHandlerDesktopEntry(input: {
  readonly displayName: string;
  readonly command: readonly string[];
  readonly scheme: string;
  readonly iconPath?: string;
}): string {
  // The first token is our fixed /usr/bin/env, never a user-supplied path.
  if (input.command[0] !== "/usr/bin/env") throw new Error("URL handler requires /usr/bin/env");
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escapeDesktopEntryString(input.displayName)}`,
    `Exec=/usr/bin/env ${input.command.slice(1).map(escapeDesktopEntryExecArgument).join(" ")} %U`,
    ...(input.iconPath === undefined ? [] : [`Icon=${escapeDesktopEntryString(input.iconPath)}`]),
    "Terminal=false",
    "NoDisplay=true",
    "StartupNotify=false",
    `MimeType=x-scheme-handler/${input.scheme};`,
    "",
  ].join("\n");
}

export function hasConfiguredUrlHandler(
  content: string,
  scheme: string,
  desktopEntryName: string,
): boolean {
  let defaults = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      defaults = line === "[Default Applications]";
    } else if (defaults && line.startsWith(`x-scheme-handler/${scheme}=`)) {
      return (
        line
          .slice(line.indexOf("=") + 1)
          .split(";")[0]
          ?.trim() === desktopEntryName
      );
    }
  }
  return false;
}
