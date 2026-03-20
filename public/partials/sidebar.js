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
        // Inject brand header
        const brand = `
          <a class="sidebar-brand" href="/dashboard">
            <div class="nav-name">Dark<span>Lion</span></div>
          </a>`;
        mount.innerHTML = brand + html;

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
              (nav === 'messages' && path.startsWith('/messages')) ||
              (nav === 'relationships' && path.includes('relationship')) ||
              (nav === 'people' && path.includes('/crm/person')) ||
              (nav === 'companies' && path.includes('/crm/company')) ||
              (nav === 'team' && path === '/dashboard')
            ) {
              a.classList.add('active');
            }
          });
        }

        // Add logout link at bottom
        mount.insertAdjacentHTML('beforeend', `
          <div class="sidebar-footer">
            <a href="#" id="sidebar-logout">Logout</a>
          </div>`);

        const logoutBtn = document.getElementById('sidebar-logout');
        if (logoutBtn) {
          logoutBtn.addEventListener('click', function(e) {
            e.preventDefault();
            localStorage.removeItem('dl_token');
            localStorage.removeItem('dl_firm');
            window.location.href = '/login';
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
