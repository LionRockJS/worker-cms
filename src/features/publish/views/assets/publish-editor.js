(function () {
  'use strict';

  const publishScheduleToggle = document.querySelector('[data-publish-schedule-toggle]');
  const publishSchedulePanel = document.querySelector('[data-publish-schedule-panel]');
  if (publishScheduleToggle && publishSchedulePanel) {
    const publishScheduleStorageKey = 'cms-editor-publish-schedule-collapsed';
    const expandedIcon = publishScheduleToggle.querySelector('[data-publish-schedule-expanded-icon]');
    const collapsedIcon = publishScheduleToggle.querySelector('[data-publish-schedule-collapsed-icon]');

    function setPublishScheduleCollapsed(collapsed, persist) {
      publishSchedulePanel.hidden = collapsed;
      publishSchedulePanel.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
      publishScheduleToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      const label = collapsed
        ? publishScheduleToggle.dataset.expandLabel
        : publishScheduleToggle.dataset.collapseLabel;
      if (label) {
        publishScheduleToggle.setAttribute('aria-label', label);
        publishScheduleToggle.setAttribute('title', label);
      }
      if (expandedIcon) expandedIcon.classList.toggle('hidden', collapsed);
      if (collapsedIcon) collapsedIcon.classList.toggle('hidden', !collapsed);
      if (persist) {
        try {
          window.localStorage.setItem(publishScheduleStorageKey, collapsed ? '1' : '0');
        } catch (_error) {}
      }
    }

    let publishScheduleCollapsed = true;
    try {
      publishScheduleCollapsed = window.localStorage.getItem(publishScheduleStorageKey) === '1';
    } catch (_error) {}
    setPublishScheduleCollapsed(publishScheduleCollapsed, false);
    publishScheduleToggle.addEventListener('click', () => {
      setPublishScheduleCollapsed(!publishSchedulePanel.hidden, true);
    });
  }

  const unpublishButton = document.querySelector('[data-unpublish-button]');
  if (unpublishButton) {
    unpublishButton.addEventListener('click', (event) => {
      const message = unpublishButton.getAttribute('data-confirm-message') || 'Un-publish this page?';
      if (!confirm(message)) event.preventDefault();
    });
  }
})();
