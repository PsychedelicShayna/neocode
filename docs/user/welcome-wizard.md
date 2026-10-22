# Welcome wizard

NeoCode shows setup on a new installation or the first connection from the
hosted app. Existing workspaces skip it.

## Connect your computers

Select the computers where NeoPi will run. If you opened NeoCode directly from a
server or the desktop app, that computer is already connected and selected.
Its name may differ from the device running your browser.

- **T3 Connect** connects computers signed in to your account. Start their server
  so each computer remains available.
- **Add a computer** connects directly to a server on your network or tailnet.
  Start it with `t3 serve`, create a pairing link with `t3 pair`, and paste the link.

Saved computers and computers discovered through T3 Connect are selected by
default. Unchecking one does not disconnect it.

If NeoCode cannot confirm the workspace, setup shows **Still connecting**. Reload
to try again. If saved settings cannot be read, choose **Retry** when storage is
available. Setup does not replace unreadable settings with defaults.

## Check NeoPi

Setup shows NeoPi's readiness on each selected computer. Install, authenticate,
and configure inference providers in NeoPi on that computer. NeoCode does not
launch another agent's installer or sign-in flow.

Continue to the workspace when ready. Add a project by choosing its folder, or
use **Resume NeoPi session** to open native history. Setup does not scan Claude
Code or Codex directories, and does not import projects or conversations on its
own. Existing conversations are not deleted. Conversations saved from other
runtimes remain read-only.
