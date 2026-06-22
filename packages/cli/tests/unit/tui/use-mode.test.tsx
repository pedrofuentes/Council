import React, { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";

import {
  modeReducer,
  useMode,
  type Mode,
  type ModeAction,
} from "../../../src/tui/hooks/use-mode.js";

describe("modeReducer", () => {
  it("enters and exits typing mode", () => {
    expect(modeReducer("nav", { type: "enterTyping" })).toBe("typing");
    expect(modeReducer("typing", { type: "exitTyping" })).toBe("nav");
  });

  it("opens the palette from any mode and closes back to nav", () => {
    expect(modeReducer("nav", { type: "openPalette" })).toBe("palette");
    expect(modeReducer("typing", { type: "openPalette" })).toBe("palette");
    expect(modeReducer("palette", { type: "closePalette" })).toBe("nav");
  });

  it("ignores exitTyping when not typing", () => {
    expect(modeReducer("nav", { type: "exitTyping" })).toBe("nav");
  });
});

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

function Harness(props: { readonly initial?: Mode; readonly action?: ModeAction }): React.ReactElement {
  const { mode, dispatch } = useMode(props.initial);
  useEffect(() => {
    if (props.action) dispatch(props.action);
  }, [props.action, dispatch]);
  return <Text>mode:{mode}</Text>;
}

describe("useMode", () => {
  it("defaults to nav mode", () => {
    const { lastFrame, unmount } = render(<Harness />);
    expect(lastFrame()).toContain("mode:nav");
    unmount();
  });

  it("honors the initial mode argument", () => {
    const { lastFrame, unmount } = render(<Harness initial="typing" />);
    expect(lastFrame()).toContain("mode:typing");
    unmount();
  });

  it("transitions mode when dispatch is called", async () => {
    const { lastFrame, unmount } = render(<Harness action={{ type: "openPalette" }} />);
    await flush();
    expect(lastFrame()).toContain("mode:palette");
    unmount();
  });
});
