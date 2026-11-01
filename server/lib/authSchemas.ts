/**
 * Request and response shapes for the auth routes. They live here, not in the
 * route file, so server/routes/openapi.ts can generate the published spec from
 * the schemas the handlers validate with (see telescopeSchemas.ts).
 */
import { z } from 'zod';
import { USER_ROLES } from './types/userRole.js';
import type { AuthToken } from './auth.js';

export const AuthRegisterBodySchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters').describe('At least 3 characters'),
  password: z.string().min(6, 'Password must be at least 6 characters').describe('At least 6 characters'),
  displayName: z.string().optional(),
  email: z.string().optional(),
});

export const AuthLoginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const AuthCreateUserBodySchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters').describe('At least 3 characters'),
  password: z.string().min(6, 'Password must be at least 6 characters').describe('At least 6 characters'),
  displayName: z.string().optional(),
  email: z.string().optional(),
  role: z.enum(USER_ROLES).optional().describe('Defaults to viewer'),
});

export const AuthPasswordBodySchema = z.object({
  password: z.string().min(6, 'Password must be at least 6 characters').describe('At least 6 characters'),
});

export const AuthProfileBodySchema = z.object({
  displayName: z.string().min(1),
  email: z.string().email().optional().or(z.literal('')),
});

export const AuthRoleBodySchema = z.object({
  role: z.enum(USER_ROLES),
});

export const AuthTokenUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: z.enum(USER_ROLES),
});

export const AuthTokenSchema = z.object({
  token: z.string(),
  expiresIn: z.string().describe('JWT lifetime, e.g. 30d'),
  user: AuthTokenUserSchema,
});

export const AuthUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string(),
  displayName: z.string(),
  createdAt: z.string(),
  role: z.enum(USER_ROLES),
});

export const AuthStatusSchema = z.object({
  hasUsers: z.boolean(),
  userCount: z.number().int(),
  requiresSetup: z.boolean(),
});

export const AuthUpdatedSchema = z.object({ updated: z.boolean() });

// ─── Compile-time coverage checks ──────────────────────────────────────────

type Missing<Type, Schema extends z.ZodType> = Exclude<keyof Type, keyof z.infer<Schema>>;
const tokenFieldsDocumented: [Missing<AuthToken, typeof AuthTokenSchema>] extends [never] ? true : never = true;
void tokenFieldsDocumented;
