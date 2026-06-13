import type { ReactNode } from 'react';
import { Sparkles, RotateCw, ChevronRight, ChevronLeft, CheckCircle2 } from 'lucide-react';
import { TOTAL_STEPS, type StepNumber } from './stepReducer';
import { Modal } from '../ui/Modal';

export interface OnboardingChromeProps {
  step: StepNumber;
  transitioning: boolean;
  isDark: boolean;
  subText: string;
  step2Disabled: boolean;
  isCreatingUser: boolean;
  isFinishing: boolean;
  onSkip: () => void;
  onBack: () => void;
  onContinue: () => void;
  onFinish: () => void;
  onSubmitStep1: () => void;
  children: ReactNode;
}

export function OnboardingChrome({
  step,
  transitioning,
  isDark,
  subText,
  step2Disabled,
  isCreatingUser,
  isFinishing,
  onSkip,
  onBack,
  onContinue,
  onFinish,
  onSubmitStep1,
  children,
}: OnboardingChromeProps) {
  const card = isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
  const ghostBtn = isDark
    ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100';
  const primaryBtn = 'inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50';
  const backBtn = `inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium transition ${ghostBtn}`;

  return (
    <Modal
      isOpen
      onClose={onSkip}
      title="Telescope Setup"
      className={`w-full max-w-lg rounded-2xl border shadow-2xl overflow-hidden ${card}`}
    >

        {/* Header */}
        <div className={`flex items-center justify-between px-6 py-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${isDark ? 'bg-accent-500/10' : 'bg-accent-50'}`}>
              <Sparkles className="w-5 h-5 text-accent-500" />
            </div>
            <div>
              <h2 className={`font-display font-semibold text-lg ${isDark ? 'text-white' : 'text-slate-900'}`}>
                Set up your library in 4 steps
              </h2>
              <p className={`text-xs ${subText}`}>Step {step} of {TOTAL_STEPS}</p>
            </div>
          </div>
          <button
            onClick={onSkip}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg transition ${
              isDark ? 'text-slate-500 hover:text-slate-300 hover:bg-slate-800' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
            }`}
          >
            Set up later
          </button>
        </div>

        {/* Progress bar */}
        <div className={`h-1 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
          <div
            className="h-full bg-accent-500 transition-all duration-300 ease-out"
            style={{ width: `${(step / TOTAL_STEPS) * 100}%` }}
          />
        </div>

        {/* Content */}
        <div
          className={`p-6 space-y-5 transition-opacity duration-150 ${transitioning ? 'opacity-0' : 'opacity-100'}`}
          style={{ minHeight: 340 }}
        >
          {children}
        </div>

        {/* Footer */}
        <div className={`flex items-center justify-between px-6 py-4 border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <div>
            {step > 1 && step < 4 && (
              <button onClick={onBack} className={backBtn}>
                <ChevronLeft className="w-4 h-4" />
                Back
              </button>
            )}
          </div>
          <div>
            {step === 1 && (
              <button onClick={onSubmitStep1} disabled={isCreatingUser} className={primaryBtn}>
                {isCreatingUser ? (
                  <><RotateCw className="w-4 h-4 animate-spin" /> Creating...</>
                ) : (
                  <>Continue <ChevronRight className="w-4 h-4" /></>
                )}
              </button>
            )}
            {step === 2 && (
              <button
                onClick={onContinue}
                disabled={step2Disabled}
                className={`${primaryBtn} disabled:cursor-not-allowed`}
              >
                Continue <ChevronRight className="w-4 h-4" />
              </button>
            )}
            {step === 3 && (
              <button onClick={onContinue} className={primaryBtn}>
                Continue <ChevronRight className="w-4 h-4" />
              </button>
            )}
            {step === 4 && (
              <div className="flex items-center gap-3">
                <button onClick={onBack} className={backBtn}>
                  <ChevronLeft className="w-4 h-4" />
                  Back
                </button>
                <button onClick={onFinish} disabled={isFinishing} className={primaryBtn}>
                  {isFinishing ? (
                    <><RotateCw className="w-4 h-4 animate-spin" /> Saving...</>
                  ) : (
                    <><CheckCircle2 className="w-4 h-4" /> Finish Setup</>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
    </Modal>
  );
}
