import React from "react";
import { MemoryRouter } from "react-router";

import { InputCaptureProvider } from "./components/InputCaptureProvider.js";
import { AppRouter, type CouncilTUIProps } from "./router/AppRouter.js";
import { ROUTES } from "./router/routes.js";

export type { CouncilTUIProps };

export function CouncilTUI(props: CouncilTUIProps): React.ReactElement {
  return (
    <InputCaptureProvider>
      <MemoryRouter initialEntries={[ROUTES.home]}>
        <AppRouter {...props} />
      </MemoryRouter>
    </InputCaptureProvider>
  );
}
