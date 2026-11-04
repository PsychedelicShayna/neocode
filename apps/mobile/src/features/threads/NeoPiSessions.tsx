import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { MaterialButton } from "../../components/MaterialButton";
import { NativeModal as SessionModal } from "./NativeNeoPiControls";
import { NativeSessionBrowser } from "./NativeSessionBrowser";

export function NeoPiSessionBrowser({
  environmentId,
  disabled = false,
}: {
  environmentId: EnvironmentId;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MaterialButton
        label="Resume NeoPi session"
        disabled={disabled}
        onPress={() => setOpen(true)}
      />
      {open ? (
        <SessionModal title="Sessions" onClose={() => setOpen(false)}>
          <NativeSessionBrowser environmentId={environmentId} />
        </SessionModal>
      ) : null}
    </>
  );
}
