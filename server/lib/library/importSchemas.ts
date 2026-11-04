// Request shape for POST /library/import, here so the published spec is
// generated from the schema the handler validates with.

import { z } from 'zod';

export const ImportBodySchema = z.object({
  objectId: z.string().optional().describe('Import only this object'),
  telescopeId: z.string().optional().describe('Import from this telescope only'),
  all: z.boolean().optional().describe('Import from every telescope'),
});
