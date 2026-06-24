import React from "react";
import { MemoryRouter } from "react-router";

import { InputCaptureProvider } from "./components/InputCaptureProvider.js";
import { AppRouter, type CouncilTUIProps } from "./router/AppRouter.js";
import { ROUTES } from "./router/routes.js";

export type { CouncilTUIProps };

export function CouncilTUI(props: CouncilTUIProps): React.ReactElement {
  const initialRoute = props.isFirstRun === true ? ROUTES.onboarding : ROUTES.home;
  return (
    <InputCaptureProvider>
      <MemoryRouter initialEntries={[initialRoute]}>
        <AppRouter {...props} />
      </MemoryRouter>
    </InputCaptureProvider>
  );
}
