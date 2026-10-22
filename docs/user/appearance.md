# Appearance and themes

Open **Settings → Appearance** to choose NeoPi's native dark and light themes.
The list comes from the connected NeoPi runtime, including its installed custom
themes. Web, desktop and mobile use the same native settings as terminal
**Settings → Appearance**.

On web and desktop, the settings scope chooses which environment and project you
change. On mobile, choose the native runtime and scope in Appearance. User scope
sets that runtime profile's default; project scope overrides it for that project.
**Inherit** removes only the selected scope's override. The effective theme and
both saved scopes are shown beside each selection.

Connected clients reconcile native theme changes. If another client changes a
selection while you are saving, refresh and choose again rather than overwriting
its choice. Disconnected or older runtimes cannot change native themes. Update
the NeoPi executable in NeoCore and reconnect if shared themes are unsupported.

On web and desktop, **Change NeoPi theme** in the command palette opens Appearance.
The existing theme shortcut opens the same page. **Change appearance** still
selects System, Light or Dark on this client; it does not change native settings.
These shortcuts remain customizable under **Settings → Keybindings**.

Fonts, text sizes, contrast, motion, chat width and other graphical layout
preferences stay separate. **Follow NeoPi themes** changes which palette this
client displays, without deleting its previous named palette or light/dark mix.
Existing named palettes remain selected until you choose to follow NeoPi.
Turn following off to restore them, or select a preserved graphical palette.
Android uses **Material You Layout** by default unless you have turned it off in Appearance.
It changes shapes, spacing, and controls independently
of the selected theme.

## Motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Move the
**Panel animations** slider above 0 ms to add motion, up to 400 ms, unless reduced motion is enabled
in your operating system. Moving between threads always snaps to the selected thread's panel state
without replaying its transitions.

## Saved graphical palettes

Existing graphical palettes remain on this device. The **Edit graphical palette**
command on web and desktop edits a device-local palette and stops following
NeoPi; it does not modify terminal themes. New shared themes belong in NeoPi's
theme directory so every connected client can discover them.

Old server-published palettes are still loaded when needed to resolve an explicit
saved graphical choice. They no longer replace native theme selections or act as
defaults for connected clients.
