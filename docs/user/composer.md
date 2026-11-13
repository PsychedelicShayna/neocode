# Messages and context

Give the agent a task in the composer. Add files, quote a previous response, or
include a skill when the task needs more context.

Messages can contain up to 120,000 characters. Longer drafts stay in the composer
so you can shorten them or split them into several messages.

On web and desktop, scroll inside the composer to reach the rest of a long draft
or its attachments. Scrolling the conversation leaves the draft and its controls
in place.

To give a long draft more room, drag the composer's top edge, or focus **Resize
prompt** with `Tab` and use `Up` or `Down`. The chosen height is remembered but
stays within the window. Double-click the edge or press `Enter` while it has
focus to return to fitting the draft automatically.

Pasting 32 KiB or more of text adds that fragment as a text-file attachment so
the agent can inspect it without filling the model context. A smaller paste also
becomes an attachment when inserting it would exceed the message limit. On a
hardware keyboard, use `Cmd+Shift+V` on Apple devices or `Ctrl+Shift+V` elsewhere
to keep a large paste editable in the composer instead.

Slash commands, including `/model`, come from the selected NeoPi runtime and are
sent to it unchanged. Use the model button or `Alt+P` for NeoCode's graphical
switcher. If no enabled NeoPi runtime is available, the composer keeps your draft;
open **Settings → NeoCore** to enable or configure one.

Model and reasoning controls change the session's options without rewriting your
draft. NeoPi determines which options are available and how prompt text affects
the model.

Saved conversations from other runtimes remain readable, but choosing a NeoPi
model does not make them resumable. Start a new NeoPi session instead. A saved
conversation whose original runtime cannot be identified is also read-only.

In a session NeoCode runs itself, the menu marks commands that need NeoPi's
terminal interface **Terminal only**; sending one shows NeoPi's explanation
instead of reaching the model. In a session attached to a terminal NeoPi, those
commands run in that terminal as if typed there. After a command name and a
space, the menu offers NeoPi's completions for the argument text before the caret.
Suggestions update as you type; `Tab` takes the first, and `Enter` sends what you
typed unless you highlight a completion first.

If the terminal NeoPi that owns a session restarts (`/restart`), NeoCode reattaches
when it comes back; a message you send meanwhile waits for it. If the terminal
quits and nothing replaces it within about ten seconds, the session stays open: send
a message or choose **Continue in NeoCode** and NeoCode runs it from then on, but
never while a terminal still owns it. **Detach from terminal session** lets go
without ending the terminal's session; the tab stays put with a **Reconnect** button.

When NeoPi fails to start a turn in a saved conversation, web and desktop return
the unsent prompt and its attachments to an empty composer. If you've already
started another draft there, it stays unchanged: send or clear it before using
**Restore prompt** on the error notice. Recovery stays with the original
conversation when you visit Settings, open a fresh draft, or switch conversations;
it never fills the destination composer. Dismissing that notice discards its
retained failed prompt. Recover it before reloading or closing the window:
the pending recovery copy is kept only in that window's memory. Once NeoPi has
acknowledged your prompt, a later error does not restore it as unsent.

## Formatting

The composer writes Markdown and shows it styled as you type. When your cursor
is on styled text, its Markdown shows instead, such as `**bold**`, and the
markers edit like any other text: delete them to remove the style, or change
`**` to `*` for italic. The style updates when your cursor leaves. To write
plain Markdown with no styling, turn off **Settings → Chat → Rich text
composer**. Lines starting with `- `, `1. `, `- [ ] `, `> `, `# ` or `---`
become lists, task lists, quotes, headings and rules; ` ``` ` followed by Enter
opens a code block. What you typed is what the agent receives, markers and
numbering included, and `#1234` without a space still looks up a pull request.

