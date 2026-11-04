export function pageToolLabels(t: (key: string) => string) {
  return {
    title: t('pageToolsTitle'),
    show: t('injectInline'),
    hide: t('removeInline'),
    close: t('pageToolsClose'),
    settings: t('pageToolsSettings'),
    compact: t('pageToolsCompact'),
    inline: t('pageToolsInline'),
    dismiss: t('pageToolsHide'),
    my: t('openMyPage'),
    error: t('pageToolsActionError'),
    drag: t('pageToolsDrag'),
    hideVisit: t('pageToolsHideVisit'),
    hideGlobal: t('pageToolsHideGlobal'),
    hideSite: t('pageToolsHideSite'),
    restoreHelp: t('pageToolsRestoreHelp'),
    settingsLink: t('settings'),
    confirmHide: t('pageToolsConfirmHide'),
  };
}

export type PageToolLabels = ReturnType<typeof pageToolLabels>;
