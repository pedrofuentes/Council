import { useState } from "react";
import { useInput } from "ink";

export interface UseListSelectionOptions {
  readonly count: number;
  readonly isActive?: boolean;
  readonly onActivate?: (index: number) => void;
}

export function useListSelection(opts: UseListSelectionOptions): { readonly cursor: number } {
  const isActive = opts.isActive ?? true;
  const [cursor, setCursor] = useState(0);
  const last = Math.max(0, opts.count - 1);

  useInput(
    (input, key) => {
      if (opts.count === 0) return;
      if (input === "j" || key.downArrow) {
        setCursor((c) => Math.min(last, c + 1));
      } else if (input === "k" || key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
      } else if (input === "g") {
        setCursor(0);
      } else if (input === "G") {
        setCursor(last);
      } else if (key.return) {
        opts.onActivate?.(Math.min(cursor, last));
      }
    },
    { isActive },
  );

  return { cursor: Math.min(cursor, last) };
}
