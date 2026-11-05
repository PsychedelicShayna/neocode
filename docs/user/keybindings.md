# Keybindings

Customize shortcuts in **Settings → Keybindings** on web and desktop. That page
also lists the command IDs and defaults available in your version.

## Composer controls

In **Settings → General → Send shortcut**, choose whether Enter sends, requires
`mod+Enter` for multiline prompts, or always requires `mod+Enter`. `Shift+Enter`
inserts a new line. This applies to the web and desktop composer at desktop widths.

**Follow-up behavior** chooses Queue or Steer while the agent runs. Use
`mod+Enter` to do the opposite for one message. When sending requires `mod+Enter`,
use `mod+Shift+Enter` for the opposite action. In a new thread, `mod+Enter` keeps
starting the thread in the background.

Use `mod+shift+m` to choose a model and `mod+shift+h` to choose a host.
Use `mod+shift+e` for effort, `mod+shift+a` for access mode, `mod+shift+x` for the
workspace, and `mod+shift+g` for the Git branch. The workspace menu includes the
current checkout, a new worktree, and the previous worktree when available.
Use `mod+shift+l` to reuse the previous worktree directly.

On the desktop app, `ctrl+space` starts and stops [dictation](composer.md#dictate-on-the-desktop-app)
in a native session. It is literal Ctrl on every platform, so it can be rebound
under `composer.dictation.toggle` if your system uses it for input sources.

In a native session, `ctrl+s` (`agents.panel.toggle`) shows or hides the agents
panel and `alt+s` (`agents.hub.toggle`) shows or hides the full Agent Hub. These
match NeoPi's own chords for those views. Both apply only in native sessions
(`when: nativeSession`), where `ctrl+s` replaces the composer stash on Linux and
Windows; other threads keep the stash. Rebind `agents.panel.toggle` to keep
`ctrl+s` for the stash everywhere. In the panel and the hub, click or use the
arrow keys (or `j`/`k`) to preview an agent, Enter or a double-click to open it,
and Esc to go back.

In the model picker, press Left in an empty search field or Shift+Tab to reach
the provider list. Use Up/Down to move and Enter to choose. Right returns to
model search. `mod+shift+up` and `mod+shift+down` switch providers directly and clear the
search. These provider shortcuts can also be changed in Settings.

These shortcuts run inside the focused web or desktop client. `mod` uses Command
on macOS and Ctrl on Windows and Linux, including GNOME, KDE Plasma, Niri, and
Hyprland. If a custom desktop shortcut takes the same keys, choose another binding
in Settings.

## Native NeoPi sessions

Native sessions use NeoPi's own terminal chords. They run only while a native
session has the keyboard and never in a terminal. Every one can be rebound in
**Settings → Keybindings**.

| Default        | Command                         | Does                                                                                                             |
| -------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `shift+tab`    | `composer.thinking.cycle`       | Cycle the reasoning level; only while the composer has focus, so Shift+Tab still moves focus backwards elsewhere |
| `ctrl+p`       | `composer.role.cycleForward`    | Switch to the next role in NeoPi's role cycle                                                                    |
| `ctrl+shift+p` | `composer.role.cycleBackward`   | Switch to the previous role                                                                                      |
| `ctrl+t`       | `transcript.thinking.toggle`    | Show or hide reasoning blocks in every native session; the choice is saved on this device                        |
| `alt+e`        | `transcript.tools.toggleExpand` | Open or close every tool call of the latest turn                                                                 |
| `escape`       | `thread.stop`                   | Interrupt the running turn                                                                                       |

Escape does not interrupt while a menu, dialog, the model picker or dictation owns
it, or while a terminal or preview has focus. While NeoPi works, `ctrl+enter` in
the composer queues a follow-up for after the run instead of steering it.

The role cycle follows the order and visibility configured in NeoPi, and needs a
NeoPi version that advertises `cycle_role`; with an older one the shortcut says so.
Each cycle shows the new level or role as a short notice. A browser tab reserves
`ctrl+t` for itself, so that chord only works in the desktop app until you rebind it.

Inside a native session, `ctrl+p` and `ctrl+shift+p` take priority over the file
picker and pin on Windows and Linux, where `mod` is Ctrl. Command+P and Command+Shift+P
keep those jobs on macOS. Outside native sessions the file picker and pin keep their
bindings. See [precedence](#precedence).

## Copy pull request references

With a PR open in the right panel or on the Pull Requests page, use `mod+shift+c`
to copy its URL and `mod+shift+k` to copy its number with a `#` prefix.
Both shortcuts can be changed in Settings. Search for “Copy Link or Thread ID”
or “Copy Number”. They copy the selected PR and leave terminal input alone.

## iPad

With a hardware keyboard, use `Cmd+1` through `Cmd+9` to open the first nine
displayed threads. The shortcuts follow the current list filters and order.
`Cmd+K` opens the command palette to search commands, projects, and threads.
Use the arrow keys and Return to choose a result, or `Cmd+1` through `Cmd+9` to
choose directly. Escape or `Cmd+K` closes the palette. Start a search with `>`
to show only actions.

In the composer, Return sends and `Shift+Return` inserts a new line. `Cmd+Return`
also sends. To make Return insert a new line instead, change the Return key
behavior in Settings → Keyboard.

## Edit the configuration file

Keybindings live on the environment's machine, in
`~/.t3/userdata/keybindings.json` by default. You can edit this file directly.
It is a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

T3 Code creates the file with its defaults and adds new defaults on later startups.
New defaults do not replace commands you customized. If a new default overlaps one
of your shortcuts, [rule order](#precedence) decides which runs.
Invalid rules are ignored; if the file cannot be parsed, T3 Code uses defaults.

## Rule shape

Each rule requires a `key` shortcut and a `command` ID. An optional `when`
expression restricts when it runs.

Project scripts use `script.{id}.run`, such as `script.test.run`.

## Key syntax

Join modifiers and a key with `+`, such as `mod+shift+d` or `ctrl+l`.
`mod` means Command on macOS and Control elsewhere. Other modifiers are
`cmd` / `meta`, `ctrl` / `control`, `alt` / `option`, and `shift`.

## When conditions

Available context keys are `terminalFocus`, `terminalOpen`, `previewFocus`,
`previewOpen`, `modelPickerOpen`, `usagePageOpen`, `editableFocus`, `nativeSession`,
`composerFocus`, `isWeb`, and `isDesktop`. `nativeSession` is true while a NeoPi session fills the window.
`editableFocus` is true while a text field, the composer, or another editor has
the keyboard. `nativeSession` is true while a native NeoPi session workspace has
the keyboard, and `composerFocus` while its composer does. `isWeb` is true in a
browser tab. `isDesktop` is true in the desktop app. Unknown keys evaluate to `false`.

`mod+1` through `mod+9` jump to the first nine threads, and to models while the
model picker is open. Those defaults use `isDesktop` so they do not steal the
browser's tab-switch shortcuts. Remove that condition in Settings if you want
the same jumps in a browser.

Combine keys with `!` for not, `&&` for and, `||` for or, and parentheses:

```json
{ "key": "mod+j", "command": "terminal.toggle", "when": "terminalOpen && !terminalFocus" }
```

## Precedence

The last rule whose key and condition both match wins, even if it belongs to a
different command. Put a more specific rule after a general one when they share
a shortcut.

## Commands with special behavior

`thread.stop` interrupts the running turn in the focused thread. It has no default
shortcut outside native sessions, where Escape is bound to it; assign one in
**Settings → Keybindings**.

`thread.undo` (`mod+z` by default) reverses the actions shown in the notice at the
bottom of the sidebar, such as unpin, settle, snooze, or archive. Consecutive
actions of the same kind undo together. The notice remains available for five
seconds after the latest action. The default shortcut skips text fields and
terminals so native undo keeps working there.

`navigation.back` (`mod+[` by default) and `navigation.forward` (`mod+]`) move
through the pages you have visited, like a browser's back and forward buttons.

`sessionTab.next` (`ctrl+tab` by default) and `sessionTab.previous`
(`ctrl+shift+tab`) switch between the session tabs at the top of the window and
wrap around at either end. They work from the composer and are skipped while the
terminal has focus. Browsers reserve `ctrl+tab` for their own tabs, so this is a
desktop shortcut; assign another binding to use it on the web.

`chat.new` may ask you to choose a project when there is more than one.
`chat.newLocal` skips that chooser. Both use your
[new-thread defaults](./thread-sidebar.md#start-a-thread).

## Reserved shortcuts

In the desktop app, `mod+w` closes the focused terminal or the active right-panel
tab. When nothing remains to close, it closes the window. In a browser, `mod+w`
closes the browser tab; rebind `rightPanel.close` and `terminal.close` to an available
shortcut such as `alt+w`.

Many defaults include `!terminalFocus` so they do not intercept terminal input.
Keep that condition when remapping them if you want the same behavior.

If an integrated terminal cannot attach, the failure appears inside that terminal
even when its shell is quiet. Reconnect the environment before trying again.

## Desktop quit shortcut

Use `Cmd+Q` on macOS or `Ctrl+Q` on Windows and Linux. In the default **Hold** mode,
hold for 1.2 seconds or press twice within 500 milliseconds. Holding requires
keyboard repeat; if repeat is disabled, use two presses or the application menu.

Change **Settings → General → Confirmations → Quit shortcut** to **Direct** for a
single press or **Double press** for two presses only. Choosing **Quit** from the
application menu always quits immediately.
