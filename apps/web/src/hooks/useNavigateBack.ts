import { useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { isSidebarUtilityPage, useNavigateToMainApp } from "../components/sidebar/mainAppLocation";

/** Utility pages return to the workspace; ordinary pages retain browser history behavior. */
export function useNavigateBack() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigateToMainApp = useNavigateToMainApp();

  return () => {
    if (isSidebarUtilityPage(pathname)) {
      void navigateToMainApp();
      return;
    }
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  };
}

/** Enables page-level Escape navigation, letting controls consume Escape first. */
export function useEscapeToGoBack(onEscape?: () => void) {
  const navigateBack = useNavigateBack();
  const handleEscape = onEscape ?? navigateBack;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the page-level keyboard listener
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.key !== "Escape")
        return;
      event.preventDefault();

      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }

      handleEscape();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleEscape]);
}
