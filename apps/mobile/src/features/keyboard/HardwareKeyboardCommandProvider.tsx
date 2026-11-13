import { StackActions, useNavigation } from "@react-navigation/native";
import { Platform } from "react-native";
import { resolveThreadReferenceCopyTarget } from "@t3tools/client-runtime/thread-reference";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
  type ReactNode,
} from "react";

import * as Dialog from "../../components/ui/Dialog";
import { nativeSessionAtoms } from "../../state/neopiNativeSessions";
import { useOpenNativeSession } from "../threads/NativeSessionBrowser";
import { copyThreadReference } from "../../lib/copyThreadReference";
import {
  firstWorkspaceDetailOpen,
  workspaceHasColumns,
} from "../layout/workspace/workspace-selection-store";
import { T3KeyboardCommands } from "../../native/T3KeyboardCommands";
import { useThreadShell } from "../../state/entities";
import type { GitActionProgress } from "../../state/use-vcs-action-state";
import { GitActionProgressOverlay } from "../threads/GitActionProgressOverlay";
import { CommandPalette } from "./CommandPalette";
import {
  dispatchHardwareKeyboardCommand,
  getHardwareKeyboardCommandRegistrationVersion,
  getRegisteredHardwareKeyboardCommands,
  parseActiveThreadPath,
  subscribeToHardwareKeyboardCommandRegistrations,
  type HardwareKeyboardCommand,
  type resolveNativeWorkspaceRoute,
} from "./hardwareKeyboardCommands";
import { selectWorkspaceDetail } from "../layout/workspace/workspace-detail-selection";

const EMPTY_COPY_FEEDBACK: GitActionProgress = {
  phase: "idle",
  label: null,
  description: null,
};
const COPY_FEEDBACK_DISMISS_MS = 3_000;

const CommandPaletteContext = createContext<ReactNode>(null);

/** Render inside the workspace so palette actions share its navigation and pane state. */
export function HardwareKeyboardCommandOverlay() {
  return use(CommandPaletteContext);
}

