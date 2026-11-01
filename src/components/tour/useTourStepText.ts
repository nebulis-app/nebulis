import { useTranslation } from 'react-i18next';
import type { TourStep } from './steps';

/** The words of a step, from the `tour` namespace. `hint` is empty when a step has none. */
export function useTourStepText(): (step: TourStep) => { title: string; body: string; hint: string } {
  const { t } = useTranslation('tour');
  return step => ({
    title: t(`steps.${step.id}.title`),
    body: t(`steps.${step.id}.body`),
    hint: t(`steps.${step.id}.hint`, { defaultValue: '' }),
  });
}
