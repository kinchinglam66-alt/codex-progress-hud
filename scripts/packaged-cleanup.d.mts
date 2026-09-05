export type PackagedCleanupOptions = {
  connect: () => Promise<unknown>;
  open: () => Promise<unknown>;
  work: (close: () => Promise<void>) => Promise<unknown>;
  close: () => Promise<void>;
  emergencyClose?: () => Promise<void>;
  release: () => Promise<void>;
  cleanup: () => Promise<void>;
  reportCleanupError?: (error: unknown, context: string) => void;
};

export function runPackagedCleanup(options: PackagedCleanupOptions): Promise<unknown>;
export function assertToolSuccess(
  result: { isError?: boolean; structuredContent?: { ok?: boolean; observedState?: string } },
  name: string
): void;
export function assertHudCloseStopped(
  result: { isError?: boolean; structuredContent?: { ok?: boolean; observedState?: string } },
  context: string
): void;
export function removeTemporaryDirectory(
  path: string,
  remove?: (path: string, options: { recursive: true; force: true }) => Promise<void>
): Promise<void>;
