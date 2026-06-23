import React from "react";
import { MemoryRouter } from "react-router";

import { AppRouter, type CouncilTUIProps } from "./router/AppRouter.js";
import { ROUTES } from "./router/routes.js";

export type { CouncilTUIProps };

export function CouncilTUI(props: CouncilTUIProps): React.ReactElement {
  return (
    <MemoryRouter initialEntries={[ROUTES.home]}>
      <AppRouter {...props} />
    </MemoryRouter>
  );
}
