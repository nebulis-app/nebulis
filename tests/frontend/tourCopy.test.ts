import { describe, it, expect } from 'vitest';
import en from '../../src/locales/en/tour.json';
import { ALL_TOUR_STEPS } from '../../src/components/tour/steps';

describe('tour copy', () => {
  const copy = en.steps as Record<string, { title?: string; body?: string; hint?: string }>;

  it('has a title and a body in tour.json for every step', () => {
    for (const step of ALL_TOUR_STEPS) {
      expect(copy[step.id]?.title, `${step.id} title`).toBeTruthy();
      expect(copy[step.id]?.body, `${step.id} body`).toBeTruthy();
    }
  });

  it('has no copy for a step that no longer exists', () => {
    expect(Object.keys(copy).sort()).toEqual(ALL_TOUR_STEPS.map(s => s.id).sort());
  });

  it("does not tell the reader to tap a button the welcome card does not have", () => {
    expect(copy.welcome?.hint).not.toMatch(/tap next/i);
  });
});
