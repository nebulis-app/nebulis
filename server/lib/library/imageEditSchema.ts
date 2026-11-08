import { z } from 'zod';
import { geometryEditSchema } from '../annotate/geometryEditSchema.js';

const adjustment = z.number().min(-100).max(100);

/**
 * The image editor's save, as the server receives it: which picture, what was done to it, and where the result goes.
 * The browser never sends the picture itself, only these parameters and (separately) a small text overlay.
 */
export const imageEditRequestSchema = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('telescope'), path: z.string().min(1).max(1024) }),
    z.object({ kind: z.literal('processed'), id: z.string().min(1).max(128) }),
  ]),
  edit: geometryEditSchema.default({}),
  adjust: z.object({
    brightness: adjustment.default(0),
    contrast: adjustment.default(0),
    saturation: adjustment.default(0),
  }).default({ brightness: 0, contrast: 0, saturation: 0 }),
  /** Name for the result, without an extension. Empty keeps the source's name. */
  title: z.string().max(200).default(''),
  save: z.discriminatedUnion('mode', [
    /** Replace the source in place. The first original is kept (library pictures) and can be restored. */
    z.object({ mode: z.literal('overwrite'), confirmLinked: z.boolean().optional() }),
    /** Add a new picture. `target` says whether it joins the night's telescope images or the processed images. */
    z.object({
      mode: z.literal('new'),
      target: z.enum(['library', 'processed']),
      objectId: z.string().min(1).max(256),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    }),
  ]),
});

export type ImageEditRequest = z.infer<typeof imageEditRequestSchema>;
