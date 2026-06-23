import React from "react";
import { useInput } from "ink";

import { toSingleLineDisplay } from "../../../cli/strip-control-chars.js";
import { useListSelection } from "../../hooks/use-list-selection.js";
import { ScrollView } from "./ScrollView.js";

export interface MultiSelectItem {
  readonly value: string;
  readonly label: string;
}

export interface MultiSelectListProps {
  readonly items: readonly MultiSelectItem[];
  readonly selected: readonly string[];
  readonly isActive?: boolean;
  readonly height?: number;
  readonly onChange?: (selected: readonly string[]) => void;
  readonly onSubmit?: (selected: readonly string[]) => void;
}

export function MultiSelectList(props: MultiSelectListProps): React.ReactElement {
  const { cursor } = useListSelection({
    count: props.items.length,
    ...(props.isActive === undefined ? {} : { isActive: props.isActive }),
    onActivate: () => props.onSubmit?.(props.selected),
  });

  useInput(
    (input) => {
      if (input !== " " || props.items.length === 0) return;

      const item = props.items[cursor];
      if (item === undefined) return;

      const next = props.selected.includes(item.value)
        ? props.selected.filter((value) => value !== item.value)
        : [...props.selected, item.value];
      props.onChange?.(next);
    },
    { isActive: props.isActive ?? false },
  );

  const rows = props.items.map(
    (item) =>
      `${props.selected.includes(item.value) ? "[x]" : "[ ]"} ${toSingleLineDisplay(item.label)}`,
  );

  return <ScrollView items={rows} height={props.height ?? props.items.length} cursor={cursor} />;
}