export function HardwareKeyboardCommandProvider({
  children,
  pathname,
  nativeWorkspace,
}: PropsWithChildren<{
  readonly pathname: string;
  readonly nativeWorkspace?: ReturnType<typeof resolveNativeWorkspaceRoute>;
}>) {
  const navigation = useNavigation();
  const openNativeSession = useOpenNativeSession();
  const nativeCwd = nativeWorkspace
    ? (nativeSessionAtoms.cached(nativeWorkspace.target)?.session?.cwd ??
      nativeWorkspace.cwd ??
      null)
    : null;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const activeThreadRef = useMemo(() => parseActiveThreadPath(pathname), [pathname]);
  const activeThread = useThreadShell(activeThreadRef);
  const copyTarget = useMemo(
    () =>
      activeThreadRef === null
        ? null
        : resolveThreadReferenceCopyTarget({
            threadRef: activeThreadRef,
            title: activeThread?.title ?? "",
            pullRequests: activeThread?.pullRequests,
            linkedPullRequestUrl:
              (activeThread?.linkedPullRequest ?? activeThread?.branchPullRequest)?.url ?? null,
          }),
    [activeThread, activeThreadRef],
  );
  const [copyFeedback, setCopyFeedback] = useState<GitActionProgress>(EMPTY_COPY_FEEDBACK);
  const copyRequestIdRef = useRef(0);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissCopyFeedback = useCallback(() => {
    if (copyFeedbackTimerRef.current !== null) {
      clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = null;
    }
    setCopyFeedback(EMPTY_COPY_FEEDBACK);
  }, []);
  const showCopyFeedback = useCallback((feedback: GitActionProgress) => {
    if (copyFeedbackTimerRef.current !== null) {
      clearTimeout(copyFeedbackTimerRef.current);
    }
    setCopyFeedback(feedback);
    copyFeedbackTimerRef.current = setTimeout(() => {
      copyFeedbackTimerRef.current = null;
      setCopyFeedback(EMPTY_COPY_FEEDBACK);
    }, COPY_FEEDBACK_DISMISS_MS);
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the copy feedback timer on unmount
  useEffect(
    () => () => {
      if (copyFeedbackTimerRef.current !== null) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
    },
    [],
  );
  const registrationVersion = useSyncExternalStore(
    subscribeToHardwareKeyboardCommandRegistrations,
    getHardwareKeyboardCommandRegistrationVersion,
    getHardwareKeyboardCommandRegistrationVersion,
  );
  const enabledCommands = useMemo(() => {
    const commands = new Set<HardwareKeyboardCommand>(getRegisteredHardwareKeyboardCommands());
    commands.add("newTask");
    commands.add("commandPalette");
    if (pathname !== "/" && !pathname.startsWith("/threads/")) {
      for (const command of commands) {
        if (command.startsWith("thread.jump.")) commands.delete(command);
      }
    }
    if (pathname !== "/" || navigation.canGoBack()) commands.add("back");
    if (activeThreadRef !== null) {
      commands.add("files");
      commands.add("terminal");
      commands.add("review");
      if (pathname.split("/")[4] !== "terminal") commands.add("copyThreadReference");
    }
    if (nativeWorkspace && nativeCwd !== null) {
      commands.add("files");
      commands.add("terminal");
      commands.add("review");
    }
    return [...commands];
    // oxlint-disable-next-line react/memo-dependencies -- registrationVersion invalidates the snapshot of the external keyboard-command registry.
  }, [activeThreadRef, pathname, registrationVersion, navigation, nativeWorkspace, nativeCwd]);

  const onCommand = useCallback(
    (command: HardwareKeyboardCommand) => {
      if (command === "commandPalette") {
        setPaletteOpen(true);
        return;
      }
      if (dispatchHardwareKeyboardCommand(command)) return;

      if (command === "copyThreadReference") {
        if (copyTarget === null) return;
        const requestId = ++copyRequestIdRef.current;
        void copyThreadReference(copyTarget).then((didCopy) => {
          if (requestId !== copyRequestIdRef.current) return;
          showCopyFeedback(
            didCopy
              ? {
                  phase: "success",
                  label: copyTarget.successTitle,
                  description: copyTarget.description,
                }
              : {
                  phase: "error",
                  label: copyTarget.failureTitle,
                  description: "Try again.",
                },
          );
        });
        return;
      }

      if (command === "newTask") {
        if (nativeWorkspace) {
          const { target } = nativeWorkspace;
          const cwd = nativeSessionAtoms.cached(target)?.session?.cwd ?? nativeWorkspace.cwd;
          void openNativeSession(target.environmentId, {
            providerInstanceId: target.ref.providerInstanceId,
            ...(cwd === undefined ? {} : { cwd }),
          }).catch((cause) => Dialog.alert("Could not create session", String(cause)));
          return;
        }
        navigation.dispatch(selectWorkspaceDetail({ name: "Thread", params: { draft: {} } }));
        return;
      }
      if (command === "back") {
        // Beside a visible list, the first detail page has nothing to go back to.
        if (Platform.OS === "ios" && workspaceHasColumns() && firstWorkspaceDetailOpen(navigation))
          return;
        if (navigation.canGoBack()) {
          navigation.goBack();
        } else {
          navigation.dispatch(StackActions.replace("Home"));
        }
        return;
      }

      if (nativeWorkspace) {
        const { target } = nativeWorkspace;
        const cwd = nativeSessionAtoms.cached(target)?.session?.cwd ?? nativeWorkspace.cwd;
        if (cwd === undefined) return;
        if (command === "files" && !/\/files(?:\/|$)/.test(pathname))
          navigation.navigate("ThreadFiles", {
            environmentId: target.environmentId,
            nativeRef: target.ref,
            cwd,
            projectName: cwd,
          });
        if (command === "terminal" && !/\/terminal(?:\/|$)/.test(pathname))
          navigation.navigate("ThreadTerminal", { target, cwd });
        if (command === "review" && !/\/review(?:\/|$)/.test(pathname))
          navigation.navigate("ThreadReview", { target, cwd });
        return;
      }
      const thread = parseActiveThreadPath(pathname);
      if (!thread) return;
      if (command === "files" && !/\/files(?:\/|$)/.test(pathname)) {
        navigation.navigate("ThreadFiles", thread);
      }
      if (command === "terminal" && !/\/terminal(?:\/|$)/.test(pathname)) {
        navigation.navigate("ThreadTerminal", thread);
      }
      if (command === "review" && !/\/review(?:\/|$)/.test(pathname)) {
        navigation.navigate("ThreadReview", thread);
      }
    },
    [copyTarget, navigation, pathname, showCopyFeedback, nativeWorkspace, openNativeSession],
  );

  const palette = useMemo(
    () =>
      paletteOpen ? (
        <CommandPalette
          pathname={pathname}
          workspaceCommands={enabledCommands}
          onClose={closePalette}
          onCommand={onCommand}
        />
      ) : null,
    [closePalette, onCommand, paletteOpen, pathname, enabledCommands],
  );

  return (
    <CommandPaletteContext value={palette}>
      <T3KeyboardCommands enabledCommands={enabledCommands} onCommand={onCommand}>
        {children}
      </T3KeyboardCommands>
      <GitActionProgressOverlay progress={copyFeedback} onDismiss={dismissCopyFeedback} />
    </CommandPaletteContext>
  );
}
