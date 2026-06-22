import React from "react";
import { Box, Text, useInput } from "ink";

import { stripControlChars, toSingleLineDisplay } from "../../../cli/strip-control-chars.js";

export interface MultilineInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit?: (value: string) => void;
  readonly isActive?: boolean;
}

export function MultilineInput(props: MultilineInputProps): React.ReactElement {
  const isActive = props.isActive ?? true;

  useInput(
    (input, key) => {
      // Ink reports Enter as key.return; a raw "\n" (Ctrl+J / LF) arrives as input
      // and means "insert newline".
      if (key.return) {
        props.onSubmit?.(props.value);
        return;
      }
      if (input === "\n") {
        props.onChange(props.value + "\n");
        return;
      }
      if (key.backspace || key.delete) {
        props.onChange(props.value.slice(0, -1));
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        // Sanitize typed/pasted input: drop terminal control/escape sequences and stray
        // CR/LF (newlines are inserted only via the explicit Ctrl+J branch above).
        const safe = stripControlChars(input).replace(/[\r\n]/g, "");
        if (safe.length > 0) props.onChange(props.value + safe);
      }
    },
    { isActive },
  );

  // `value` is parent-controlled and may carry untrusted content; sanitize each line for
  // single-line terminal display before rendering (escape/OSC/CR-overwrite injection defense).
  const lines = props.value.split("\n");
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const display = toSingleLineDisplay(line);
        return <Text key={i}>{display.length > 0 ? display : " "}</Text>;
      })}
    </Box>
  );
}
