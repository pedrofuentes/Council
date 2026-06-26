import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

import { toSingleLineDisplay } from "../../../cli/strip-control-chars.js";
import { fuzzyMatch } from "../../lib/fuzzy.js";
import { computeScrollWindow } from "../../lib/scroll.js";
import { useTerminalSize } from "../../hooks/use-terminal-size.js";
import type { SemanticTheme } from "../../theme/tokens.js";

const CHROME_ALLOWANCE = 6;
const MIN_HEIGHT = 3;
const SELECTION_PREFIX = "› ";
const PLAIN_PREFIX = "  ";

export interface ListViewportItem {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
}

export interface ListViewportProps {
  readonly items: readonly ListViewportItem[];
  readonly isActive: boolean;
  readonly onSelect: (id: string) => void;
  readonly theme: SemanticTheme;
  readonly height?: number;
  readonly emptyText?: string;
  readonly title?: string;
  readonly onFilterModeChange?: (active: boolean) => void;
}

export function ListViewport(props: ListViewportProps): React.ReactElement {
  const { rows } = useTerminalSize();
  const [cursor, setCursor] = useState(0);
  const [filterMode, setFilterMode] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");

  const listHeight = props.height ?? Math.max(MIN_HEIGHT, rows - CHROME_ALLOWANCE);
  const pageSize = Math.max(1, listHeight - 1);

  const filteredItems: readonly ListViewportItem[] =
    filterQuery === ""
      ? props.items
      : props.items.filter((item) => fuzzyMatch(filterQuery, item.label) !== null);

  const totalCount = props.items.length;
  const filteredCount = filteredItems.length;
  const last = Math.max(0, filteredCount - 1);
  const safeCursor = Math.min(cursor, last);

  // Reset cursor to top whenever the filter query changes.
  useEffect(() => {
    setCursor(0);
  }, [filterQuery]);

  // Notify parent when filter mode toggled so it can gate its own action keys.
  const { onFilterModeChange } = props;
  useEffect(() => {
    onFilterModeChange?.(filterMode);
  }, [filterMode, onFilterModeChange]);

  useInput(
    (input, key) => {
      if (filterMode) {
        if (key.escape) {
          setFilterMode(false);
          setFilterQuery("");
          return;
        }
        if (key.return) {
          const item = filteredItems[safeCursor];
          if (item !== undefined) props.onSelect(item.id);
          return;
        }
        if (key.upArrow) {
          setCursor((c) => Math.max(0, c - 1));
          return;
        }
        if (key.downArrow) {
          setCursor((c) => Math.min(last, c + 1));
          return;
        }
        if (key.backspace || key.delete) {
          setFilterQuery((q) => q.slice(0, -1));
          return;
        }
        // Append printable characters to the filter query.
        if (input.length > 0 && !key.ctrl && !key.meta) {
          setFilterQuery((q) => q + input);
        }
        return;
      }

      // Navigation mode
      if (input === "/" && totalCount > 0) {
        setFilterMode(true);
        return;
      }
      if (input === "j" || key.downArrow) {
        setCursor((c) => Math.min(last, c + 1));
      } else if (input === "k" || key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
      } else if (input === "g") {
        setCursor(0);
      } else if (input === "G") {
        setCursor(last);
      } else if (key.pageDown) {
        setCursor((c) => Math.min(last, c + pageSize));
      } else if (key.pageUp) {
        setCursor((c) => Math.max(0, c - pageSize));
      } else if (key.return && filteredCount > 0) {
        const item = filteredItems[safeCursor];
        if (item !== undefined) props.onSelect(item.id);
      }
    },
    { isActive: props.isActive },
  );

  const buildHeader = (): string => {
    const titlePrefix = props.title !== undefined ? `${props.title}  ` : "";
    const position = filteredCount > 0 ? `${safeCursor + 1}/${filteredCount}` : `0/${totalCount}`;
    if (filterMode) {
      return `${titlePrefix}/ ${toSingleLineDisplay(filterQuery)}  ${position}`;
    }
    return `${titlePrefix}${position}`;
  };

  // Empty state — items list is empty (filter mode not entered for empty lists).
  if (totalCount === 0) {
    return (
      <Box flexDirection="column">
        {props.emptyText !== undefined ? (
          <Box justifyContent="center">
            <Text>{props.emptyText}</Text>
          </Box>
        ) : (
          <Box />
        )}
      </Box>
    );
  }

  // Filter active but no matches.
  if (filteredCount === 0) {
    return (
      <Box flexDirection="column">
        <Text>{buildHeader()}</Text>
        <Text>no matches</Text>
      </Box>
    );
  }

  const scrollWindow = computeScrollWindow({
    total: filteredCount,
    viewport: listHeight,
    cursor: safeCursor,
    offset: 0,
    follow: false,
  });

  const visibleItems = filteredItems.slice(scrollWindow.start, scrollWindow.end);
  const overflowCount = filteredCount - scrollWindow.end;

  return (
    <Box flexDirection="column">
      <Text>{buildHeader()}</Text>
      {visibleItems.map((item, i) => {
        const isSelected = scrollWindow.start + i === safeCursor;
        const displayLabel = toSingleLineDisplay(item.label);
        const displayHint = item.hint !== undefined ? toSingleLineDisplay(item.hint) : undefined;
        const line = `${isSelected ? SELECTION_PREFIX : PLAIN_PREFIX}${displayLabel}${
          displayHint !== undefined ? `  ${displayHint}` : ""
        }`;
        return (
          <Text key={item.id} inverse={isSelected}>
            {line}
          </Text>
        );
      })}
      {overflowCount > 0 && <Text>↓ {overflowCount} more</Text>}
    </Box>
  );
}
