import { assertNever } from '../../lib/utils';

export const TOTAL_STEPS = 4;

export type StepNumber = 1 | 2 | 3 | 4;

function isStepNumber(value: number): value is StepNumber {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

/** Clamp an arbitrary step index into the StepNumber union. Proven at runtime
 *  by isStepNumber rather than asserted, so widening TOTAL_STEPS without
 *  widening StepNumber fails loudly instead of silently lying. */
function toStepNumber(value: number, fallback: StepNumber): StepNumber {
  const clamped = Math.max(1, Math.min(TOTAL_STEPS, Math.round(value)));
  return isStepNumber(clamped) ? clamped : fallback;
}

interface StepState {
  step: StepNumber;
  pendingDir: 1 | -1 | 0; // direction to apply when transition lands
  transitioning: boolean;
}

type StepAction =
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
      const next = state.step + state.pendingDir;
      return { step: toStepNumber(next, state.step), pendingDir: 0, transitioning: false };
    }
    default:
      return assertNever(action);
  }
}
