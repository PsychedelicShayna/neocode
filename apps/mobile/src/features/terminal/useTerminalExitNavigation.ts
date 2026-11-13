import { StackActions, useNavigation } from "@react-navigation/native";
import { useEffect, useEffectEvent, useRef } from "react";
import type { ThreadTerminalRouteParams } from "./ThreadTerminalRouteScreen";

/**
 * Leaves a terminal screen whose shell exited: to another live terminal of the
 * thread, else back. Screen navigation acts on the top route of the stack, so
 * a shell that exits while another screen is on top waits until its own screen
 * is focused again.
 */
export function useTerminalExitNavigation(target: {
  readonly params: ThreadTerminalRouteParams;
  readonly readFallbackTerminalId: () => string | null;
}) {
  const navigation = useNavigation();
  const pendingRef = useRef(false);

  const navigateAway = useEffectEvent(() => {
    const fallbackTerminalId = target.readFallbackTerminalId();
    if (fallbackTerminalId !== null) {
      navigation.dispatch(
        StackActions.replace("ThreadTerminal", {
          ...target.params,
          terminalId: fallbackTerminalId,
        }),
      );
      return;
    }
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    if ("target" in target.params) {
      navigation.dispatch(
        StackActions.replace("NativeSession", {
          environmentId: target.params.target.environmentId,
          ...target.params.target.ref,
        }),
      );
    } else {
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: target.params.environmentId,
          threadId: target.params.threadId,
        }),
      );
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focus subscription for the screen's lifetime; an exit behind another screen navigates when the user returns
  useEffect(
    () =>
      navigation.addListener("focus", () => {
        if (!pendingRef.current) return;
        pendingRef.current = false;
        navigateAway();
      }),
    [navigation],
  );

  return {
    exited: () => {
      if (navigation.isFocused()) {
        navigateAway();
        return;
      }
      pendingRef.current = true;
    },
    /** A shell that runs again before the screen regains focus keeps the screen. */
    restarted: () => {
      pendingRef.current = false;
    },
  };
}
