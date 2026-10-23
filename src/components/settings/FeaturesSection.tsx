import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import type { Settings as SettingsType } from '../../types';
import { Sec, Row, Toggle } from './SettingsUI';

interface Props {
  isDark: boolean;
  form: Partial<SettingsType>;
  setForm: React.Dispatch<React.SetStateAction<Partial<SettingsType>>>;
  /** Jumps to Account → API keys. */
  onOpenApiKeys: () => void;
}

/** Opt-in integrations. Each one is off until an admin turns it on here. */
export function FeaturesSection({ isDark, form, setForm, onOpenApiKeys }: Props) {
  const { t } = useTranslation('settings');
  const [copied, setCopied] = useState(false);
  const enabled = form.pixinsightEnabled ?? false;
  const repoUrl = `${window.location.origin}/plugins/pixinsight/`;

  const copyUrl = () => {
    void navigator.clipboard.writeText(repoUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* clipboard blocked: the URL is still selectable */ });
  };

  return (
    <Sec
      title={t('featuresSection.title')}
      description={t('featuresSection.description')}
      isDark={isDark}
    >
      <Row
        label={t('featuresSection.pixinsight.label')}
        description={t('featuresSection.pixinsight.description')}
        badge={t('softwareUpdate.channel.beta')}
        isDark={isDark}
      >
        <Toggle
          checked={enabled}
          onChange={v => setForm(f => ({ ...f, pixinsightEnabled: v }))}
          label={t('featuresSection.pixinsight.label')}
        />
      </Row>
      {enabled && (
        <Row
          label={t('featuresSection.pixinsight.repoLabel')}
          description={t('featuresSection.pixinsight.repoDescription')}
          isDark={isDark}
        >
          <div className="flex items-center gap-2 min-w-0">
            <code className={`text-xs px-2 py-1.5 rounded-md font-mono truncate ${isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-700'}`}>
              {repoUrl}
            </code>
            <button
              type="button"
              onClick={copyUrl}
              aria-label={t('featuresSection.pixinsight.copy')}
              className={`shrink-0 p-1.5 rounded-md transition-colors ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </Row>
      )}
      {enabled && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
          <p className="text-xs text-slate-500">{t('featuresSection.pixinsight.setup')}</p>
          <button
            type="button"
            onClick={onOpenApiKeys}
            className={`text-xs font-medium ${isDark ? 'text-accent-400 hover:text-accent-300' : 'text-accent-700 hover:text-accent-600'}`}
          >
            {t('featuresSection.pixinsight.createKey')}
          </button>
        </div>
      )}
    </Sec>
  );
}
