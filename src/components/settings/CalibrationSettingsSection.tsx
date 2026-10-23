import { useTranslation } from 'react-i18next';
import type { Settings as SettingsType } from '../../types';
import { Row, getInputClass } from './SettingsUI';

/** Dark/bias validity, shown inside the Calibrations card in the Telescopes pane. */
export function CalibrationValidityRow({
  isDark,
  form,
  setForm,
}: {
  isDark: boolean;
  form: Partial<SettingsType>;
  setForm: React.Dispatch<React.SetStateAction<Partial<SettingsType>>>;
}) {
  const { t } = useTranslation('settings');

  return (
    <Row
        label={t('librarySection.calibration.expiryDays.label')}
        description={t('librarySection.calibration.expiryDays.description')}
        isDark={isDark}
      >
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={1800}
            step={1}
            value={form.calibrationExpiryDays ?? 180}
            onChange={e => {
              const n = parseInt(e.target.value, 10);
              setForm(f => ({ ...f, calibrationExpiryDays: Number.isFinite(n) && n > 0 ? n : 180 }));
            }}
            className={`w-20 ${getInputClass(isDark)}`}
          />
          <span className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            {t('librarySection.calibration.expiryDays.unit')}
          </span>
        </div>
    </Row>
  );
}
