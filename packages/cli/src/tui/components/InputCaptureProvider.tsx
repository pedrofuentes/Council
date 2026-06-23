import React from "react";

export interface InputCapture {
  readonly captured: boolean;
  readonly setCaptured: (v: boolean) => void;
}

const DEFAULT_INPUT_CAPTURE: InputCapture = {
  captured: false,
  setCaptured: () => undefined,
};

const InputCaptureContext = React.createContext<InputCapture | null>(null);

export function InputCaptureProvider(props: {
  readonly children: React.ReactNode;
}): React.ReactElement {
  const [captured, setCaptured] = React.useState(false);
  const value = React.useMemo<InputCapture>(() => ({ captured, setCaptured }), [captured]);

  return (
    <InputCaptureContext.Provider value={value}>{props.children}</InputCaptureContext.Provider>
  );
}

export function useInputCapture(): InputCapture {
  return React.useContext(InputCaptureContext) ?? DEFAULT_INPUT_CAPTURE;
}
