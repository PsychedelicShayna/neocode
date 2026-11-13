# Stats and subscription limits

Open **Usage** from the sidebar or command palette, or press `mod+u` on web and
desktop when the terminal is not focused. The page now opens the same native
NeoPi dashboard as `/stats`, inside NeoCode's frame. The `usage.open` binding
remains configurable in **Settings → Keybindings**.

On mobile, choose **Usage** in the workspace navigation.

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

## Track subscription limits

**Usage → Limits** pools every subscription account it can see per provider, so with several Codex
or Claude accounts across your enabled environments and hubs you read one number per window rather than a
list. Each window card shows how much of the pool is left and a bar with one segment per account,
kept in the same column across windows. Accounts are ordered by their next 5-hour refill, soonest
first. For an account with no weekly quota left, this is when its session becomes usable again.
The first available window is used when no account reports a 5-hour limit. A gap means the
account does not report that window. When the provider reports reset times, the card also says
when the next reset lands and how much it hands back. The hatched
part of a segment is what that reset restores. Tap a segment or account row for the account's plan,
where it is signed in, and its reset time. On web, you can hover too. Accounts
that offer banked reset credits show a ticket count and **Use reset** in their
details. An account without a supported reset operation does not offer that action.

The same account signed in on more than one environment, or reported by a hub as well, counts once.
Filter with the environment dropdown to see what a single machine has.

When a Claude or Codex account has no overall weekly quota left, its pooled session contribution
shows 0% left. The next refill depends on both reset times: an exhausted session must also reset,
and a partly spent session may only regain its unused portion when the week resets. Missing or
stale reset times have no refill estimate; refresh Limits for a new reading. Claude's
model-specific weekly allowances keep their reported values.

Opening Limits checks the selected connected environments automatically. Each client waits at
least five minutes between automatic checks of an environment, including after a failed check.
If a window still looks stale, refresh Limits to re-check every provider and hub.

Pick `/usage-limits` from the composer's command menu, or send it as a message, to check the
current model's limits without leaving the conversation. The result opens above the composer and
closes when you dismiss it or send your next message. It uses the same snapshot as **Usage → Limits**, so it does not run the agent or refresh
anything. The command is offered only for providers that appear under **Usage → Limits**.

To keep them in view on web and desktop, turn on **Usage limits** in **Settings → Appearance → Thread details**, or right-click the thread details card.
The bottom of the thread details card then shows how much is left in each limit window of the
current provider account. Some windows, such as a weekly Opus limit, count only one model. Hover a
row to see when it resets and your pace. Turn on **Context window** to also show the thread's
context use against the model's limit. A tick on the bar marks where the provider compacts
automatically, when it reports that point.

## Connect a CLIProxyAPI hub

To see pooled accounts, open **Settings → Usage providers → Add hub**. Choose the
environment that will connect to the hub and enter its URL and management key.

The accounts appear under **Usage → Limits**. Codex accounts show banked reset credits; select an
account and choose **Use reset** to redeem one. No hub plugin is required.

This connection supplies usage information; configure
the provider separately to send agent requests through the hub. Remove the hub from the same
settings section when you no longer need it.

## Subscription usage widget

Add **Subscription usage** from your iOS or Android widget gallery to see remaining Codex and
Claude quotas. Tap it to open **Usage → Limits**; on Android this works while NeoCode is running in
the background, otherwise open the app from the launcher. On iOS, use **Edit Widget** to choose
Session, Weekly, or both for each provider. Reopen NeoCode to refresh expired readings.

## Keyboard navigation

The native dashboard owns its navigation keys. `1` through `6` choose a time
range, and `g` followed by a page letter changes pages. On web and desktop,
press `Escape` outside the embedded dashboard to return to the previous page.
