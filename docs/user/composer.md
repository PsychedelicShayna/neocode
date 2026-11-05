# Messages and context

Give the agent a task in the composer. Add files, quote a previous response, or
include a skill when the task needs more context.

Messages can contain up to 120,000 characters. Longer drafts stay in the composer
so you can shorten them or split them into several messages.

On web and desktop, scroll inside the composer to reach the rest of a long draft
or its attachments. Scrolling the conversation leaves the draft and its controls
in place.

Pasting 32 KiB or more of text adds that fragment as a text-file attachment so
the agent can inspect it without filling the model context. A smaller paste also
becomes an attachment when inserting it would exceed the message limit. On a
hardware keyboard, use `Cmd+Shift+V` on Apple devices or `Ctrl+Shift+V` elsewhere
to keep a large paste editable in the composer instead.

Slash commands, including `/model`, come from the selected NeoPi runtime and are
sent to it unchanged. Use the model button or `Alt+P` for NeoCode's graphical
switcher. If no enabled NeoPi runtime is available, the composer keeps your draft;
open **Settings → NeoCore** to enable or configure one.

In a session NeoCode runs itself, the menu marks commands that need NeoPi's
terminal interface **Terminal only**; sending one shows NeoPi's explanation
instead of reaching the model. In a session attached to a terminal NeoPi, those
commands run in that terminal as if typed there. After a command name and a
space, the menu offers NeoPi's completions for its argument: `Tab` takes the
first, and `Enter` sends what you typed unless you highlight a completion first.

When NeoPi fails to start a turn in a saved conversation, web and desktop return
the unsent prompt and its attachments to an empty composer. If you've already
started another draft there, it stays unchanged: send or clear it before using
**Restore prompt** on the error notice. Recovery stays with the original
conversation when you visit Settings, open a fresh draft, or switch conversations;
it never fills the destination composer. Dismissing that notice discards its
retained failed prompt. Recover it before reloading or closing the window:
the pending recovery copy is kept only in that window's memory.

## Attach files

Attach up to 100 files per message. Each image can be up to 10 MiB, with at most
80 MiB of images in one message. Other files, including videos, can be up to
50 MiB each, subject to the environment's upload support and limit. The agent
receives them on the environment's machine. Provider and model limits still
apply, including images already in the conversation. A video attachment gives
the agent a file path; it does not enable native video input.

Uploads begin when you add an attachment. All uploads must finish before the
message can send. Retry or remove a failed upload. On web and desktop, reloading
before an upload finishes requires you to attach that file again.

You can drag or paste images into the web or desktop composer. HEIC and HEIF
photos are converted to JPEG there and when selected from the mobile photo
library; photos over the image limit are also resized to fit. On mobile, you can
also send files to T3 Code through another app's system share sheet.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Send while the agent is working

On web and desktop, a message sent during a running turn waits at the end of the conversation as a
dashed bubble. It goes out on its own when the agent finishes its next tool
call, or when the turn ends, even while you have another thread open. Use the arrow under the bubble to send it right
away, or the X to move it back into the composer. Stop returns every queued
message to the composer.

In **Settings → General → Follow-up behavior**, choose **Queue** to keep this
behavior or **Steer** to send new messages immediately. This setting applies to
the current client. Messages already queued keep their place.

Use `Cmd+Shift+Enter` on macOS or `Ctrl+Shift+Enter` on Windows and Linux to send
the oldest queued message now. Change `thread.steerQueuedMessage` in
**Settings → Keybindings** to use another shortcut. It leaves the current draft
in the composer and waits if the agent needs an approval or an answer.

## Queue messages offline on mobile

Mobile keeps local copies of draft attachments, so you can preview them and queue
messages while disconnected. Uploads resume when you reconnect. Drafts and queued
messages survive app restarts. Signing out of T3 Connect keeps that work on your
device until you sign back into the same account.

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

Star a model to add it to Favorites. Use the arrow keys and Enter to select, or
click a model; Left and Right move between the rail and the list. Choosing a role
or model applies it to the session and returns focus to the prompt. This is the
quick session switcher, separate from the Models management page.

## Custom models

NeoPi owns the model catalog and role configuration. Use **Settings → Models** to
inspect the catalog and manage native model roles. Configure an unlisted model
in NeoPi rather than adding a separate NeoCode runtime.