Some styled text containing or touching literal Markdown characters, such as a
bold `path\` or `2*3`, keeps its styling without showing markers. Use formatting
shortcuts or turn off rich text to edit the formatting of those ranges.

Enter sends. In a list or quote, **Shift+Enter** continues it, and Shift+Enter
on an empty line moves out one level, then leaves it; **Tab** nests a list item
under the one above and **Shift+Tab** moves it back out. In a code block, Enter
starts a new line at the current indentation, **Tab** and **Shift+Tab** indent
the selected lines, and a closing ` ``` ` followed by Enter, or two blank lines
at the end, leave the block. **Backspace** at the start of a code block turns it
back into plain lines. Choose the language in a code block's corner to change
it. Very large code blocks are shown without syntax highlighting.

## Attach files

Attach up to 100 files per message. Each image can be up to 10 MiB, with at most
80 MiB of images in one message. Other files, including videos, can be up to
50 MiB each, subject to the environment's upload support and limit. The agent
receives them on the environment's machine. NeoPi's model and provider limits
still apply, including images already in the conversation. A video attachment
gives the agent a file path.

Uploads begin when you add an attachment. All uploads must finish before the
message can send. Retry or remove a failed upload. On web and desktop, reloading
before an upload finishes requires you to attach that file again.

You can drag or paste images into the web or desktop composer. HEIC and HEIF
photos are converted to JPEG there and when selected from the mobile photo
library; photos over the image limit are also resized to fit. On mobile, you can
also send files to NeoCode through another app's system share sheet.
On Android, you can also drag images from another app into the message input
in split screen.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Send while the agent is working

