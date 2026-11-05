import { useCallback, useState } from "react";

/** Track unsaved file surfaces without retiring their save coordinators on rerender. */
export function useNativePendingFiles() {
  const [pendingFiles, setPendingFiles] = useState<ReadonlySet<string>>(() => new Set());
  const onPendingChange = useCallback((path: string, pending: boolean) => {
    setPendingFiles((current) => {
      if (current.has(path) === pending) return current;
      const next = new Set(current);
      if (pending) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);
  return { pendingFiles, onPendingChange };
}
