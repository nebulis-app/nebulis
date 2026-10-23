import { useTranslation } from 'react-i18next';
import type { Settings as SettingsType } from '../../types';
import { Sec, Row, Toggle, Seg } from './SettingsUI';
import { FilterAliasesSection } from './FilterAliasesSection';

export type LibraryPane = 'display' | 'organization' | 'processing';

export function LibrarySection({
  isDark,
  form,
  setForm,
  pane,
}: {
  isDark: boolean;
  form: Partial<SettingsType>;
  setForm: React.Dispatch<React.SetStateAction<Partial<SettingsType>>>;
  pane: LibraryPane;
}) {
  const { t } = useTranslation('settings');
  const imageSource = form.galleryImageSource ?? 'sky-survey';

  if (pane === 'organization') {
    return (
      <>
      <Sec title={t('librarySection.organization.title')} isDark={isDark}>
        <Row
          label={t('librarySection.organization.preferCaldwell.label')}
          description={t('librarySection.organization.preferCaldwell.description')}
          isDark={isDark}
        >
          {/* A 2-value enum rendered as a toggle. If PREFERRED_CATALOGS in
             server/lib/types/appSettings.ts ever grows a third value, this
             must become a select — as-is, saving from here would silently
             overwrite that third value back to 'default'. */}
          <Toggle
            checked={(form.preferredCatalog ?? 'default') === 'caldwell'}
            onChange={v => setForm(f => ({ ...f, preferredCatalog: v ? 'caldwell' : 'default' }))}
          />
        </Row>
        <Row
          label={t('librarySection.organization.groupByNight.label')}
          description={t('librarySection.organization.groupByNight.description')}
          isDark={isDark}
        >
          <Toggle
            checked={form.groupObservingNights ?? true}
            onChange={v => setForm(f => ({ ...f, groupObservingNights: v }))}
          />
        </Row>
        <Row
          label={t('librarySection.organization.groupCompanions.label')}
          description={t('librarySection.organization.groupCompanions.description')}
          isDark={isDark}
        >
          <Toggle
            checked={form.groupCatalogCompanions ?? true}
            onChange={v => setForm(f => ({ ...f, groupCatalogCompanions: v }))}
            label={t('librarySection.organization.groupCompanions.label')}
          />
        </Row>
      </Sec>

        <FilterAliasesSection isDark={isDark} />
      </>
    );
  }

  if (pane === 'processing') {
    return (
      <>
      <Sec
        title={t('librarySection.processing.title')}
        description={t('librarySection.processing.description')}
        isDark={isDark}
      >
        <Row
          label={t('librarySection.organization.autoSolve.label')}
          description={t('librarySection.organization.autoSolve.description')}
          isDark={isDark}
        >
          <Toggle
            checked={form.annotateAutoSolve ?? true}
            onChange={v => setForm(f => ({ ...f, annotateAutoSolve: v }))}
            label={t('librarySection.organization.autoSolve.label')}
          />
        </Row>
        <Row
          label={t('librarySection.organization.autoMeasure.label')}
          description={t('librarySection.organization.autoMeasure.description')}
          isDark={isDark}
        >
          <Toggle
            checked={form.autoMeasureFrames ?? false}
            onChange={v => setForm(f => ({ ...f, autoMeasureFrames: v }))}
            label={t('librarySection.organization.autoMeasure.label')}
          />
        </Row>
      </Sec>
      </>
    );
  }

  return (
    <>
      <Sec
        title={t('librarySection.display.title')}
        description={t('librarySection.display.description')}
        isDark={isDark}
      >
        <Row
          label={t('librarySection.display.cardPictures.label')}
          description={t('librarySection.display.cardPictures.description')}
          isDark={isDark}
        >
          <Seg
            isDark={isDark}
            value={imageSource}
            options={[
              { id: 'sky-survey', label: t('librarySection.display.cardPictures.reference') },
              { id: 'telescope', label: t('librarySection.display.cardPictures.telescope') },
            ]}
            onChange={v => setForm(f => ({ ...f, galleryImageSource: v }))}
          />
        </Row>
        <Row
          label={t('librarySection.display.galleryProcessedOnly.label')}
          description={t('librarySection.display.galleryProcessedOnly.description')}
          isDark={isDark}
        >
          <Toggle
            checked={form.galleryProcessedOnlyDefault ?? false}
            onChange={v => setForm(f => ({ ...f, galleryProcessedOnlyDefault: v }))}
          />
        </Row>
        <Row
          label={t('librarySection.display.objectPages.label')}
          description={t('librarySection.display.objectPages.description')}
          isDark={isDark}
        >
          <Seg
            isDark={isDark}
            value={form.objectPageLayout ?? 'media'}
            options={[
              { id: 'nights', label: t('librarySection.display.objectPages.nights') },
              { id: 'media', label: t('librarySection.display.objectPages.media') },
            ]}
            onChange={v => setForm(f => ({ ...f, objectPageLayout: v }))}
          />
        </Row>
        <Row
          label={t('librarySection.display.slideshowShowInfo.label')}
          description={t('librarySection.display.slideshowShowInfo.description')}
          isDark={isDark}
        >
          <Toggle
            checked={form.planetariumShowInfo ?? true}
            onChange={v => setForm(f => ({ ...f, planetariumShowInfo: v }))}
          />
        </Row>
        <Row
          label={t('librarySection.display.slideshowProcessedOnly.label')}
          description={t('librarySection.display.slideshowProcessedOnly.description')}
          isDark={isDark}
        >
          <Toggle
            checked={form.planetariumProcessedOnlyDefault ?? false}
            onChange={v => setForm(f => ({ ...f, planetariumProcessedOnlyDefault: v }))}
          />
        </Row>
        <Row
          label={t('librarySection.imageBehavior.rotate.label')}
          description={t('librarySection.imageBehavior.rotate.description')}
          isDark={isDark}
        >
          <Toggle
            checked={form.slideshowRotateCCW ?? false}
            onChange={v => setForm(f => ({ ...f, slideshowRotateCCW: v }))}
          />
        </Row>
      </Sec>
    </>
  );
}
