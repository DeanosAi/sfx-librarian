/**
 * Tab navigation — switches the active media kind in window.data and notifies
 * app.js (via a CustomEvent) so it can reload stats / categories / clear search.
 *
 * Disabled tabs are placeholders for B-Roll, Transitions, etc. Enabling them
 * later means: index a different DB or add another media-kind filter in main.js,
 * then drop disabled=false on the button.
 */
(() => {
  const KIND_TITLES = {
    sfx: 'SFX',
    music: 'Music',
    broll: 'B-Roll',
    transitions: 'Transitions',
  };

  function activate(kind) {
    document.querySelectorAll('#tabs .tab').forEach(b => {
      b.classList.toggle('active', b.dataset.kind === kind);
    });
    const heading = document.getElementById('tab-heading');
    if (heading) heading.textContent = KIND_TITLES[kind] || kind;
    if (window.data) window.data.setKind(kind);
    document.dispatchEvent(new CustomEvent('kind-changed', { detail: { kind } }));
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('#tabs .tab').forEach(btn => {
      if (btn.disabled) return;
      btn.addEventListener('click', () => activate(btn.dataset.kind));
    });
  });

  window.tabs = { activate };
})();
