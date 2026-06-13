import { describe, it, expect } from 'vitest';
import {
  stepReducer,
  initialStepState,
  TOTAL_STEPS,
  type StepState,
} from '../../src/components/onboarding/stepReducer';

describe('stepReducer', () => {
  describe('BEGIN_FORWARD', () => {
    it('arms a forward transition from a non-transitioning state', () => {
      const next = stepReducer(initialStepState, { type: 'BEGIN_FORWARD' });
      expect(next).toEqual({ step: 1, pendingDir: 1, transitioning: true });
    });

    it('is a no-op when already at the last step', () => {
      const last: StepState = { step: TOTAL_STEPS, pendingDir: 0, transitioning: false };
      expect(stepReducer(last, { type: 'BEGIN_FORWARD' })).toBe(last);
    });

    it('is a no-op while a transition is already in flight', () => {
      const mid: StepState = { step: 2, pendingDir: 1, transitioning: true };
      expect(stepReducer(mid, { type: 'BEGIN_FORWARD' })).toBe(mid);
    });
  });

  describe('BEGIN_BACK', () => {
    it('arms a backward transition when not on step 1', () => {
      const s: StepState = { step: 3, pendingDir: 0, transitioning: false };
      const next = stepReducer(s, { type: 'BEGIN_BACK' });
      expect(next).toEqual({ step: 3, pendingDir: -1, transitioning: true });
    });

    it('is a no-op on step 1', () => {
      expect(stepReducer(initialStepState, { type: 'BEGIN_BACK' })).toBe(initialStepState);
    });

    it('is a no-op while a transition is already in flight', () => {
      const mid: StepState = { step: 2, pendingDir: -1, transitioning: true };
      expect(stepReducer(mid, { type: 'BEGIN_BACK' })).toBe(mid);
    });
  });

  describe('COMMIT', () => {
    it('advances the step in the pending direction and clears the transition', () => {
      const armed: StepState = { step: 1, pendingDir: 1, transitioning: true };
      expect(stepReducer(armed, { type: 'COMMIT' })).toEqual({
        step: 2,
        pendingDir: 0,
        transitioning: false,
      });
    });

    it('rewinds the step when pendingDir is -1', () => {
      const armed: StepState = { step: 3, pendingDir: -1, transitioning: true };
      expect(stepReducer(armed, { type: 'COMMIT' })).toEqual({
        step: 2,
        pendingDir: 0,
        transitioning: false,
      });
    });

    it('clamps to TOTAL_STEPS rather than overflowing', () => {
      const armed: StepState = { step: TOTAL_STEPS, pendingDir: 1, transitioning: true };
      const next = stepReducer(armed, { type: 'COMMIT' });
      expect(next.step).toBe(TOTAL_STEPS);
    });

    it('clamps to 1 rather than underflowing', () => {
      const armed: StepState = { step: 1, pendingDir: -1, transitioning: true };
      const next = stepReducer(armed, { type: 'COMMIT' });
      expect(next.step).toBe(1);
    });

    it('is a no-op when not transitioning', () => {
      expect(stepReducer(initialStepState, { type: 'COMMIT' })).toBe(initialStepState);
    });
  });

  describe('full forward / back walk', () => {
    function go(state: StepState, type: 'BEGIN_FORWARD' | 'BEGIN_BACK'): StepState {
      const armed = stepReducer(state, { type });
      return stepReducer(armed, { type: 'COMMIT' });
    }

    it('walks 1 → 2 → 3 → 4 → 4 (clamped)', () => {
      let s = initialStepState;
      s = go(s, 'BEGIN_FORWARD'); expect(s.step).toBe(2);
      s = go(s, 'BEGIN_FORWARD'); expect(s.step).toBe(3);
      s = go(s, 'BEGIN_FORWARD'); expect(s.step).toBe(4);
      s = go(s, 'BEGIN_FORWARD'); expect(s.step).toBe(4); // no-op at last
    });

    it('walks back 4 → 3 → 2 → 1 → 1 (clamped)', () => {
      let s: StepState = { step: 4, pendingDir: 0, transitioning: false };
      s = go(s, 'BEGIN_BACK'); expect(s.step).toBe(3);
      s = go(s, 'BEGIN_BACK'); expect(s.step).toBe(2);
      s = go(s, 'BEGIN_BACK'); expect(s.step).toBe(1);
      s = go(s, 'BEGIN_BACK'); expect(s.step).toBe(1); // no-op at first
    });
  });
});
