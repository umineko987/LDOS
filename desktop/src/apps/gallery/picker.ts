// Short-lived workbench request; null means cancel, [] means confirm no references.
export type PickGalleryAssets = (request: {
  readonly origin: string;
  readonly assetIds: readonly string[];
  readonly signal: AbortSignal;
}) => Promise<string[] | null>;
