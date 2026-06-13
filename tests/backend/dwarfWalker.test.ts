import { describe, it, expect } from 'vitest';
import {
  isDwarfSessionFolder,
  extractTargetFromSessionFolder,
  extractDateFromSessionFolder,
  extractTimestampFromSessionFolder,
} from '../../server/lib/walkers/dwarfWalker';

describe('isDwarfSessionFolder', () => {
  it('recognizes Dwarf 3 folders', () => {
    expect(isDwarfSessionFolder('DWARF3_RAW_M42_EXP_30_GAIN_80_2024-10-15_21-05-30-345')).toBe(true);
  });

  it('recognizes Dwarf II folders', () => {
    expect(isDwarfSessionFolder('DWARF_RAW_NGC7000_2024-10-15_21-05-30')).toBe(true);
  });

  it('recognizes Dwarf II USB folders with TELE_ prefix', () => {
    expect(isDwarfSessionFolder('DWARF_RAW_TELE_HD 279230_EXP_15_GAIN_60_2026-04-03-22-17-07-163')).toBe(true);
  });

  it('recognizes Dwarf II USB folders with WIDE_ prefix', () => {
    expect(isDwarfSessionFolder('DWARF_RAW_WIDE_M31_EXP_30_GAIN_80_2026-04-03-22-17-07-163')).toBe(true);
  });

  it('rejects unrelated folders', () => {
    expect(isDwarfSessionFolder('Astronomy')).toBe(false);
    expect(isDwarfSessionFolder('DCIM')).toBe(false);
    expect(isDwarfSessionFolder('M42')).toBe(false);
  });
});

describe('extractTargetFromSessionFolder', () => {
  it('extracts target from a Dwarf 3 folder', () => {
    expect(extractTargetFromSessionFolder('DWARF3_RAW_M42_EXP_30_GAIN_80_2024-10-15_21-05-30-345')).toBe('M42');
  });

  it('extracts target from a Dwarf II folder without EXP token', () => {
    expect(extractTargetFromSessionFolder('DWARF_RAW_NGC7000_2024-10-15_21-05-30')).toBe('NGC7000');
  });

  it('extracts target from a Dwarf II USB folder with TELE_ prefix', () => {
    expect(extractTargetFromSessionFolder(
      'DWARF_RAW_TELE_HD 279230_EXP_15_GAIN_60_2026-04-03-22-17-07-163',
    )).toBe('HD 279230');
  });

  it('extracts target from a Dwarf II USB folder with WIDE_ prefix', () => {
    expect(extractTargetFromSessionFolder(
      'DWARF_RAW_WIDE_M31_EXP_30_GAIN_80_2026-04-03-22-17-07-163',
    )).toBe('M31');
  });

  it('converts underscores in target to spaces', () => {
    expect(extractTargetFromSessionFolder(
      'DWARF3_RAW_NGC_7000_EXP_30_GAIN_80_2024-10-15_21-05-30-345',
    )).toBe('NGC 7000');
  });

  it('returns null for an unrecognized folder name', () => {
    expect(extractTargetFromSessionFolder('Astronomy')).toBeNull();
    expect(extractTargetFromSessionFolder('DCIM')).toBeNull();
  });
});

describe('extractDateFromSessionFolder', () => {
  it('extracts date from a Dwarf 3 folder', () => {
    expect(extractDateFromSessionFolder('DWARF3_RAW_M42_EXP_30_GAIN_80_2024-10-15_21-05-30-345')).toBe('2024-10-15');
  });

  it('extracts date from a Dwarf II USB folder', () => {
    expect(extractDateFromSessionFolder(
      'DWARF_RAW_TELE_HD 279230_EXP_15_GAIN_60_2026-04-03-22-17-07-163',
    )).toBe('2026-04-03');
  });

  it('returns null for a folder with no date-like token', () => {
    expect(extractDateFromSessionFolder('DCIM')).toBeNull();
  });
});

describe('extractTimestampFromSessionFolder', () => {
  it('extracts timestamp from a Dwarf 3 folder', () => {
    expect(extractTimestampFromSessionFolder(
      'DWARF3_RAW_M42_EXP_30_GAIN_80_2024-10-15_21-05-30-345',
    )).toBe('2024-10-15_21-05-30-345');
  });

  it('extracts and normalises timestamp from a Dwarf II USB folder', () => {
    // All-dash format is normalised to YYYY-MM-DD_HH-MM-SS-mmm so it matches
    // the DWARF3_ filename pattern that parseFilename expects.
    expect(extractTimestampFromSessionFolder(
      'DWARF_RAW_TELE_HD 279230_EXP_15_GAIN_60_2026-04-03-22-17-07-163',
    )).toBe('2026-04-03_22-17-07-163');
  });
});
