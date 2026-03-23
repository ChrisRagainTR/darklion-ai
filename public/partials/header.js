/**
 * DarkLion shared header loader.
 * Usage: <div id="header-mount"></div><script src="/partials/header.js"></script>
 *
 * Injects the T-frame top header, wires up:
 *  - JWT-based user name / firm / avatar
 *  - User menu toggle + logout
 *  - Unified search bar (relationships, companies, people)
 */
(function () {
  'use strict';

  var token = localStorage.getItem('dl_token');
  if (!token) {
    window.location.replace('/login');
    return;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function qs(sel) { return document.querySelector(sel); }

  function apiFetch(url, opts) {
    opts = opts || {};
    return fetch(url, Object.assign({}, opts, {
      headers: Object.assign({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, opts.headers || {})
    })).then(function (res) {
      if (res.status === 401) {
        res.json().catch(function () { return {}; }).then(function (d) {
          if (d.expired) {
            localStorage.removeItem('dl_token');
            localStorage.removeItem('dl_firm');
          }
          window.location.replace('/login?expired=1');
        });
        throw new Error('Unauthorized');
      }
      return res;
    });
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Load header HTML then wire everything ─────────────────────────────────
  fetch('/partials/header.html?v=3')
    .then(function (r) { return r.text(); })
    .then(function (html) {
      var mount = document.getElementById('header-mount');
      if (!mount) return;
      mount.innerHTML = html;

      wireUserMenu();
      wireSearch();
      populateUser();
      applyFirmBranding();
    })
    .catch(function (e) {
      console.error('[header] failed to load:', e);
    });

  // ── User menu ─────────────────────────────────────────────────────────────
  function wireUserMenu() {
    var trigger = qs('#user-menu-trigger');
    var dropdown = qs('#user-menu-dropdown');

    if (trigger && dropdown) {
      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        var isOpen = dropdown.classList.contains('open');
        dropdown.classList.toggle('open', !isOpen);
        trigger.classList.toggle('open', !isOpen);
      });
    }

    var logoutBtn = qs('#header-logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function (e) {
        e.preventDefault();
        localStorage.removeItem('dl_token');
        localStorage.removeItem('dl_firm');
        window.location.href = '/login';
      });
    }

    // Close user menu on outside click (registered on document after mount)
    document.addEventListener('click', function (e) {
      if (dropdown && dropdown.classList.contains('open') && !qs('.user-menu-wrap').contains(e.target)) {
        dropdown.classList.remove('open');
        trigger && trigger.classList.remove('open');
      }
    });
  }

  // ── Apply firm branding based on domain ──────────────────────────────────
  function applyFirmBranding() {
    fetch('/portal-auth/firm-info')
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) {
        if (!d || !d.firmName) return;
        var logo = qs('#header-brand-logo');
        var name = qs('#header-brand-name');
        if (logo) { logo.src = '/sentinel-favicon.png'; logo.alt = d.firmName; }
        if (name) { name.innerHTML = d.firmName; }
      })
      .catch(function() {});
  }

  // ── Populate name / firm / avatar from JWT ────────────────────────────────
  function populateUser() {
    try {
      var firm = JSON.parse(localStorage.getItem('dl_firm') || '{}');
      if (firm.name && qs('#user-menu-firm')) qs('#user-menu-firm').textContent = firm.name;
    } catch (e) {}

    try {
      var payload = JSON.parse(atob(token.split('.')[1]));
      var name = payload.name || payload.email || '?';
      if (qs('#user-menu-name')) qs('#user-menu-name').textContent = name;
      var initials = name.split(' ').map(function (w) { return w[0]; }).join('').toUpperCase().slice(0, 2);
      if (qs('#user-avatar')) qs('#user-avatar').textContent = initials || '?';

      if (!qs('#user-menu-firm').textContent) {
        try {
          var firm2 = JSON.parse(localStorage.getItem('dl_firm') || '{}');
          if (qs('#user-menu-firm')) qs('#user-menu-firm').textContent = firm2.name || '';
        } catch (e) {}
      }

      if (payload.userId) {
        apiFetch('/firms/team/' + payload.userId + '/avatar')
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.url) {
              var av = qs('#user-avatar');
              if (!av) return;
              var img = document.createElement('img');
              img.src = d.url;
              img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;';
              img.onerror = function () { img.remove(); };
              av.textContent = '';
              av.appendChild(img);
            }
          })
          .catch(function () {});
      }
    } catch (e) {}
  }

  // ── Search ────────────────────────────────────────────────────────────────
  var hcdOpen = false;
  var hcdFocusIdx = -1;
  var searchResults = [];
  var searchTimer = null;

  function wireSearch() {
    var bar = qs('#header-search-bar');
    if (!bar) return;

    bar.addEventListener('focus', openHeaderSearch);
    bar.addEventListener('input', function () { headerSearchInput(bar.value); });
    bar.addEventListener('keydown', handleHeaderSearchKey);

    document.addEventListener('click', function (e) {
      if (hcdOpen && qs('.header-search-wrap') && !qs('.header-search-wrap').contains(e.target)) {
        closeHeaderSearch();
      }
    });
  }

  function openHeaderSearch() {
    var bar = qs('#header-search-bar');
    if (!bar) return;
    bar.removeAttribute('readonly');
    bar.placeholder = 'Search relationships, companies, people…';
    bar.value = '';
    hcdOpen = true;
    searchResults = [];
    renderHcd();
    var dd = qs('#header-client-dropdown');
    if (dd) dd.classList.add('open');
  }

  function closeHeaderSearch() {
    hcdOpen = false;
    var dd = qs('#header-client-dropdown');
    if (dd) dd.classList.remove('open');
    var bar = qs('#header-search-bar');
    if (bar) {
      bar.setAttribute('readonly', '');
      bar.placeholder = 'Search relationships, companies, people…';
      bar.value = '';
    }
  }

  function headerSearchInput(query) {
    clearTimeout(searchTimer);
    if (!query || query.length < 2) { searchResults = []; renderHcd(); return; }
    searchTimer = setTimeout(function () {
      apiFetch('/api/search?q=' + encodeURIComponent(query))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          searchResults = [].concat(
            (data.relationships || []).map(function (r) { return Object.assign({}, r, { _type: 'relationship', _label: r.name, _sub: 'Relationship' }); }),
            (data.companies || []).map(function (c) { return Object.assign({}, c, { _type: 'company', _label: c.name || c.company_name, _sub: c.entity_type || 'Company' }); }),
            (data.people || []).map(function (p) { return Object.assign({}, p, { _type: 'person', _label: (p.first_name || '') + ' ' + (p.last_name || ''), _sub: p.relationship_name || 'Person' }); })
          );
          renderHcd();
        })
        .catch(function () {});
    }, 200);
  }

  function searchNavigate(type, id) {
    closeHeaderSearch();
    if (type === 'relationship') window.location.href = '/crm/relationship/' + id;
    else if (type === 'company') window.location.href = '/crm/company/' + id;
    else if (type === 'person') window.location.href = '/crm/person/' + id;
  }

  // Expose globally so onclick attributes in rendered HTML can call it
  window._headerSearchNavigate = searchNavigate;

  function renderHcd() {
    var list = qs('#hcd-list');
    if (!list) return;
    if (!searchResults.length) {
      list.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--muted);font-size:0.82rem;">Type to search relationships, companies, and people…</div>';
    } else {
      list.innerHTML = searchResults.map(function (r, i) {
        var icon = r._type === 'relationship' ? '👥' : r._type === 'company' ? '🏢' : '👤';
        return '<div class="hcd-option" data-idx="' + i + '">' +
          '<span style="font-size:1rem;">' + icon + '</span>' +
          '<span class="hcd-info">' +
            '<span class="hcd-name">' + esc(r._label || '') + '</span>' +
            '<span class="hcd-meta">' + esc(r._sub || '') + '</span>' +
          '</span>' +
          '</div>';
      }).join('');

      // Wire click/hover via event delegation to avoid inline-handler scope issues
      var listEl = qs('#hcd-list');
      listEl.querySelectorAll('.hcd-option').forEach(function (el, i) {
        el.addEventListener('click', function () { searchNavigate(searchResults[i]._type, searchResults[i].id); });
        el.addEventListener('mouseenter', function () { setHcdFocus(i); });
      });
    }
    var footer = qs('#hcd-footer');
    if (footer) footer.textContent = searchResults.length ? searchResults.length + ' result' + (searchResults.length !== 1 ? 's' : '') : '';
  }

  function setHcdFocus(idx) {
    hcdFocusIdx = idx;
    document.querySelectorAll('.hcd-option').forEach(function (el, i) {
      el.classList.toggle('focused', i === idx);
    });
  }

  function handleHeaderSearchKey(e) {
    if (!hcdOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      hcdFocusIdx = Math.min(hcdFocusIdx + 1, searchResults.length - 1);
      setHcdFocus(hcdFocusIdx);
      var el = qs('.hcd-option[data-idx="' + hcdFocusIdx + '"]');
      if (el) el.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      hcdFocusIdx = Math.max(hcdFocusIdx - 1, 0);
      setHcdFocus(hcdFocusIdx);
      var el2 = qs('.hcd-option[data-idx="' + hcdFocusIdx + '"]');
      if (el2) el2.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && hcdFocusIdx >= 0 && searchResults[hcdFocusIdx]) {
      searchNavigate(searchResults[hcdFocusIdx]._type, searchResults[hcdFocusIdx].id);
    } else if (e.key === 'Escape') {
      closeHeaderSearch();
    }
  }

})();
