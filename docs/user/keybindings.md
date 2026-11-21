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

Use `alt+p` to choose a model and `mod+shift+h` to choose a host.
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
`ctrl+s` for the stash everywhere. In the panel and the hub, click an agent to
expand it and click it again to collapse it, or use the arrow keys (or `j`/`k`)
to move through the list. Press Enter or the **Open** button to open an agent,
and Esc to go back. The roster lists finished and stopped agents too, as long as
NeoPi can report the session's earlier agents, and their transcripts open
read-only.

In the model picker, press Left in an empty search field or Shift+Tab to reach
the provider list. Use Up/Down to move and Enter to choose. Right returns to
model search. `mod+shift+up` and `mod+shift+down` switch providers directly and clear the
search. These provider shortcuts can also be changed in Settings.

These shortcuts run inside the focused web or desktop client. `mod` uses Command
on macOS and Ctrl on Windows and Linux, including GNOME, KDE Plasma, Niri, and
Hyprland. If a custom desktop shortcut takes the same keys, choose another binding
in Settings.

`mod+u` (`usage.open`) opens Stats. NeoPi's embedded dashboard owns its metric
and period controls; the former local-chart shortcuts are not available.

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
  { "key": "ctrl+w h", "command": "sidebar.toggle", "when": "!terminalFocus" }
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

A key can also be a sequence of two chords separated by a space, such as
`ctrl+w h`: press the first chord, release it, then press the second. There is no
time limit between them. Any other key cancels the sequence and works as usual.
To record one in **Settings → Keybindings**, press both chords; to keep a single
chord, press Enter or Tab after it. Settings only records shortcuts whose first chord
uses a modifier, so ordinary typing cannot set one by accident; for a sequence that
starts with a plain key, such as `g h`, edit the configuration file. Such a sequence
never starts while a text field has focus.

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
a shortcut. A chord that starts a sequence takes the place of a rule on that chord
alone. Settings marks rules that compete for the same keys under conditions that
can hold at once.

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
(`ctrl+shift+tab`) switch between session tabs in recently-used order, like
Firefox. While you hold `ctrl`, each `tab` press steps one session further back
(`shift` steps forward) and a list shows where you are; releasing `ctrl` opens
that session and makes it the most recent, so a single `ctrl+tab` afterwards
returns to the one you left. `escape` cancels. They work from the composer and
are skipped while the terminal has focus. Browsers reserve `ctrl+tab` for their
own tabs, so this is a desktop shortcut; assign another binding to use it on the
web.

Drag session tabs, and the tabs in the right panel, to reorder them. The order
is kept between launches.

`chat.new` may ask you to choose a project when there is more than one.
`chat.newLocal` skips that chooser. Both use your
[new-thread defaults](./thread-sidebar.md#start-a-thread).

## Reserved shortcuts

In the desktop app, `mod+w` closes the active right-panel tab. When nothing remains
to close, it closes the window. In a browser, `mod+w` closes the browser tab;
rebind `rightPanel.close` to an available shortcut such as `alt+w`.
`terminal.close` has no default shortcut.
If closing an integrated terminal fails, its tab stays open so you can retry once
the environment is available. A failed close does not type `exit` into the shell.

## Terminal focus

While a terminal has focus, every key goes to the program running in it, whatever
your keybindings say: `ctrl+d`, `ctrl+w`, `ctrl+b`, Tab and Escape included. Only
these act in the terminal itself:

| Default                         | Command                      | Does                                         |
| ------------------------------- | ---------------------------- | -------------------------------------------- |
| `ctrl+\ ctrl+\`                 | `terminal.leaveFocus`        | Leave the terminal so app shortcuts work     |
| `mod+=`, `mod++`, `mod+shift+=` | `terminal.fontSize.increase` | Make the terminal text larger                |
| `mod+-`                         | `terminal.fontSize.decrease` | Make the terminal text smaller               |
| `mod+0`                         | `terminal.fontSize.reset`    | Return the terminal text to its default size |

A single `ctrl+\` followed by any other key reaches the program as usual. The font
size keys change the terminal size in **Settings → Appearance**: the terminal font
with Advanced typography, otherwise the monospace font. These keys can be rebound;
Settings warns when another rule uses a key they hold in the terminal.

In a native NeoPi workspace, use `:new` from the command line or choose
**New terminal** in the command palette to open an ordinary shell in the bottom
drawer, even while the NeoPi TUI is open in the side panel.

If an integrated terminal cannot attach, the failure appears inside that terminal
even when its shell is quiet. Reconnect the environment before trying again.

## Command line

In a native session, `ctrl+;` (`exLine.open`) opens a one-line command line in
place of the status bar, like Vim's `:`, in a narrow window too. With the right
panel maximized or the Agent Hub open, it opens along the bottom edge of the
workspace instead. From a focused terminal, leave it first
with `ctrl+\ ctrl+\`, then press `ctrl+;`. Type a command and press Enter to run
it; Escape closes the line and returns the keyboard to where it was. If a command
is unknown or cannot run right now, the line says why and stays open. Up and Down
recall earlier commands until the app restarts.

| Command   | Does                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------- |
| `:split`  | Split the terminal (`terminal.split`)                                                           |
| `:vsplit` | Split the terminal vertically (`terminal.splitVertical`)                                        |
| `:new`    | Open a new terminal in the bottom drawer (`terminal.new`)                                       |
| `:q`      | Close the terminal you focused last, or else the active right-panel tab if it is not a terminal |
| `:ene`    | Start a new thread (`chat.new`)                                                                 |
| `:b name` | Switch to an open session tab whose title or agent name contains `name`                         |

`:split` and `:vsplit` open the pane without moving the keyboard to it. If you
open the command line right after leaving a terminal, they return the keyboard
to that original terminal. The split buttons and shortcuts still focus the new
pane. If showing the split would reopen a modal or maximized right panel, it
stays hidden until you show that terminal.

After `:b` and a space, the matching sessions appear above the line. Tab,
Shift+Tab and the arrow keys move the pick; nothing changes until you press Enter.
If the terminal you last focused is an ordinary shell, the command line's split
and close commands act on it. These commands do not split or close the managed
NeoPi TUI. Closing a shell asks for confirmation, just like its close button.

Any command ID from **Settings → Keybindings** that the open session handles also
works by name, for example `:rightPanel.toggle` or `:agents.hub.toggle`. Commands
a terminal handles itself, such as the font size keys, are not available here.

## Desktop quit shortcut

Use `Cmd+Q` on macOS or `Ctrl+Q` on Windows and Linux. In the default **Hold** mode,
hold for 1.2 seconds or press twice within 500 milliseconds. Holding requires
keyboard repeat; if repeat is disabled, use two presses or the application menu.

Change **Settings → General → Confirmations → Quit shortcut** to **Direct** for a
single press or **Double press** for two presses only. Choosing **Quit** from the
application menu always quits immediately.
