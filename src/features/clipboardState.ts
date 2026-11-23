// What Copy last put aside. It lasts for the session only.

export type Clip =
  | { kind: 'selection'; pixels: Uint8Array; width: number; height: number }
  /** A whole drawing, kept in storage under an id no layer refers to. */
  | { kind: 'cel'; id: number };

export const clipboard: { clip: Clip | null } = { clip: null };

/** Filled in by the lasso module so other modules can reach the floating selection. */
export const selection = {
  exists: (): boolean => false,
  copy: (): void => {},
  paste: (_pixels: Uint8Array, _width: number, _height: number): void => {},
};
