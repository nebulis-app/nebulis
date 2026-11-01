import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import * as auth from '../../server/lib/authSchemas';
import * as gear from '../../server/lib/gearSchemas';
import * as journal from '../../server/lib/journalSchemas';
import * as notes from '../../server/lib/noteSchemas';
import * as sites from '../../server/lib/observingSiteSchemas';
import * as settings from '../../server/lib/settingsSchemas';
import * as importSchemas from '../../server/lib/library/importSchemas';
import * as telescopes from '../../server/lib/telescopeSchemas';

/**
 * These schemas are the only guard between a request body and a database write,
 * so they are asserted directly: what they accept, what they reject, and where
 * the boundary sits. (Routes only ever feed them the happy path.)
 */

interface Parsable { safeParse(value: unknown): { success: boolean } }
const isSchema = (v: unknown): v is Parsable => typeof v === 'object' && v !== null && typeof (v as Parsable).safeParse === 'function';

const modules = { auth, gear, journal, notes, sites, settings, importSchemas, telescopes };
const REQUEST_SCHEMA_NAME = /(Body|Create|Patch)Schema$|^(Kit|Check)Schema$/;

const requestSchemas = Object.entries(modules).flatMap(([moduleName, mod]) =>
  Object.entries(mod as Record<string, unknown>)
    .filter(([name, value]) => REQUEST_SCHEMA_NAME.test(name) && isSchema(value))
    .map(([name, value]) => [`${moduleName}.${name}`, value as Parsable] as const),
);

describe('request schemas, every one', () => {
  it('finds the request schemas it is meant to cover', () => {
    expect(requestSchemas.length).toBeGreaterThanOrEqual(15);
  });

  it.each(requestSchemas)('%s rejects a body that is not an object', (_name, schema) => {
    for (const junk of [null, undefined, 'text', 42, true, []]) {
      expect(schema.safeParse(junk).success, `accepted ${JSON.stringify(junk)}`).toBe(false);
    }
  });
});

describe('auth bodies', () => {
  const valid = { username: 'claude', password: 'tester1' };

  it('accepts a minimal registration and keeps the optional fields optional', () => {
    expect(auth.AuthRegisterBodySchema.safeParse(valid).success).toBe(true);
    expect(auth.AuthRegisterBodySchema.safeParse({ ...valid, displayName: 'C', email: 'c@example.test' }).success).toBe(true);
  });

  it('puts the username floor at 3 and the password floor at 6 characters, for both register and create-user', () => {
    for (const schema of [auth.AuthRegisterBodySchema, auth.AuthCreateUserBodySchema]) {
      expect(schema.safeParse({ ...valid, username: 'ab' }).success).toBe(false);
      expect(schema.safeParse({ ...valid, username: 'abc' }).success).toBe(true);
      expect(schema.safeParse({ ...valid, password: '12345' }).success).toBe(false);
      expect(schema.safeParse({ ...valid, password: '123456' }).success).toBe(true);
    }
  });

  it('rejects a missing field and a wrong type', () => {
    expect(auth.AuthRegisterBodySchema.safeParse({ username: 'claude' }).success).toBe(false);
    expect(auth.AuthRegisterBodySchema.safeParse({ password: 'tester1' }).success).toBe(false);
    expect(auth.AuthRegisterBodySchema.safeParse({ ...valid, password: 123456 }).success).toBe(false);
  });

  it('login needs both fields non-empty', () => {
    expect(auth.AuthLoginBodySchema.safeParse(valid).success).toBe(true);
    expect(auth.AuthLoginBodySchema.safeParse({ username: '', password: 'x' }).success).toBe(false);
    expect(auth.AuthLoginBodySchema.safeParse({ username: 'x', password: '' }).success).toBe(false);
  });

  it('only a known role can be assigned, so no role string reaches the database', () => {
    expect(auth.AuthRoleBodySchema.safeParse({ role: 'admin' }).success).toBe(true);
    expect(auth.AuthRoleBodySchema.safeParse({ role: 'viewer' }).success).toBe(true);
    for (const role of ['root', 'ADMIN', '', 'admin ', null, 1]) {
      expect(auth.AuthRoleBodySchema.safeParse({ role }).success, `accepted ${JSON.stringify(role)}`).toBe(false);
    }
    expect(auth.AuthCreateUserBodySchema.safeParse({ ...valid, role: 'superuser' }).success).toBe(false);
  });

  it('the profile email is a real address or empty', () => {
    expect(auth.AuthProfileBodySchema.safeParse({ displayName: 'C' }).success).toBe(true);
    expect(auth.AuthProfileBodySchema.safeParse({ displayName: 'C', email: '' }).success).toBe(true);
    expect(auth.AuthProfileBodySchema.safeParse({ displayName: 'C', email: 'not-an-email' }).success).toBe(false);
    expect(auth.AuthProfileBodySchema.safeParse({ displayName: '' }).success).toBe(false);
  });

  it('password acceptance is exactly "at least 6 characters" for any string', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), password => {
        expect(auth.AuthPasswordBodySchema.safeParse({ password }).success).toBe(password.length >= 6);
      }),
      { numRuns: 300 },
    );
  });

  it('parsing a parsed value changes nothing (idempotent)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 3, maxLength: 20 }), fc.string({ minLength: 6, maxLength: 20 }), (username, password) => {
        const first = auth.AuthRegisterBodySchema.parse({ username, password });
        expect(auth.AuthRegisterBodySchema.parse(first)).toEqual(first);
      }),
      { numRuns: 200 },
    );
  });
});

