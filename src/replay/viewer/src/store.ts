import { useEffect, useReducer, useRef } from "preact/hooks";
import type { Call, Mark } from "./model.ts";

export type Tooltip =
  | { kind: "call"; x: number; y: number; call: Call }
  | { kind: "mark"; x: number; y: number; mark: Mark }
  | { kind: "text"; x: number; y: number; text: string };

export interface UiState {
  t: number;
  playing: boolean;
  speed: number;
  selectedCall: string | null;
  focusAgent: string | null;
  fileIndex: number;
  tooltip: Tooltip | null;
  showFinished: boolean;
  /** Bumped to ask the file view to scroll to the selected call's lines. */
  reveal: number;
  /** The code view scrolls to each new edit; scrolling by hand turns it off. */
  follow: boolean;
  /** Code font size in pixels: small sizes show the file from far away. */
  zoom: number;
}

export const ZOOM_LEVELS = [2.5, 3.5, 5, 6.5, 8.5, 10.5, 12.5, 15];

/** A tiny observable store: canvases subscribe directly, components through useStore. */
export class Store {
  private listeners = new Set<() => void>();
  constructor(private current: UiState) {}

  get state() {
    return this.current;
  }

  set(patch: Partial<UiState>) {
    this.current = { ...this.current, ...patch };
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** Re-renders only when the selected value changes. */
export function useStore<T>(store: Store, select: (state: UiState) => T, equal = Object.is): T {
  const [, force] = useReducer((count: number) => count + 1, 0);
  const value = select(store.state);
  const last = useRef(value);
  last.current = value;
  const selector = useRef(select);
  selector.current = select;
  useEffect(
    () =>
      store.subscribe(() => {
        if (!equal(last.current, selector.current(store.state))) force(0);
      }),
    [store],
  );
  return value;
}

/** Coalesces redraws to one per animation frame. */
export function frameScheduler(draw: () => void) {
  let pending = 0;
  return () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      draw();
    });
  };
}
