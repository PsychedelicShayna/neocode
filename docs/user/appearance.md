# Appearance and themes

Open **Settings → Appearance** to choose this client's light and dark palettes.
The default is NeoCode's Neo palette. Appearance choices do not change NeoPi's
terminal theme or its settings.

**Show NeoPi themes** is off by default. Enable it to browse the themes installed
in a connected NeoPi runtime, including custom themes, and select one for this
client's light or dark appearance. Selecting a theme saves a local copy of its
colors. It works offline and does not follow later changes to NeoPi's active
theme. Hiding the catalog leaves your saved selection unchanged.

Older saved copies may appear as **saved locally** instead of a catalog selection.
Choose the catalog theme again to refresh that local copy. The graphical
**Neo default** option is separate from a native theme with the same name.

On web and desktop, the settings scope chooses which environment or project's
catalog to browse. On mobile, choose the runtime in Appearance. These choices
select a catalog to read; they do not change native user or project settings.
An older runtime may need an update before it can supply named palettes.

Choose **Neo default** under **Graphical palette** on web and desktop to restore
the default palette. On mobile, select **NeoCode** for either appearance or both.
Existing saved graphical palettes remain available.

On web and desktop, **Choose graphical theme** in the command palette opens
Appearance. The existing theme shortcut opens the same page. **Change appearance**
selects System, Light or Dark locally. These shortcuts remain customizable under
**Settings → Keybindings**.

Fonts, text sizes, contrast, motion, chat width and other graphical layout
preferences stay separate from palette selection.
Android uses **Material You Layout** by default unless you have turned it off in Appearance.
It changes shapes, spacing, and controls independently
of the selected theme.

## Composer context

Git-backed projects show branch and worktree controls below the composer while you create a thread.
The controls retreat as the composer docks after you send the first message.

Turn on **Composer context** to keep those controls visible after the thread starts. This preference
applies to the web and desktop clients.

## Math

Turn on **Render math** in **Settings → Appearance** to typeset LaTeX in messages and Markdown
previews on web, desktop, and mobile. It reads `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`, outside of code.
Fenced `math` blocks also render. Formulas work in tables, including absolute-value bars.
Dollar amounts such as `$5 and $10` stay text; write `\$` to keep any other dollar sign literal.
Wide formulas scroll horizontally while the surrounding text wraps. Copying a formula or
exporting a table preserves the TeX.

The composer keeps TeX source editable, including when rich text is enabled. The Render math
preference is saved separately on each device.

## Motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Move the
**Panel animations** slider above 0 ms to add motion, up to 400 ms, unless reduced motion is enabled
in your operating system. Moving between threads always snaps to the selected thread's panel state
without replaying its transitions.

## Saved graphical palettes

The **Edit graphical palette** command on web and desktop edits a device-local
palette. It does not modify terminal themes. To make a new native theme available
in multiple clients, install it in NeoPi's theme directory, then explicitly
select it in each client's Appearance settings.

Server-published palettes are loaded when needed to resolve an explicit saved
graphical choice. They do not replace the default or a different selected palette.