describe('settings bodies', () => {
  it('a database reset needs the literal word "delete", nothing near it', () => {
    expect(settings.SettingsResetDatabaseBodySchema.safeParse({ confirmation: 'delete' }).success).toBe(true);
    for (const confirmation of ['Delete', 'DELETE', 'delete ', 'yes', '', true, undefined]) {
      expect(settings.SettingsResetDatabaseBodySchema.safeParse({ confirmation }).success, `accepted ${JSON.stringify(confirmation)}`).toBe(false);
    }
    expect(settings.SettingsResetDatabaseBodySchema.safeParse({}).success).toBe(false);
  });

  it('an API key name is optional and at most 50 characters', () => {
    expect(settings.SettingsApiKeyCreateBodySchema.safeParse({}).success).toBe(true);
    expect(settings.SettingsApiKeyCreateBodySchema.safeParse({ name: 'a'.repeat(50) }).success).toBe(true);
    expect(settings.SettingsApiKeyCreateBodySchema.safeParse({ name: 'a'.repeat(51) }).success).toBe(false);
    expect(settings.SettingsApiKeyCreateBodySchema.safeParse({ name: 7 }).success).toBe(false);
  });
});

describe('note bodies', () => {
  it('a note needs an object and a date, both non-empty', () => {
    expect(notes.NoteBodySchema.safeParse({ objectId: 'M31', date: '2026-11-01' }).success).toBe(true);
    expect(notes.NoteBodySchema.safeParse({ objectId: '', date: '2026-11-01' }).success).toBe(false);
    expect(notes.NoteBodySchema.safeParse({ objectId: 'M31', date: '' }).success).toBe(false);
    expect(notes.NoteBodySchema.safeParse({ objectId: 'M31' }).success).toBe(false);
  });

  it('ratings may be null or omitted, but never text', () => {
    const base = { objectId: 'M31', date: '2026-11-01' };
    expect(notes.NoteBodySchema.safeParse({ ...base, seeingRating: null }).success).toBe(true);
    expect(notes.NoteBodySchema.safeParse({ ...base, seeingRating: 4 }).success).toBe(true);
    expect(notes.NoteBodySchema.safeParse({ ...base, seeingRating: 'good' }).success).toBe(false);
  });

  it('an update may carry any subset of the fields, including none', () => {
    expect(notes.NoteUpdateBodySchema.safeParse({}).success).toBe(true);
    expect(notes.NoteUpdateBodySchema.safeParse({ equipment: 'Seestar S50' }).success).toBe(true);
    expect(notes.NoteUpdateBodySchema.safeParse({ equipment: 5 }).success).toBe(false);
  });

  it('an object note takes any string (blank clears it) and nothing else', () => {
    expect(notes.ObjectNoteBodySchema.safeParse({ text: '' }).success).toBe(true);
    expect(notes.ObjectNoteBodySchema.safeParse({ text: 5 }).success).toBe(false);
    expect(notes.ObjectNoteBodySchema.safeParse({}).success).toBe(false);
  });
});
