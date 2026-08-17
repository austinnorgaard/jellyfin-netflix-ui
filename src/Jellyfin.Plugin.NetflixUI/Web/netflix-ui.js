/* =============================================================================
 * Netflix UI for Jellyfin
 *
 * Jellyfin's web client is a single-page app that recycles DOM nodes as you
 * scroll, so nothing here can assume an element still exists a moment later.
 * Everything is delegated or (re)applied via MutationObserver, and every lookup
 * is defensive. If the DOM shape changes in a future jellyfin-web the theme
 * should degrade to "plain Jellyfin", never throw.
 * ========================================================================== */
(function () {
  'use strict';

  var CFG = Object.assign({
    enabled: true,
    hoverPreview: true,
    hoverDelayMs: 400,
    rowCarousels: true,
    topTenBadges: true,
    detailModal: true,
    accentColor: '#e50914'
  }, window.NetflixUIConfig || {});

  if (!CFG.enabled) {
    return;
  }

  var NS = 'nfui';

  /* ---------------------------------------------------------------- helpers */

  function qs(root, sel) { try { return (root || document).querySelector(sel); } catch (e) { return null; } }
  function qsa(root, sel) { try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; } }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (html != null) { n.innerHTML = html; }
    return n;
  }

  /**
   * Escape before interpolating ANY server-supplied metadata into markup.
   * Genres, studio names, official ratings and titles originate from TMDB /
   * TVDB / local .nfo files - all attacker-influenceable - so treating them as
   * trusted HTML would be a stored-XSS hole in the media server.
   */
  function esc(s) {
    if (s == null) { return ''; }
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /** Jellyfin puts the item id on the card as data-id. */
  function cardItemId(card) {
    return card && (card.getAttribute('data-id') || card.getAttribute('data-itemid'));
  }

  function api() {
    return window.ApiClient || (window.Emby && window.Emby.ApiClient) || null;
  }

  function userId() {
    var a = api();
    try { return a && a.getCurrentUserId ? a.getCurrentUserId() : null; } catch (e) { return null; }
  }

  var itemCache = Object.create(null);

  function fetchItem(id) {
    if (!id) { return Promise.reject(new Error('no id')); }
    if (itemCache[id]) { return Promise.resolve(itemCache[id]); }
    var a = api(), u = userId();
    if (!a || !u || !a.getItem) { return Promise.reject(new Error('no ApiClient')); }
    return a.getItem(u, id).then(function (item) {
      itemCache[id] = item;
      return item;
    });
  }

  function ticksToMinutes(ticks) {
    if (!ticks) { return null; }
    return Math.round(ticks / 600000000);
  }

  function navigateTo(id) {
    var a = api();
    var serverId = a && a.serverId ? a.serverId() : '';
    window.location.hash = '#/details?id=' + encodeURIComponent(id) +
      (serverId ? '&serverId=' + encodeURIComponent(serverId) : '');
  }

  /* ------------------------------------------------------- 1. hover preview */
  /* Netflix scales the card, then after a beat swaps in a richer panel with
   * metadata and actions. We build one shared panel and move it, rather than
   * one per card - with a large library that's thousands of nodes otherwise. */

  var hover = {
    timer: null,
    panel: null,
    current: null
  };

  function buildHoverPanel() {
    if (hover.panel) { return hover.panel; }

    var p = el('div', NS + '-preview');
    p.innerHTML =
      '<div class="' + NS + '-preview-art"></div>' +
      '<div class="' + NS + '-preview-body">' +
        '<div class="' + NS + '-preview-actions">' +
          '<button type="button" class="' + NS + '-btn ' + NS + '-btn-play" title="Play">&#9654;</button>' +
          '<button type="button" class="' + NS + '-btn ' + NS + '-btn-round" data-act="queue" title="Add to playlist">+</button>' +
          '<button type="button" class="' + NS + '-btn ' + NS + '-btn-round ' + NS + '-btn-more" data-act="more" title="More info">&#9660;</button>' +
        '</div>' +
        '<div class="' + NS + '-preview-meta"></div>' +
        '<div class="' + NS + '-preview-genres"></div>' +
      '</div>';

    p.addEventListener('mouseleave', scheduleHide);
    p.addEventListener('mouseenter', function () { clearTimeout(hover.timer); });

    p.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button');
      if (!btn || !hover.current) { return; }
      ev.preventDefault();
      ev.stopPropagation();

      var id = cardItemId(hover.current);
      var act = btn.getAttribute('data-act');

      if (act === 'more') {
        hidePreview();
        if (CFG.detailModal) { openDetailModal(id); } else { navigateTo(id); }
      } else if (act === 'queue') {
        btn.classList.toggle(NS + '-btn-active');
      } else {
        hidePreview();
        playItem(id);
      }
    });

    document.body.appendChild(p);
    hover.panel = p;
    return p;
  }

  function playItem(id) {
    if (!id) { return; }
    // playbackManager is the supported entry point; fall back to the detail page.
    var pm = window.playbackManager || (window.Emby && window.Emby.playbackManager);
    if (pm && pm.play) {
      try { pm.play({ ids: [id] }); return; } catch (e) { /* fall through */ }
    }
    navigateTo(id);
  }

  function showPreview(card) {
    var id = cardItemId(card);
    if (!id) { return; }

    var panel = buildHoverPanel();
    hover.current = card;

    var r = card.getBoundingClientRect();
    // Grow around the card's centre, the way Netflix does, and keep it on screen.
    var w = Math.max(r.width * 1.5, 280);
    var left = r.left + window.scrollX - (w - r.width) / 2;
    left = Math.max(8, Math.min(left, document.documentElement.clientWidth - w - 8));

    panel.style.width = w + 'px';
    panel.style.left = left + 'px';
    panel.style.top = (r.top + window.scrollY - 28) + 'px';

    var art = qs(panel, '.' + NS + '-preview-art');
    var img = qs(card, 'img');
    var bg = qs(card, '.cardImageContainer');
    var src = (img && img.src) ||
      (bg && bg.style.backgroundImage || '').replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
    art.style.backgroundImage = src ? 'url("' + src + '")' : '';

    panel.classList.add(NS + '-preview-open');

    fetchItem(id).then(function (item) {
      if (hover.current !== card) { return; } // moved on already
      var meta = qs(panel, '.' + NS + '-preview-meta');
      var genres = qs(panel, '.' + NS + '-preview-genres');
      if (!meta || !genres) { return; }

      var bits = [];
      // Math.round() forces a number, so this one is safe by construction.
      if (item.CommunityRating) { bits.push('<span class="' + NS + '-match">' + Math.round(item.CommunityRating * 10) + '% Match</span>'); }
      if (item.OfficialRating) { bits.push('<span class="' + NS + '-rating">' + esc(item.OfficialRating) + '</span>'); }
      var mins = ticksToMinutes(item.RunTimeTicks);
      if (mins) { bits.push(mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm'); }
      if (item.ProductionYear) { bits.push(item.ProductionYear); }
      meta.innerHTML = bits.join('<span class="' + NS + '-dot"></span>');

      genres.textContent = (item.Genres || []).slice(0, 3).join(' • ');
    }).catch(function () { /* metadata is a bonus, not a requirement */ });
  }

  function hidePreview() {
    clearTimeout(hover.timer);
    hover.current = null;
    if (hover.panel) { hover.panel.classList.remove(NS + '-preview-open'); }
  }

  function scheduleHide() {
    clearTimeout(hover.timer);
    hover.timer = setTimeout(hidePreview, 180);
  }

  function initHoverPreview() {
    if (!CFG.hoverPreview) { return; }

    document.addEventListener('mouseover', function (ev) {
      var card = ev.target.closest && ev.target.closest('.card');
      if (!card || card === hover.current) { return; }
      if (card.closest('.' + NS + '-preview')) { return; }

      clearTimeout(hover.timer);
      hover.timer = setTimeout(function () { showPreview(card); }, CFG.hoverDelayMs);
    }, true);

    document.addEventListener('mouseout', function (ev) {
      var card = ev.target.closest && ev.target.closest('.card');
      if (!card) { return; }
      var to = ev.relatedTarget;
      if (to && to.closest && to.closest('.' + NS + '-preview')) { return; }
      scheduleHide();
    }, true);

    // Anything that moves the page invalidates the anchored position.
    window.addEventListener('scroll', hidePreview, true);
    window.addEventListener('resize', debounce(hidePreview, 100));
  }

  /* ----------------------------------------------------- 2. row carousels */

  function initCarousel(scroller) {
    if (!CFG.rowCarousels) { return; }
    if (scroller.getAttribute('data-' + NS + '-carousel')) { return; }
    scroller.setAttribute('data-' + NS + '-carousel', '1');

    var wrap = scroller.parentElement;
    if (!wrap) { return; }
    wrap.classList.add(NS + '-row');

    var prev = el('button', NS + '-arrow ' + NS + '-arrow-prev', '&#10094;');
    var next = el('button', NS + '-arrow ' + NS + '-arrow-next', '&#10095;');
    prev.type = next.type = 'button';

    function page(dir) {
      var amount = Math.max(scroller.clientWidth * 0.9, 200);
      scroller.scrollBy({ left: dir * amount, behavior: 'smooth' });
    }

    prev.addEventListener('click', function (e) { e.preventDefault(); page(-1); });
    next.addEventListener('click', function (e) { e.preventDefault(); page(1); });

    function sync() {
      var max = scroller.scrollWidth - scroller.clientWidth - 4;
      prev.classList.toggle(NS + '-arrow-hidden', scroller.scrollLeft <= 4);
      next.classList.toggle(NS + '-arrow-hidden', scroller.scrollLeft >= max);
    }

    scroller.addEventListener('scroll', debounce(sync, 60));
    setTimeout(sync, 60);

    wrap.appendChild(prev);
    wrap.appendChild(next);
  }

  /* ------------------------------------------------------- 3. Top 10 badges */

  function applyTopTen(section) {
    if (!CFG.topTenBadges) { return; }
    if (section.getAttribute('data-' + NS + '-top10')) { return; }

    var title = qs(section, '.sectionTitle');
    if (!title || !/\btop\b|trending|popular/i.test(title.textContent || '')) { return; }

    section.setAttribute('data-' + NS + '-top10', '1');
    section.classList.add(NS + '-top10');

    qsa(section, '.card').slice(0, 10).forEach(function (card, i) {
      if (qs(card, '.' + NS + '-rank')) { return; }
      var rank = el('span', NS + '-rank', String(i + 1));
      var box = qs(card, '.cardBox') || card;
      box.appendChild(rank);
    });
  }

  /* ------------------------------------------------------ 4. detail modal */

  var modalEl = null;

  function openDetailModal(id) {
    if (!id) { return; }

    if (!modalEl) {
      modalEl = el('div', NS + '-modal');
      modalEl.innerHTML =
        '<div class="' + NS + '-modal-backdrop"></div>' +
        '<div class="' + NS + '-modal-card" role="dialog" aria-modal="true">' +
          '<button type="button" class="' + NS + '-modal-close" aria-label="Close">&times;</button>' +
          '<div class="' + NS + '-modal-hero"></div>' +
          '<div class="' + NS + '-modal-body">' +
            '<h2 class="' + NS + '-modal-title"></h2>' +
            '<div class="' + NS + '-modal-meta"></div>' +
            '<p class="' + NS + '-modal-overview"></p>' +
            '<div class="' + NS + '-modal-extra"></div>' +
          '</div>' +
        '</div>';

      modalEl.addEventListener('click', function (ev) {
        if (ev.target.closest('.' + NS + '-modal-close') ||
            ev.target.classList.contains(NS + '-modal-backdrop')) {
          closeDetailModal();
        }
      });
      document.body.appendChild(modalEl);
    }

    modalEl.classList.add(NS + '-modal-open');
    document.body.classList.add(NS + '-noscroll');

    fetchItem(id).then(function (item) {
      var a = api();
      var hero = qs(modalEl, '.' + NS + '-modal-hero');
      if (hero && a && a.getImageUrl) {
        var url = a.getImageUrl(item.Id, { type: 'Backdrop', maxWidth: 1280 });
        hero.style.backgroundImage = url ? 'url("' + url + '")' : '';
      }

      qs(modalEl, '.' + NS + '-modal-title').textContent = item.Name || '';

      var bits = [];
      if (item.ProductionYear) { bits.push(item.ProductionYear); }
      if (item.OfficialRating) { bits.push(item.OfficialRating); }
      var mins = ticksToMinutes(item.RunTimeTicks);
      if (mins) { bits.push(mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm'); }
      qs(modalEl, '.' + NS + '-modal-meta').textContent = bits.join('  •  ');

      qs(modalEl, '.' + NS + '-modal-overview').textContent = item.Overview || '';

      var extra = qs(modalEl, '.' + NS + '-modal-extra');
      var rows = [];
      if (item.Genres && item.Genres.length) {
        rows.push('<div><span>Genres:</span> ' + esc(item.Genres.join(', ')) + '</div>');
      }
      if (item.Studios && item.Studios.length) {
        rows.push('<div><span>Studio:</span> ' +
          esc(item.Studios.map(function (s) { return s && s.Name; }).filter(Boolean).join(', ')) + '</div>');
      }
      extra.innerHTML = rows.join('');
    }).catch(function () {
      // Couldn't load metadata - don't strand the user in an empty modal.
      closeDetailModal();
      navigateTo(id);
    });
  }

  function closeDetailModal() {
    if (modalEl) { modalEl.classList.remove(NS + '-modal-open'); }
    document.body.classList.remove(NS + '-noscroll');
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { closeDetailModal(); hidePreview(); }
  });

  /* --------------------------------------------------------------- 5. wire */

  var scan = debounce(function () {
    qsa(document, '.emby-scroller, .itemsContainer.scrollSlider').forEach(initCarousel);
    qsa(document, '.verticalSection').forEach(applyTopTen);
  }, 120);

  function boot() {
    document.documentElement.classList.add(NS + '-active');
    initHoverPreview();
    scan();

    // jellyfin-web swaps whole views in and out; re-scan when it does.
    var mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('hashchange', function () { hidePreview(); closeDetailModal(); scan(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
