import React from "react";

import { useListSelection } from "../../hooks/use-list-selection.js";
import { ScrollView } from "./ScrollView.js";

export interface SelectableListProps {
  readonly items: readonly string[];
  readonly isActive?: boolean;
  readonly onActivate?: (index: number) => void;
  readonly height?: number;
}

export function SelectableList(props: SelectableListProps): React.ReactElement {
  const { cursor } = useListSelection({
    count: props.items.length,
    ...(props.isActive === undefined ? {} : { isActive: props.isActive }),
    ...(props.onActivate === undefined ? {} : { onActivate: props.onActivate }),
  });
  return <ScrollView items={props.items} height={props.height ?? props.items.length} cursor={cursor} />;
}
