import { beforeEach, describe, expect, it } from 'vitest';
import { applyWallOverrides, getWallOverrides, resetWallOverrides } from '../../server/lib/catalogWallOverrides';

describe('catalog wall overrides', () => {
  beforeEach(() => {
    resetWallOverrides('messier');
    resetWallOverrides('caldwell');
  });

  it('round-trips span, image and focus', () => {
    applyWallOverrides('messier', {
      M31: { span: { cols: 3, rows: 2 }, imagePath: 'M31/processed/a.jpg', focus: { x: 0.25, y: 0.75 } },
    }, []);
    expect(getWallOverrides('messier')).toEqual({
      M31: { span: { cols: 3, rows: 2 }, imagePath: 'M31/processed/a.jpg', focus: { x: 0.25, y: 0.75 } },
    });
  });

  it('round-trips a zoomed crop and clears it when dropped', () => {
    applyWallOverrides('messier', { M13: { focus: { x: 0.3, y: 0.6 }, zoom: 2.5 } }, []);
    expect(getWallOverrides('messier').M13).toEqual({ focus: { x: 0.3, y: 0.6 }, zoom: 2.5 });
    applyWallOverrides('messier', { M13: { span: { cols: 2, rows: 1 } } }, []);
    expect(getWallOverrides('messier').M13).toEqual({ span: { cols: 2, rows: 1 } });
  });

  it('keeps each catalog separate', () => {
    applyWallOverrides('messier', { M42: { span: { cols: 4, rows: 4 } } }, []);
    applyWallOverrides('caldwell', { M42: { span: { cols: 1, rows: 1 } } }, []);
    expect(getWallOverrides('messier').M42.span).toEqual({ cols: 4, rows: 4 });
    expect(getWallOverrides('caldwell').M42.span).toEqual({ cols: 1, rows: 1 });
  });

  it('replaces a tile wholesale, so dropping a field clears it', () => {
    applyWallOverrides('messier', { M13: { span: { cols: 2, rows: 2 }, focus: { x: 0.1, y: 0.1 } } }, []);
    applyWallOverrides('messier', { M13: { span: { cols: 2, rows: 2 } } }, []);
    expect(getWallOverrides('messier').M13).toEqual({ span: { cols: 2, rows: 2 } });
  });

  it('removes a tile via clear, or when its override is empty', () => {
    applyWallOverrides('messier', { M1: { span: { cols: 2, rows: 1 } }, M2: { span: { cols: 1, rows: 2 } } }, []);
    applyWallOverrides('messier', { M2: {} }, ['M1']);
    expect(getWallOverrides('messier')).toEqual({});
  });

  it('resets only the requested catalog', () => {
    applyWallOverrides('messier', { M1: { span: { cols: 2, rows: 1 } } }, []);
    applyWallOverrides('caldwell', { C1: { span: { cols: 2, rows: 1 } } }, []);
    resetWallOverrides('messier');
    expect(getWallOverrides('messier')).toEqual({});
    expect(Object.keys(getWallOverrides('caldwell'))).toEqual(['C1']);
  });
});
