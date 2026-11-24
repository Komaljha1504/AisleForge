import type { Principal } from '@aisleforge/domain';
import type { Logger } from '@aisleforge/shared';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
      correlationId: string;
      log: Logger;
      principal?: Principal;
    }
  }
}

export {};
