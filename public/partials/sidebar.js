/**
 * DarkLion shared sidebar loader.
 * Usage: <script src="/partials/sidebar.js"></script>
 * Place a <aside class="sidebar" id="sidebar-mount"></aside> where the sidebar should appear.
 * Optionally set data-active="messages" on the aside to highlight the active nav item.
 */
(function() {
  'use strict';

  function loadSidebar() {
    const mount = document.getElementById('sidebar-mount');
    if (!mount) return;

    const activeKey = mount.dataset.active || '';

    fetch('/partials/sidebar.html')
      .then(function(r) { return r.text(); })
      .then(function(html) {
        mount.innerHTML = html;

        // Highlight active item
        if (activeKey) {
          const link = mount.querySelector('[data-nav="' + activeKey + '"]');
          if (link) link.classList.add('active');
        } else {
          // Auto-detect from current path
          const path = window.location.pathname;
          mount.querySelectorAll('[data-nav]').forEach(function(a) {
            const nav = a.dataset.nav;
            if (
              (nav === 'pipelines' && path.startsWith('/pipelines')) ||
              (nav === 'messages' && path.startsWith('/messages')) ||
              (nav === 'relationships' && path.includes('relationship')) ||
              (nav === 'people' && path.includes('/crm/person')) ||
              (nav === 'companies' && path.includes('/crm/company'))
            ) {
              a.classList.add('active');
            }
          });
        }
      })
      .catch(function(e) {
        console.error('[sidebar] failed to load:', e);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadSidebar);
  } else {
    loadSidebar();
  }
})();
