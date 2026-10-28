// Short-lived workbench request; null cancels without changing the caller's selection.
export interface GallerySelection {
  readonly assetIds: readonly string[];
  readonly directoryIds: readonly string[];
}

export type PickGalleryAssets = (request: {
  readonly origin: string;
  readonly assetIds: readonly string[];
  /** Present only for callers that allow complete folders, including descendants. */
  readonly directoryIds?: readonly string[];
  readonly signal: AbortSignal;
}) => Promise<GallerySelection | null>;
