# Usage and limits

Open **Usage** from the sidebar or the command palette, or press `mod+u` on web and
desktop when the terminal is not focused. Customize `usage.open` in
**Settings → Keybindings**.

## Understand your usage

**Usage** reads NeoPi session history from your connected environments. It shows
tokens, cache savings, model breakdowns, and estimated API-equivalent cost.
These estimates are not your subscription bill.

Local archive readers also retain totals from older Codex, Claude Code, Grok,
OpenCode, and Antigravity history. Reading those files does not launch or
authenticate another runtime. Their saved history locations remain readable,
including locations saved before the NeoPi-only cutover.

Cursor inference usage recorded by NeoPi is included like any other native
backend. NeoCode no longer reads Cursor CLI credentials, calls its account
dashboard, or requests Keychain access for that login.

Totals depend on the history available on each server. Shared history directories
count once across connected environments. NeoCode does not estimate missing tokens
from conversation text.

On web and desktop, use the environment dropdown to filter costs, tokens, and limits. All
environments are selected by default. The dropdown shows which environments are still scanning;
results appear as each one responds.

If recent work is missing or a new model shows no cost, refresh to rescan session history and
update model pricing.

## Set custom model prices

On web or desktop, open the environment dropdown on **Usage**, then choose **Model prices** to add,
edit, or reset a model's estimated price. **Apply to** starts with your current Usage filter;
choose all environments or select individual destinations. Enter the exact model ID and USD
rates per million input and output tokens. You can enter any model ID, including models
without public pricing.

Cache read and cache write rates are optional and use the input rate when blank. Enter `0` for
tokens that are free. Saved prices replace automatic pricing for all of that environment's
history and are shared with clients connected to it. When environments have different prices,
cells show **Mixed**. Edit rates directly in the table, then choose **Save changes** to apply all
edited rows. Untouched cells keep each environment's rate. Select one environment to inspect its
prices. **Reset to automatic** marks a model's override for removal when you save; you can undo
it before saving.

Each destination reports whether the change saved. Offline or unavailable environments are
marked **Not saved**. Reconnect them and choose **Retry failed saves** to finish the same change
without writing again to environments that already saved. Changes are not queued after you close
the dialog.

## Track subscription limits

**Usage → Limits** shows the subscription windows reported by NeoPi and optional
usage hubs. Each window shows the available quota, account segments, and reset
times when the source reports them. Select an account to inspect its details.
On narrow screens, numbered rows below the bar open the same details.

Missing or unattributable account usage stays unavailable rather than being
guessed from another login. Sign-in and active-account selection belong to NeoPi.
NeoCode does not open a retired runtime's login flow to fill in missing data.

Hub accounts that report banked reset credits can expose **Use reset** in their
details. The hub performs that operation; it does not start another agent runtime.

The same account signed in on more than one environment, or reported by a hub as well, counts once.
Filter with the environment dropdown to see what a single machine has.

Opening Limits checks the selected connected environments automatically. Each client waits at
least five minutes between automatic checks of an environment, including after a failed check.
If a window still looks stale, refresh Limits to re-check every provider and hub.

Pick `/usage-limits` from the composer's command menu, or send it as a message, to check the
current model's limits without leaving the conversation. The result opens above the composer and
closes when you dismiss it or send your next message. It uses the same snapshot as **Usage → Limits**, so it does not run the agent or refresh
anything. The command is offered only for providers that appear under **Usage → Limits**.

Subscription windows depend on the inference provider and account type. Some
API-key backends do not report them. Configure the provider and authenticate in
NeoPi, then refresh Limits.

## Connect a CLIProxyAPI hub

To see pooled accounts, open **Settings → Providers → Usage providers → Add hub**. Choose the
environment that will connect to the hub and enter its URL and management key.

The accounts appear under **Usage → Limits**. Codex accounts show banked reset credits; select an
account and choose **Use reset** to redeem one. No hub plugin is required.

This connection supplies quota information only. Configure inference routing in
NeoPi separately. Remove the hub from the same settings section when you no
longer need it.

## Subscription usage widget

Add **Subscription usage** from your iOS or Android widget gallery to see the
OpenAI and Anthropic quota snapshots supplied by connected hubs. Tap it to open
**Usage → Limits** for the full in-app report. On iOS, use **Edit Widget** to choose
Session, Weekly, or both. Reopen NeoCode to refresh expired readings. The Android
widget requires Android 12L or later.

## Keyboard shortcuts

On web and desktop, open Usage from the command palette. While on Usage,
press `C`, `T`, or `L` for Cost, Tokens, or Limits while not typing in a field.
Use `Ctrl+Shift+1/2/3/4` (`Cmd+Shift+1/2/3/4` on macOS) for the past
24 hours, 7 days, 30 days, or 90 days. Period shortcuts do nothing on Limits.
Press `Escape` to return to the previous page. Customize these shortcuts in
**Settings → Keybindings**.
