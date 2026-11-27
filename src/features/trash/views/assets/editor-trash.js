(function () {
  'use strict';

  const deleteButton = document.querySelector('form[data-editor-form] [data-delete-button]');
  if (!deleteButton || deleteButton.dataset.trashConfirmationBound === '1') return;
  deleteButton.dataset.trashConfirmationBound = '1';

  deleteButton.addEventListener('click', (event) => {
    const message = deleteButton.getAttribute('data-confirm-message')
      || 'Move this page to trash? You can restore it later from Trash.';
    if (!confirm(message)) event.preventDefault();
  });
})();
