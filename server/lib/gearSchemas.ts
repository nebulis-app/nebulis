// Request and response shapes for the gear routes. They live here so
// server/routes/openapi.ts generates the published spec from the schemas the
// handlers validate with (see telescopeSchemas.ts for the pattern).

import { z } from 'zod';
import { GEAR_KINDS, MAX_EXTRA_ITEMS, MAX_KIT_ITEMS, type GearItem, type GearKit } from './gear.js';

const text = (max: number) => z.string().max(max);

export const ItemCreateSchema = z.object({
  kind: z.enum(GEAR_KINDS),
  name: z.string().min(1).max(120),
  brand: text(80).optional(),
  model: text(80).optional(),
  specs: z.record(z.string(), z.unknown()).optional(),
  telescopeId: z.string().nullable().optional(),
  notes: text(2000).optional(),
});
export const ItemPatchSchema = ItemCreateSchema.partial();

export const KitSchema = z.object({
  name: z.string().min(1).max(80),
  itemIds: z.array(z.string().min(1).max(100)).max(MAX_KIT_ITEMS).optional(),
  extraItems: z.array(text(100)).max(MAX_EXTRA_ITEMS).optional(),
  siteId: z.string().nullable().optional(),
});
export const KitPatchSchema = KitSchema.partial();

export const CheckSchema = z.object({ itemKey: z.string().min(1).max(200), checked: z.boolean() });

// ─── Response shapes ─────────────────────────────────────────────────
// Held to the lib types: a field added to GearItem or GearKit and missing here
// stops `tsc` (see tests/backend/openapiParity.test.ts for the live check).

export const GearItemResponseSchema = z.object({
  id: z.string(),
  kind: z.enum(GEAR_KINDS),
  name: z.string(),
  brand: z.string(),
  model: z.string(),
  specs: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).describe('Spec values valid for the kind'),
  telescopeId: z.string().nullable(),
  notes: z.string(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const GearKitResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  itemIds: z.array(z.string()).describe('Gear ids and telescope ids'),
  extraItems: z.array(z.string()).describe('Free-text lines such as "red torch"'),
  siteId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type Missing<Type, Schema extends z.ZodType> = Exclude<keyof Type, keyof z.infer<Schema>>;
const gearFieldsDocumented: [Missing<GearItem, typeof GearItemResponseSchema>] extends [never] ? true : never = true;
const kitFieldsDocumented: [Missing<GearKit, typeof GearKitResponseSchema>] extends [never] ? true : never = true;
void [gearFieldsDocumented, kitFieldsDocumented];
