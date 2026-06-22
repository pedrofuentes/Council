import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";

import { fuzzyMatch } from "../../lib/fuzzy.js";
import { toSingleLineDisplay } from "../../../cli/strip-control-chars.js";

export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
}

export interface CommandPaletteProps {
  readonly commands: readonly PaletteCommand[];
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
  readonly isActive?: boolean;
}

export function CommandPalette(props: CommandPaletteProps): React.ReactElement {
  const isActive = props.isActive ?? true;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const results = useMemo(() => {
    return props.commands
      .map((cmd) => ({ cmd, match: fuzzyMatch(query, cmd.label) }))
      .filter((r): r is { cmd: PaletteCommand; match: { score: number; positions: readonly number[] } } =>
        r.match !== null,
      )
      .sort((a, b) => b.match.score - a.match.score);
  }, [props.commands, query]);

  useInput(
    (input, key) => {
      if (key.escape) {
        props.onClose();
        return;
      }
      if (key.return) {
        const chosen = results[Math.min(selected, results.length - 1)];
        if (chosen) props.onSelect(chosen.cmd.id);
        return;
      }
      if (key.upArrow) {
        setSelected((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setSelected((s) => Math.min(results.length - 1, s + 1));
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        setSelected(0);
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
        setSelected(0);
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text>{`> ${toSingleLineDisplay(query)}`}</Text>
      {results.map((r, i) => (
        <Text key={r.cmd.id} inverse={i === Math.min(selected, results.length - 1)}>
          {toSingleLineDisplay(r.cmd.label)}
        </Text>
      ))}
    </Box>
  );
}
