import { useEffect, useState } from "react";

export type AsyncState<T> =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly data: T }
  | { readonly status: "error"; readonly error: Error };

export function useAsyncResource<T>(loader: () => Promise<T>): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    void loader()
      .then((data) => {
        if (cancelled) return;
        setState({ status: "loaded", data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [loader]);

  return state;
}
