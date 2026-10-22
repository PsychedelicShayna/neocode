# Stats and subscription limits

Open **Usage** from the sidebar or command palette, or press `mod+u` on web and
desktop when the terminal is not focused. The page now opens the same native
NeoPi dashboard as `/stats`, inside NeoCode's frame. The `usage.open` binding
remains configurable in **Settings → Keybindings**.

## Choose the right environment

Select an environment before browsing its data. If that environment has several
NeoPi runtimes, select the runtime for the profile you want. Stats reads that
runtime's native history and credentials on its own machine. It does not combine
unrelated environments or copy their credentials into the dashboard.

Local, remote and tunnel connections use the same authenticated environment
connection as the rest of NeoCode. An older NeoPi binary without hosted stats
support shows an error rather than empty totals. Update the selected runtime and
choose **Reconnect** to open it again.

## Browse native stats

The native dashboard includes usage and model costs, providers, requests,
errors, tools, projects, sessions and traces. Use **Traces** to inspect a
session's timeline and individual entries. Native date-range and page controls
work the same way as in `/stats`.

Session ingestion runs in the background. The dashboard reports sync progress
and the indexing backlog while it works. A large history or a new date range
can take time to calculate. Loading and error states belong to that native
request, not a second NeoCode total.

Costs are API-equivalent estimates, not subscription invoices. The Frustration
page's judgment actions can spend money. They retain NeoPi's native estimate,
confirmation and configured judge behavior, and require permission to operate
the environment. Browsing stats does not start a judgment run.

## Subscription limits in a conversation

Pick `/usage-limits` from the composer's command menu to inspect the current
model's available subscription quota without leaving the conversation. API-key
accounts and some providers do not report subscription limits. Stats history
and a live subscription allowance answer different questions.

## Keyboard navigation

The native dashboard owns its navigation keys. `1` through `6` choose a time
range, and `g` followed by a page letter changes pages. On web and desktop,
press `Escape` outside the embedded dashboard to return to the previous page.
