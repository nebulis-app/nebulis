import { assertNever } from '../../lib/utils';

export const TOTAL_STEPS = 4;

export type StepNumber = 1 | 2 | 3 | 4;

export interface StepState {
  step: StepNumber;
  pendingDir: 1 | -1 | 0; // direction to apply when transition lands
  transitioning: boolean;
}

export type StepAction =
  | { type: 'BEGIN_FORWARD' }
  | { type: 'BEGIN_BACK' }
  | { type: 'COMMIT' };

export const initialStepState: StepState = {
  step: 1,
  pendingDir: 0,
  transitioning: false,
};

export function stepReducer(state: StepState, action: StepAction): StepState {
  switch (action.type) {
    case 'BEGIN_FORWARD': {
      if (state.step >= TOTAL_STEPS || state.transitioning) return state;
      return { ...state, transitioning: true, pendingDir: 1 };
    }
    case 'BEGIN_BACK': {
      if (state.step <= 1 || state.transitioning) return state;
      return { ...state, transitioning: true, pendingDir: -1 };
    }
    case 'COMMIT': {
      if (!state.transitioning) return state;
      const next = (state.step + state.pendingDir) as StepNumber;
      const clamped = (Math.max(1, Math.min(TOTAL_STEPS, next))) as StepNumber;
      return { step: clamped, pendingDir: 0, transitioning: false };
    }
    default:
      return assertNever(action);
  }
}