The switcher's filter searches the native catalog, including models outside the
visible rows. Missing catalog facts remain unknown instead of being filled with
invented limits or prices.

## Model defaults

T3 Code remembers your provider, model, and model options for new threads. A
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
leave workspace files as they are, or **Revert files too** to restore them as well.
File restore is only offered for threads running in a worktree, and it is
refused when another thread or agent session also uses that directory, since
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

## Voice input on iPhone

On supported iPhones with iOS 26 or later, use the composer's microphone to record,
then confirm to transcribe. Text is inserted where your selection was when
recording started, ready for you to review and edit before sending.
Finish or cancel voice input before choosing a slash-command suggestion or
sending the draft.

The first use may download Apple's speech model and needs a network connection.
Later transcription works offline for that language. Recordings can be up to five
minutes long. Canceling, leaving the screen, or an audio interruption discards the
recording and preserves your existing draft. While recording, the screen stays
awake; it can sleep normally once recording stops.

Transcription runs on your device. T3 Code deletes the temporary audio after
transcription or cancellation; only the message text is sent when you submit.

## Dictate on the desktop app

In the desktop app, the composer's microphone button (or `Ctrl+Space`, command
`composer.dictation.toggle`) has NeoPi record from this computer's microphone.
Click again to stop. While you speak, a notice above the composer shows the live
transcript. When you stop, the final text is inserted at the cursor where you
started, and nothing is sent. Press Escape to throw the recording away.

Dictation needs NeoPi's `stt.enabled` setting. If it is off, the speech model is
unavailable, or live voice is running, the composer shows NeoPi's message. The
button appears only for native sessions NeoCode owns on the desktop app's own
backend, because NeoPi records on the machine it runs on. Browsers and remote
environments do not offer it.

## Branch and worktree

In a native session whose folder is a git repository, a strip under the composer
shows the folder's branch. Open it to search the local branches and switch, or type
a new name to create and switch to it. A branch another worktree already holds is
listed but cannot be selected.

**New worktree** (or **Worktree**, when the session already works in one) asks for an
optional branch name and runs NeoPi's `/wt`: NeoPi creates the worktree, carries
uncommitted changes into it and moves the session there. The tab and header stay on
the same session. Both controls are disabled while NeoPi is working, because NeoPi
refuses `/wt` mid-run and switching branches would change files under it.

## Commands and skills

Type `/` for commands or `$` to add a skill from the selected environment and
provider. On mobile, both are also available before starting a thread on
**New task**.

The slash menu also includes skills unless you turn off **Settings → General →
Show skills in slash menu**. Only skills enabled for the provider are listed.

Provider commands must start the message to run. T3 Code commands such as
`/model` and `/plan`, and skill mentions, work on any line.

Send `/compact` in an existing conversation to reduce context usage when the
provider supports it. Web and desktop also offer compaction from the context meter.

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
pull requests in the current project's repository. Continue typing digits to filter the recent list
by any part of its pull request numbers. A complete number is also resolved directly, even when that
pull request is older than the recent list. Type a single word after `#` to search pull requests in
the repository by text. Choose a result to insert it as a chip.

Images keep their thumbnail shelf above the text and also get a chip at your cursor, so you can
say exactly which image you mean. Deleting an image chip leaves the image on the shelf; removing
the thumbnail asks first when the image is still mentioned in your text, then removes both. Files
exist only as chips: deleting a file's last chip removes the file from the message.

Copy text that holds chips and paste it into another draft, in the same thread or another one,
and the chips come along with what they point to. Images and files are fetched again from the
environment they came from; while that happens the chip shows a dashed outline, and if it cannot
complete T3 Code tells you and leaves the chip for you to remove or replace. A chip whose
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

On web and desktop, files open beside the conversation with the same controls as a workspace
file: a header row with the view toggle, **Copy contents** and **Save file**. On mobile, documents
open in the same file screen as workspace files; its menu holds **Copy contents**, **Save or
share** and **Open in file viewer**. Pictures, videos and PDFs keep their native viewers, and
other document formats such as Word or Pages open in the device's own viewer when it has one.
If nothing on the device can show a format, save or share it to open it elsewhere.

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
automatically. HTML previews cannot access your T3 Code session.

On mobile, select a PDF attachment or link to open it. iOS uses the native viewer;
Android opens a compatible installed file viewer.
