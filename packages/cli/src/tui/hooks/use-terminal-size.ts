import { useEffect, useState } from "react";
import { useStdout } from "ink";

const FALLBACK_COLUMNS = 80;
const FALLBACK_ROWS = 24;

export interface ResizableStdout {
  readonly columns?: number;
  readonly rows?: number;
  on(event: "resize", listener: () => void): void;
  off(event: "resize", listener: () => void): void;
}

export interface UseTerminalSizeOptions {
  readonly stdout?: ResizableStdout;
  readonly fallbackColumns?: number;
  readonly fallbackRows?: number;
}

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export function useTerminalSize(opts: UseTerminalSizeOptions = {}): TerminalSize {
  const ink = useStdout();
  const stdout: ResizableStdout | undefined = opts.stdout ?? ink.stdout;
  const fallbackColumns = opts.fallbackColumns ?? FALLBACK_COLUMNS;
  const fallbackRows = opts.fallbackRows ?? FALLBACK_ROWS;

  const read = (): TerminalSize => ({
    columns: stdout?.columns ?? fallbackColumns,
    rows: stdout?.rows ?? fallbackRows,
  });

  const [size, setSize] = useState<TerminalSize>(read);

  useEffect(() => {
    if (stdout === undefined) return;
    const handler = (): void => {
      setSize({
        columns: stdout.columns ?? fallbackColumns,
        rows: stdout.rows ?? fallbackRows,
      });
    };
    handler();
    stdout.on("resize", handler);
    return () => {
      stdout.off("resize", handler);
    };
  }, [stdout, fallbackColumns, fallbackRows]);

  return size;
}
