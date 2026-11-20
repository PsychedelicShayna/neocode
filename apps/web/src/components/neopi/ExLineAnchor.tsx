import { createContext, useContext, type ReactNode } from "react";

/** Receives the status bar's row, where the Ex line opens while that row is on screen. */
export const ExLineAnchorContext = createContext<(element: HTMLDivElement | null) => void>(
  () => undefined,
);

/** Marks the row the Ex line takes over: the line is laid exactly over its box. */
export function ExLineAnchor({ children }: { children: ReactNode }) {
  const setAnchor = useContext(ExLineAnchorContext);
  return (
    <div ref={setAnchor} className="relative shrink-0">
      {children}
    </div>
  );
}
