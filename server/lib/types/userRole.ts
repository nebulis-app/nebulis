/** User roles, in a leaf module so server/types/express.d.ts can name the type
 *  without importing auth.ts (which loads the JWT secret at import). */
export const USER_ROLES = ['admin', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];
