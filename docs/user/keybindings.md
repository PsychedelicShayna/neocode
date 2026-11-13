# Keybindings

Customize shortcuts in **Settings → Keybindings** on web and desktop. That page
also lists the command IDs and defaults available in your version.

## Composer controls

`mod+shift+d` starts dictation in the focused editor, or the composer, and finishes it on the next press;
`Esc` discards the recording. Change the chord under **Composer: Start or Finish
Dictation**, and the hold or toggle behavior in **Settings → Voice**. See
[Voice input](./voice-input.md).

In **Settings → Chat → Send shortcut**, choose whether Enter sends, requires
`mod+Enter` for multiline prompts, or always requires `mod+Enter`. `Shift+Enter`
inserts a new line. This applies to the web and desktop composer at desktop widths.

**Follow-up behavior** chooses Queue or Steer while the agent runs. Use
`mod+Enter` to do the opposite for one message, even when the send shortcut
requires a modifier. `mod+Alt+Enter` sends, keeps that thread running in the
background, and opens a fresh new-thread composer. In a new thread, `mod+Enter`
does the same. Change these shortcuts in **Settings → Keybindings** under
**Composer: Opposite Queue or Steer Action**, **Composer: Start in Background**,
or **Composer: Send and Start New Thread**. These bindings take priority over the
send shortcut. Click the send button to use the configured follow-up behavior.

When a thread has queued messages, `mod+Shift+Enter` sends the first one as a steer
while a turn is running, or as a new turn when the thread is stopped. Change it under
**Queue: Send First Queued Message** in Keybindings.

Use `mod+shift+m` to choose a model and `mod+shift+h` to choose a host.
To step a new thread to the next machine instead of opening the menu, bind
**Composer: Cycle Host** in Keybindings. It has no default shortcut.
Use `mod+shift+e` for effort, `mod+shift+a` for permissions, `mod+shift+x` for the
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

To change effort one step without opening the picker, bind
**Composer: Increase Effort** and **Composer: Decrease Effort** in Keybindings.
Both are unbound by default. Increase wraps from the highest level to the
lowest, and decrease wraps from the lowest level to the highest.

In the native model picker, use Left and Right to move between the rail and the
model list, Up and Down to move through entries, and Enter to select. Choosing a
model or role returns focus to the prompt.

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

With a PR open in the right panel or on the Pull requests page, use `mod+shift+c`
to copy its URL and `mod+shift+k` to copy its number with a `#` prefix.
Both shortcuts can be changed in Settings. Search for “Copy Link or Thread”
or “Copy Number”. They copy the selected PR and leave terminal input alone.
Without a PR, `mod+shift+c` copies the thread itself, which pastes into a
composer as a thread chip.

## Find in a diff

Click into a diff in the Diff panel or a pull request's Code tab, then press
`mod+f` to search every file in it, including folded files and unchanged lines
hidden between changes. Enter and `Shift+Enter` move between matches, and a
match in a folded file opens it. Escape closes the search. This shortcut is not
configurable. A very large uncommitted diff loads its files as you scroll, and
find only searches the files loaded so far.

## iPad

With a hardware keyboard, use `Cmd+1` through `Cmd+9` to open the first nine
displayed threads. The shortcuts follow the current list filters and order.
`Cmd+K` opens the command palette to search commands, projects, and threads.
Use the arrow keys and Return to choose a result, or `Cmd+1` through `Cmd+9` to
choose directly. Escape or `Cmd+K` closes the palette. Start a search with `>`
to show only actions.

In a new thread, `Cmd+Shift+H` moves the draft to the next machine.

In the composer, Return sends and `Shift+Return` inserts a new line. While a
turn is running, `Cmd+Return` sends with the other follow-up action. To make
Return insert a new line instead, change the Return key behavior in Settings →
Keyboard; `Cmd+Return` then sends.

## Android

With a hardware keyboard, the composer handles Return as on iPad, with `Ctrl` in
place of `Cmd`. The on-screen keyboard's Return always inserts a new line.

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

NeoCode creates the file with its defaults and adds new defaults on later startups.
New defaults do not replace commands you customized. If a new default overlaps one
of your shortcuts, [rule order](#precedence) decides which runs.
Invalid rules are ignored; if the file cannot be parsed, NeoCode uses defaults.

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
`previewOpen`, `rightPanelOpen`, `modelPickerOpen`, `usagePageOpen`, `composerFocus`,
`draftThreadRoute`, `turnRunning`, `editableFocus`, `nativeSession`, `isWeb`, and `isDesktop`.
`rightPanelOpen` applies only to `rightPanel.new` and is true while the right panel is
open; the default `mod+t` uses it to open the panel's new-tab menu.
`draftThreadRoute` is true on a draft thread, including a restored draft, until it is first sent.
`editableFocus` is true while a text field, the composer, or another editor has
the keyboard. `nativeSession` is true while a native NeoPi session workspace has
the keyboard, and `composerFocus` while its composer does. `isWeb` is true in a
browser tab. `isDesktop` is true in the desktop app. Unknown keys evaluate to `false`.

`mod+1` through `mod+9` jump to the first nine threads, and to models while the
model picker is open. The thread jumps do not run while the model picker is open.
Those defaults use `isDesktop` so they do not steal the
browser's tab-switch shortcuts. Remove that condition in Settings if you want
the same jumps in a browser.

Combine keys with `!` for not, `&&` for and, `||` for or, and parentheses:

```json
{ "key": "mod+j", "command": "terminal.toggle", "when": "terminalOpen && !terminalFocus" }
```

## Find in the current thread

`chat.find` searches conversation messages and proposed plans in the active thread. Entering a
query searches the entire thread, including older messages. Thread search requires server support;
update an older server to enable it. Select **Retry** if a search fails. It defaults to
`mod+f` outside terminals and previews. Press **Enter** or **Shift+Enter** to move between matches,
and **Escape** to close find.

## Precedence

The last rule whose key and condition both match wins, even if it belongs to a
different command. Put a more specific rule after a general one when they share
a shortcut.

## Commands with special behavior

`thread.stop` interrupts the running turn in the focused thread. It has no default
shortcut outside native sessions, where Escape is bound to it; assign one in
**Settings → Keybindings**.

`thread.undo` (`mod+z` by default) reverses the actions shown in the notice at the
bottom of the sidebar, such as unpin, settle, snooze, archive, or discarding a
draft. Consecutive
actions of the same kind undo together. The notice remains available for five
seconds after the latest action. Right after an action, the shortcut works even
in a text field such as the composer. Once you type or press another key, the
field gets its own undo back. Terminals always keep their native shortcut.

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
[new-thread defaults](./thread-sidebar.md#start-a-thread). `chat.newWithoutProject`
(`mod+alt+n`) starts a thread [without a project](./thread-sidebar.md#start-without-a-project).

## Reserved shortcuts

In the desktop app, `mod+w` closes the focused terminal or the active right-panel
tab. When nothing remains to close, it does nothing; it never closes the window. In a browser, `mod+w`
closes the browser tab; rebind `rightPanel.close` and `terminal.close` to an available
shortcut such as `alt+w`.
If closing an integrated terminal fails, its tab stays open so you can retry once
the environment is available. A failed close does not type `exit` into the shell.

`mod+shift+t` reopens the last closed tab across the app, including files,
diffs, pull requests, browsers, and devices, in the order you closed them.
A browser opens in a fresh session without its old page history. Incognito tabs
can reopen until you reload or quit the app. This shortcut does not undo deleted work.
Browsers also use it to reopen browser tabs; choose another binding in Settings
if the browser takes it first.

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