On web and desktop, choose **Settings → Chat → Follow-up behavior** to queue
new messages for a later turn or steer the running turn immediately. The setting
applies to this client; already queued messages keep their place. Queued messages
are saved on the server and can be edited or removed before they send.
When Enter sends, `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux uses
the opposite action: it steers when your default is Queue and queues when your
default is Steer.
If your **Send shortcut** requires `Cmd+Enter` or `Ctrl+Enter`, that shortcut uses
your default follow-up behavior; add **Shift** to use the opposite action. This
applies only to multiline messages when you choose the multiline send option.

Use `Cmd+Shift+Enter` on macOS or `Ctrl+Shift+Enter` on Windows and Linux to send
the oldest queued message as a steer. This leaves the current draft intact and
requires an active turn that supports steering. If that shortcut sends the opposite
action for your draft, move focus outside the composer to steer the queued message. Change
`thread.steerQueuedMessage` in **Settings → Keybindings** to use another shortcut.

Press `Option+Up` on macOS or `Alt+Up` on Windows and Linux with the cursor at the
start of the composer to edit the most recently queued message. Change
`thread.editQueuedMessage` to use another shortcut.

Mobile has the same choice under **Settings → Chat**. While a turn is
running the send button shows which action it will take. Long-press it to use the
other action for a single message. From a hardware keyboard, `Cmd+Return`
(`Ctrl+Return` on Android) uses the other action, or `Cmd+Shift+Return`
(`Ctrl+Shift+Return`) when Return inserts a new line. The button only offers
Steer when the running agent supports it.

In native NeoPi sessions, cancelling queued input returns its text, context and
attachments without replacing a draft you are still writing. Input that has
already been dispatched is not copied back into the composer. With a current
NeoPi, **Stop** (or Escape on web and desktop) also withdraws queued steering
and follow-up messages before stopping the turn, then returns them oldest first.
Older NeoPi versions keep their original abort behavior and do not withdraw the
queue. If an attachment is no longer available on its server, the composer names
it so you can attach it again.

## Mobile drafts while offline

Mobile saves drafts and local copies of their attachments on the device, so you
can keep writing and previewing files while disconnected. Reconnect before sending
to a native session.

**New task** creates a native session online; offline queueing is unsupported for
new tasks. Choose a project or scratch workspace, a model, and optionally a new
worktree, then send while connected. Setup failures keep the created session and
its unsent draft available. If the connection drops during creation or sending,
check **Sessions** before trying again: a missing response does not prove that
the session or prompt was rejected.

## Switch models

On web and desktop, click the current model or press `Alt+P` to open the model
picker. It opens as a popover anchored to the button, with the cursor already in
the search box, and nothing else on screen is blocked: click outside or press
Escape to close it.

The left rail lists **Roles** first, then **Favorites**, then NeoPi's inference
providers; the right side lists that entry's models. Typing searches every
provider and role with NeoPi's own ranking. Each row shows what NeoPi reported
for the model, such as context window, per-million-token prices and
intelligence; hover a row for the full set. A question mark or a missing fact
means the native source has not supplied it. Missing metrics do not make a model
unavailable; you can still select it. Saved selections that are no longer
available stay visible.

If several NeoPi runtimes are enabled, their choices appear as each runtime
answers. You can use an available model without waiting for another runtime;
a failed runtime reports its own error without hiding the others.

Star a model to add it to Favorites. Use the arrow keys and Enter to select, or
click a model; Left and Right move between the rail and the list. Choosing a role
or model applies it to the session and returns focus to the prompt. This is the
quick session switcher, separate from the Roles management page.

On mobile, you can still choose a model if the connected NeoPi cannot provide
its role list.

## Custom models

NeoPi owns the model catalog and role configuration. Use **Settings → Roles** to
inspect the catalog and manage native model roles. Configure an unlisted model
in NeoPi rather than adding a separate NeoCode runtime.

The switcher's filter searches the native catalog, including models outside the
visible rows. Missing catalog facts remain unknown instead of being filled with
invented limits or prices.

## Model defaults

NeoCode remembers your provider, model, and model options for new threads. A
project's configured model takes precedence; resetting that project setting
returns to the remembered selection.

Leaving reasoning level or service tier unset uses the provider's own configuration.

NeoPi's model and role badges describe supported capabilities, not which
settings are currently enabled. A **Fast mode** badge does not mean the current
turn uses Fast mode. Role badges follow the model NeoPi resolves for that role.
A reasoning model can have a **Reasoning** badge without offering an effort selector.

## Quote an assistant response

On web and desktop, select text within one assistant response and choose
**Cite in composer**. You can add a comment about the quote and write instructions
around it.

Select the quote in a draft or sent message to return to its source. If the source
is unavailable or has changed, the saved quote remains readable.

The chip shows your comment when it has one, or a short quote preview otherwise. Use the pencil
button to add or change the comment. To remove the citation, place the caret beside its chip and
delete it like other inline context. Copying, reloading, and restoring a
[stashed prompt](#prompt-stash) keep each comment
with its quote, and sending tells the agent which words were quoted and which comment you wrote.
The quoted text and comment count toward the message limit.

Mobile displays saved quotes and comments, but does not create citations or
navigate to their sources.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this thread. Press
`ArrowUp` again to go further back, and `ArrowDown` to come forward. Moving forward past the newest
prompt clears the composer. Recall walks the prompts loaded in the thread. Attachments, terminal
context, and other extras from the original message are not restored, only the text you typed. A
composer that holds an attachment or a picked element does not count as empty.

When the composer has text, the arrow keys move the caret as usual. Recall takes over only while
the text is an unedited recalled prompt, with the caret on the first visual line for `ArrowUp` or
the last visual line for `ArrowDown`, counting wrapped lines. Editing a recalled prompt turns it
into a normal draft.

## Edit an earlier prompt

On web and desktop, choose **Edit from here** beneath a sent message to rewind
the conversation to before that message. Choose **Revert and keep changes** to
leave workspace files as they are, or **Revert files too** to put the workspace back
to its checkpoint from before that message. That also undoes edits you made yourself.
File restore is only offered for threads running in a worktree, and it is
refused when another thread or agent session also uses that directory, a folder
inside it, or a folder that contains it, since
restoring would erase their changes. A thread that works in the project directory
rewinds the conversation only. The selected prompt and its attachments return to the composer for editing and
resending. Any unsent draft stays above the restored prompt.

This removes the selected message and later conversation from the active thread
and provider history. It does not undo external actions or separate provider
memory. The action is available only when the provider supports rewind.

## Prompt stash

On web and desktop, press `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux to save
the current prompt and its attachments for later. Wait for uploads to finish first.
With an empty composer, the same shortcut restores a single stash or opens the
stash menu when there are several.

Stashes containing uploaded files must be restored in their original environment.
Those files are retained for 24 hours. After an upload expires, restore the prompt
and use **Attach again** or remove the missing file before sending.

## Voice input on web and desktop

Use the composer's microphone or `mod+shift+d` to dictate into your draft. Audio
is transcribed on an environment you choose in **Settings → Voice**; nothing is
sent until you choose one. See [Voice input](./voice-input.md).

## Voice input on mobile

Use the composer's microphone to record, then confirm to transcribe. Text is
inserted where your selection was when recording started, ready for you to review
and edit before sending.
Finish or cancel voice input before choosing a slash-command suggestion or
sending the draft.
By default, audio stays on the phone. Local transcription needs a supported iPhone
with iOS 26 or later, or Android 12 or later with compatible Google speech services.
To use a paired environment instead, open **Settings → Voice → Transcribe on**,
choose the environment, and confirm. Finished recordings go only to that environment,
even when a draft belongs to another one. This also works on phones without local
speech recognition. If the chosen environment disconnects, dictation stops; it never
switches hosts. Choose **This device** to revoke access and discard pending audio.
For [cloud dictation](./voice-input.md#choose-where-audio-goes), open **Cloud providers**
under the environment in **Settings → Voice** and confirm which provider may receive recordings.
On Android, keep NeoCode open while recording and transcribing.

On-device dictation may need a network connection to download a speech model the
first time. After that it works offline for that language. iPhone dictates in the
first of your preferred languages (**Settings → General → Language & Region**)
that Apple’s speech model supports. If none is supported, it tries the app’s
language. Android transcribes on the device while you
record and finishes after you stop. Recordings can be up to five
minutes long. Canceling or an audio interruption discards the recording and
preserves your existing draft. Navigating to another screen keeps dictation active;
use the floating controls to finish or cancel. While recording, the screen stays
awake; it can sleep normally once recording stops.

Choose a preferred order in **Settings → Voice**. Voice input requests the first
connected microphone in the list. The list mixes kinds (built-in, other wired, other
Bluetooth, and CarPlay on iOS) with wired and Bluetooth devices you have dictated
with, listed by name. Drag to rank them together:
for example, put **Other Bluetooth** above your AirPods so a new headset is preferred
while the AirPods microphone stays low. By default, CarPlay comes after the built-in
microphone on iOS. Swipe a device left to forget it. Android may use another input
when the preferred microphone cannot be routed. Devices with the same name may share
a saved preference, but simultaneous same-name inputs remain separately selectable.

NeoCode deletes the temporary recording from your phone after transcription or
cancellation. The transcript stays in your draft until you send the message to the agent.

## Queued messages

On web and desktop, the composer shows **Interrupt** while the agent is working and the draft is
empty. Adding text or attachments replaces it with a send button that shows your
[Follow-up behavior](#send-while-the-agent-is-working): a queue icon for Queue or a steer arrow for
Steer. Click it or press your send shortcut to use that action. Hold `Cmd` on macOS or `Ctrl` on
Windows and Linux to switch the button to the opposite action, then click, or use the opposite-action
shortcut described above.

On web and desktop, queued messages appear at the end of the thread as dashed messages that have
not been sent yet. On mobile they appear above the composer. Each shows its text and any attached
images. **Send now** sends a message right away, into the running turn if there is one. You can
also edit or remove it.

If you stop the agent or the server restarts, queued messages keep their order and are held.
Press **Resume** in an empty composer to continue. **Resume** also continues a stopped
run or one that hit a usage limit, even with nothing queued. Sending a new message also resumes the queue, unless it steers a turn that is already
running. You can edit or remove held messages without starting them.

The pencil on a queued message opens it in the composer for editing. The original message
stays in the queue until you save, and it is highlighted while you edit. The message's
attachments appear above the text with a remove control, and new images can be added the usual way.
The checkmark saves the queued message in place; **Cancel** next to it leaves it unchanged. Whatever
you had typed in the composer before starting the edit is restored afterwards. If the queued
message starts or is removed while you are editing, the edit ends: changed content moves into the
composer when it is empty, and is discarded otherwise.

## Dictate on the desktop app

In the desktop app, the composer's microphone button (or `Ctrl+Space`, command
`composer.dictation.toggle`) has NeoPi record from this computer's microphone.
Click again to stop. While you speak, a notice above the composer shows the live
transcript. When you stop, the final text is inserted at the cursor where you
started, and nothing is sent. Press Escape to throw the recording away.

Dictation needs NeoPi's `stt.enabled` setting. If the speech model is
unavailable or live voice is running, the composer shows NeoPi's message. It
works in sessions NeoCode owns and in sessions attached to a terminal NeoPi, as
long as that NeoPi supports it. NeoPi records on the machine it runs on, so
browsers and remote environments do not have the button. In the desktop app it
is always there: when dictation cannot work it is greyed out, and hovering it
says why and what to change.

## Branch and worktree

In a native session whose folder is a git repository, a strip under the composer
shows the folder's branch. Open it to search the local branches and switch, or type
a new name to create and switch to it. A branch another worktree already holds is
listed but cannot be selected.

**New worktree** (or **Worktree**, when the session already works in one) asks for an
optional branch name and runs NeoPi's `/wt`: NeoPi creates the worktree, carries
uncommitted changes into it and moves the session there. The tab and header stay on
the same session. Both controls are disabled while NeoPi is working or disconnected:
NeoPi refuses `/wt` mid-run, and switching branches would change files under it.
If that happens while the worktree form is open, its branch name stays in place
until NeoPi is ready again.

## Commands and skills

Type `/` for commands or `$` to add a skill from the selected environment and
provider. On mobile, both are also available before starting a thread on
**New task**.

The slash menu also includes skills unless you turn off **Settings → Chat →
Show skills in slash menu**, under Advanced. Only skills enabled for the provider are listed.

NeoPi owns slash-command availability and behavior, including restarting,
compacting and clearing a session. Follow its command descriptions and argument
suggestions; NeoCode does not replace them with commands for another runtime.

On web and desktop, turn on **Context window** in **Settings → Appearance →
Thread details** to see context usage in the thread details card. It appears
once the provider reports usage.

## Context in your message

Context you attach lands where your cursor is, as a chip inside your text: a terminal excerpt,
a review comment from a diff or file, a preview annotation, or a file. You can type before and
after a chip, move it by cutting and pasting, and delete it like a character. Hover a chip for
its brief details. Select a terminal excerpt to open its captured output, or select a review
comment, picked element, or preview annotation to open its full details. Chips read as "Terminal
excerpt, Terminal 1 lines 3-4" and similar to screen readers.

A pull request appears as its icon and number. Its color reflects whether it was open, draft,
merged, or closed when it was attached. Select it to inspect the captured title and branches,
then choose **Open pull request** to visit the pull request. On web and desktop, type `#` to browse the newest
pull requests in the current project's repository. Pull requests linked to the thread are included
from any repository and listed first, after any exact number match. Continue typing digits to filter the recent list
by any part of its pull request numbers. A complete number is also resolved directly, even when that
pull request is older than the recent list. Type a single word after `#` to search pull requests in
the repository by text. Choose a result to insert it as a chip.

Another thread can be context too. Type `@` followed by part of its title to pick one from
the same server, or from a machine it links to while the Linked environments beta is on; those
show the machine's name. On web and desktop you can also drag a thread out of the sidebar and
drop it on the composer; a multi-selection drops together. On any client, **Copy thread** copies a
link to the thread that pastes into a composer as its chip. The chip shows the thread's
current title and opens it when selected. Your prompt only carries a reference: the agent reads the thread's
history on demand, so attaching a long thread costs nothing until the agent looks. Attaching a
thread does not change it, and the agent cannot send messages to it unless you ask.

A thread from a linked machine, picked, pasted or dropped, stays a reference that the agent reads
on that machine. A pasted link to a thread on any other machine stays a link. Dropping a thread
from any other environment attaches a saved transcript file. The source
environment must be connected and up to date. The transcript includes the visible history and
saved text context at the time of the drop; later messages and the contents of attached files
are not copied. The agent can read the saved transcript after the source disconnects. Normal
file attachment limits apply.

Type `@` and part of a model or provider name, such as `@opus`, to name that model for the
agent, for example when delegating. It does not change the thread's model. Join words with
`:`, `/` or `-`, using the provider IDs advertised by NeoPi.

Images keep their thumbnail shelf above the text and also get a chip at your cursor, so you can
say exactly which image you mean. Deleting an image chip leaves the image on the shelf; removing
the thumbnail asks first when the image is still mentioned in your text, then removes both. Files
exist only as chips: deleting a file's last chip removes the file from the message.

Copy text that holds chips and paste it into another draft, in the same thread or another one,
and the chips come along with what they point to. Images and files are fetched again from the
environment they came from; while that happens the chip shows a dashed outline, and if it cannot
complete NeoCode tells you and leaves the chip for you to remove or replace. A chip whose
context is no longer available shows the same dashed outline; hover it for what to do.

Copying a message with the copy button, or copying text out of it, gives other apps readable
Markdown with a link in place of each chip. Older messages that were sent before chips still
show their context. Stashing a prompt keeps its chips and what they point to; restoring brings
them back.

On mobile, tap a chip to inspect its content. File references open the current file; attached
files show the copy that was attached to the message.

## Attached files

Select a file chip in your draft or a sent message to preview it. Code and JSON use syntax
highlighting; Markdown, HTML, CSV, and TSV offer rendered and raw views. Audio files have
playback controls. Large text files show a limited preview; save the file to read it in full.
Attached files are read-only copies; edits to workspace files save automatically.

On web and desktop, files open beside the conversation with the same controls as a workspace
file: a header row with the view toggle, **Copy contents** and **Save file**. On mobile, documents
open in the same file screen as workspace files; its menu holds **Copy contents**, **Save or
share** and **Open in file viewer**. Pictures, videos and PDFs keep their native viewers, and
other document formats such as Word or Pages open in the device's own viewer when it has one.
If nothing on the device can show a format, save or share it to open it elsewhere. A ZIP up to
50 MB opens as a folder list on every surface; on mobile, select a file inside it to preview,
save, or add it to chat.

## Images and videos in messages

Select an image or video attachment or link to preview it. Playback support depends
on your browser or device; save an unsupported video to open it in another app.

On web and desktop, right-click media to save it or copy its path or URL. On mobile,
touch and hold an image or video thumbnail and choose **Save or share**. On iOS,
return to the thumbnail to open this menu after watching a full-screen video.

File links refer to the environment's machine, including when you connect remotely.
Previews use the original file, even outside the workspace. Moving or deleting it
can break the preview, so save a copy if you need to keep it.

## Files outside the workspace

Follow an agent's file link to read a report or other file outside the workspace.
These files open read-only. An HTML file outside the workspace cannot load scripts,
styles, or images from neighboring files.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open as rendered pages. Switch an HTML
file to source view to read its markup; a link to a specific line opens source
automatically. HTML previews cannot access your NeoCode session.

The file viewer recognizes images, HTML, and PDF files by their filename extension,
including filenames or folders containing `#` or `?`.

On mobile, select a PDF attachment or link to open it. iOS uses the native viewer;
Android opens a compatible installed file viewer.
