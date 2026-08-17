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

  /* ---------------------------------------------------------------------------
   * Legacy-engine guards.
   *
   * Smart-TV browsers (Tizen, webOS) and embedded webviews can be several years
   * behind. The whole file is deliberately ES5 - no arrow functions, no let /
   * const, no template literals - but a few DOM/stdlib APIs still need cover.
   * If a hard requirement is genuinely missing we bail out silently and leave
   * stock Jellyfin working rather than throwing on every page.
   * ------------------------------------------------------------------------ */
  if (typeof window.Promise !== 'function' ||
      typeof window.MutationObserver !== 'function') {
    return;                      // too old to support; stock UI is fine
  }

  // Element.closest - absent on older WebKit/Chromium.
  if (typeof Element !== 'undefined' && !Element.prototype.closest) {
    var _matches = Element.prototype.matches ||
                   Element.prototype.msMatchesSelector ||
                   Element.prototype.webkitMatchesSelector;
    Element.prototype.closest = function (sel) {
      var n = this;
      while (n && n.nodeType === 1) {
        if (_matches && _matches.call(n, sel)) { return n; }
        n = n.parentElement || n.parentNode;
      }
      return null;
    };
  }

  // Object.assign - ES2015; trivial single-source shim is all we need.
  var assign = typeof Object.assign === 'function' ? Object.assign : function (t) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) { continue; }
      for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) { t[k] = src[k]; } }
    }
    return t;
  };

  // requestAnimationFrame - used only to force a reflow before a transition.
  var raf = window.requestAnimationFrame ||
            window.webkitRequestAnimationFrame ||
            function (fn) { return setTimeout(fn, 16); };

  var CFG = assign({
    enabled: true,
    hoverPreview: true,
    hoverDelayMs: 400,
    rowCarousels: true,
    topTenBadges: true,
    detailModal: true,
    hoverTrailers: false,
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

    // Button order matches Netflix exactly: Play, Add, Rate, then the
    // "more info" chevron pushed to the far right of the row.
    // Layout mirrors the reference frames: artwork (with an optional muted
    // video preview and a mute toggle bottom-right), then the action row with
    // the chevron pushed right, then metadata chips, then genre descriptors.
    var p = el('div', NS + '-preview');
    p.innerHTML =
      '<div class="' + NS + '-preview-art">' +
        '<video class="' + NS + '-preview-video" muted playsinline preload="none"></video>' +
        '<button type="button" class="' + NS + '-mute" data-act="mute" title="Mute">&#128266;</button>' +
      '</div>' +
      '<div class="' + NS + '-preview-body">' +
        '<div class="' + NS + '-preview-actions">' +
          '<button type="button" class="' + NS + '-btn ' + NS + '-btn-play" title="Play">&#9654;</button>' +
          '<button type="button" class="' + NS + '-btn ' + NS + '-btn-round" data-act="queue" data-tip="Add to My List">+</button>' +
          '<button type="button" class="' + NS + '-btn ' + NS + '-btn-round" data-act="like" data-tip="Rate">&#128077;</button>' +
          '<button type="button" class="' + NS + '-btn ' + NS + '-btn-round ' + NS + '-btn-more" data-act="more" data-tip="More info">&#9660;</button>' +
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
        // Netflix swaps + for a tick once the title is in My List.
        var added = btn.classList.toggle(NS + '-btn-active');
        btn.innerHTML = added ? '&#10003;' : '+';
        btn.setAttribute('data-tip', added ? 'Remove from My List' : 'Add to My List');
      } else if (act === 'like') {
        btn.classList.toggle(NS + '-btn-active');
      } else if (act === 'mute') {
        var v = qs(hover.panel, '.' + NS + '-preview-video');
        if (v) {
          v.muted = !v.muted;
          btn.innerHTML = v.muted ? '&#128266;' : '&#128263;';
        }
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

    // The panel is position:FIXED, so getBoundingClientRect coordinates are used
    // as-is with no scroll offset.
    //
    // This was the bug that made the hover panel invisible: it used to be
    // position:absolute with window.scrollY/scrollX added. Jellyfin does not
    // scroll the window - it scrolls an inner container - so window.scrollY is
    // always 0, and the card's VIEWPORT position was being applied as a DOCUMENT
    // position. Anywhere below the fold the panel landed off-screen, which looked
    // like "hover preview does nothing" (and took the caret and the trailer
    // autoplay with it, since they live inside the panel).
    var w = Math.max(r.width * 1.5, 280);
    var left = r.left - (w - r.width) / 2;
    left = Math.max(8, Math.min(left, document.documentElement.clientWidth - w - 8));

    var top = r.top - 28;
    // Keep it fully on screen vertically too - rows near the bottom would
    // otherwise push the metadata below the fold.
    var maxTop = document.documentElement.clientHeight - (w * 0.5625 + 130);
    top = Math.max(8, Math.min(top, Math.max(8, maxTop)));

    panel.style.width = w + 'px';
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';

    var art = qs(panel, '.' + NS + '-preview-art');
    var img = qs(card, 'img');
    var bg = qs(card, '.cardImageContainer');
    var src = (img && img.src) ||
      (bg && bg.style.backgroundImage || '').replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
    art.style.backgroundImage = src ? 'url("' + src + '")' : '';

    panel.classList.add(NS + '-preview-open');

    // Muted video preview, Netflix-style. OFF by default and gated on a local
    // trailer existing: pointing this at the main video would make every card
    // hover start a transcode, which on a modest server is a self-inflicted
    // denial of service. A local trailer is short and usually direct-plays.
    var video = qs(panel, '.' + NS + '-preview-video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.classList.remove(NS + '-preview-video-on');
    }
    if (CFG.hoverTrailers && video) {
      startPreviewVideo(video, id, card);
    }

    fetchItem(id).then(function (item) {
      if (hover.current !== card) { return; } // moved on already
      var meta = qs(panel, '.' + NS + '-preview-meta');
      var genres = qs(panel, '.' + NS + '-preview-genres');
      if (!meta || !genres) { return; }

      // Netflix's hover panel is: [maturity box] [seasons | runtime] [HD box].
      // Deliberately no "% match" here - that appears on the billboard, not
      // on card hover (verified against reference screenshots).
      var bits = [];
      if (item.OfficialRating) { bits.push('<span class="' + NS + '-rating">' + esc(item.OfficialRating) + '</span>'); }

      if (item.Type === 'Series' && item.ChildCount) {
        bits.push(item.ChildCount + ' Season' + (item.ChildCount === 1 ? '' : 's'));
      } else {
        var mins = ticksToMinutes(item.RunTimeTicks);
        if (mins) { bits.push(mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm'); }
      }

      var stream = (item.MediaStreams || []).filter(function (s) { return s.Type === 'Video'; })[0];
      if (stream && stream.Height >= 720) {
        bits.push('<span class="' + NS + '-hd">' + (stream.Height >= 2160 ? '4K' : 'HD') + '</span>');
      }
      meta.innerHTML = bits.join(' ');

      // Netflix separates descriptors with small round dots, not text bullets.
      genres.textContent = '';
      (item.Genres || []).slice(0, 3).forEach(function (g, i) {
        if (i) { genres.appendChild(el('span', NS + '-sep')); }
        var s = document.createElement('span');
        s.textContent = g;            // textContent: never trust metadata as markup
        genres.appendChild(s);
      });
    }).catch(function () { /* metadata is a bonus, not a requirement */ });
  }

  /**
   * Play a short muted preview in the hover panel.
   *
   * Only uses a LOCAL trailer. Remote trailers are YouTube page URLs (not
   * embeddable as a bare <video> src), and streaming the feature itself would
   * kick off a transcode per hover.
   */
  function startPreviewVideo(video, id, card) {
    var a = api();
    if (!a || !a.getUrl) { return; }

    a.getJSON(a.getUrl('Items/' + id + '/LocalTrailers')).then(function (trailers) {
      if (!trailers || !trailers.length) { return; }
      if (hover.current !== card) { return; }   // cursor moved on while we asked

      var url = a.getUrl('Videos/' + trailers[0].Id + '/stream.mp4', {
        Static: true,
        api_key: a.accessToken ? a.accessToken() : undefined
      });

      video.src = url;
      video.muted = true;
      var p = video.play();
      if (p && p.catch) { p.catch(function () { /* autoplay blocked - keep the still */ }); }
      video.addEventListener('playing', function once() {
        video.removeEventListener('playing', once);
        if (hover.current === card) { video.classList.add(NS + '-preview-video-on'); }
      });
    }).catch(function () { /* no trailers endpoint / no permission - fine */ });
  }

  function hidePreview() {
    clearTimeout(hover.timer);
    hover.current = null;
    if (hover.panel) {
      hover.panel.classList.remove(NS + '-preview-open');
      var v = qs(hover.panel, '.' + NS + '-preview-video');
      if (v) { v.pause(); v.removeAttribute('src'); v.classList.remove(NS + '-preview-video-on'); }
    }
  }

  function scheduleHide() {
    clearTimeout(hover.timer);
    hover.timer = setTimeout(hidePreview, 180);
  }

  /**
   * True only where a hover panel makes sense: a precise, hover-capable
   * pointer, and not a TV 10-foot layout.
   *
   * Touch browsers synthesise hover on tap, so a width-based check is wrong -
   * it would leave the panel stuck open after a tap on a large tablet, and
   * wrongly disable it on a small mouse-driven window. Capability queries also
   * cover hardware that does not exist yet.
   */
  function hoverCapable() {
    try {
      if (document.body && document.body.classList.contains('layout-tv')) { return false; }
      if (!window.matchMedia) { return true; }
      return window.matchMedia('(hover: hover)').matches &&
             window.matchMedia('(pointer: fine)').matches;
    } catch (e) {
      return true;
    }
  }

  function initHoverPreview() {
    if (!CFG.hoverPreview || !hoverCapable()) { return; }

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
      // scrollBy({behavior}) is not universal on older engines; degrade to an
      // instant jump rather than doing nothing at all.
      try {
        scroller.scrollBy({ left: dir * amount, behavior: 'smooth' });
      } catch (e) {
        scroller.scrollLeft += dir * amount;
      }
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

    // Netflix does NOT overlay the rank on the artwork - the numeral sits
    // *beside* a portrait poster as a sibling, both roughly full row height,
    // outline-only with no fill. Verified against reference screenshots.
    qsa(section, '.card').slice(0, 10).forEach(function (card, i) {
      if (card.getAttribute('data-' + NS + '-ranked')) { return; }
      card.setAttribute('data-' + NS + '-ranked', '1');
      card.classList.add(NS + '-ranked-card');

      var rank = el('span', NS + '-rank');
      rank.textContent = String(i + 1);
      rank.setAttribute('aria-hidden', 'true');   // decorative; order is already in the DOM
      card.insertBefore(rank, card.firstChild);
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
          '<div class="' + NS + '-modal-hero">' +
            '<div class="' + NS + '-modal-hero-fade"></div>' +
            '<div class="' + NS + '-modal-hero-body">' +
              '<h2 class="' + NS + '-modal-title"></h2>' +
              '<div class="' + NS + '-modal-actions">' +
                '<button type="button" class="' + NS + '-modal-play">' +
                  '<span class="' + NS + '-play-glyph">&#9654;</span> Play</button>' +
                '<button type="button" class="' + NS + '-btn ' + NS + '-btn-round" data-act="queue" data-tip="Add to My List">+</button>' +
                '<button type="button" class="' + NS + '-btn ' + NS + '-btn-round" data-act="like" data-tip="Rate">&#128077;</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="' + NS + '-modal-body">' +
            '<div class="' + NS + '-modal-main">' +
              '<div class="' + NS + '-modal-meta"></div>' +
              '<p class="' + NS + '-modal-overview"></p>' +
            '</div>' +
            '<aside class="' + NS + '-modal-side"></aside>' +
          '</div>' +
        '</div>';

      modalEl.addEventListener('click', function (ev) {
        if (ev.target.closest('.' + NS + '-modal-close') ||
            ev.target.classList.contains(NS + '-modal-backdrop')) {
          closeDetailModal();
          return;
        }
        var play = ev.target.closest('.' + NS + '-modal-play');
        if (play && modalEl.getAttribute('data-item')) {
          closeDetailModal();
          playItem(modalEl.getAttribute('data-item'));
          return;
        }
        var rb = ev.target.closest('.' + NS + '-btn-round');
        if (rb) {
          var on = rb.classList.toggle(NS + '-btn-active');
          if (rb.getAttribute('data-act') === 'queue') {
            rb.innerHTML = on ? '&#10003;' : '+';
            rb.setAttribute('data-tip', on ? 'Remove from My List' : 'Add to My List');
          }
        }
      });
      document.body.appendChild(modalEl);
    }

    modalEl.classList.add(NS + '-modal-open');
    document.body.classList.add(NS + '-noscroll');

    modalEl.setAttribute('data-item', id);

    fetchItem(id).then(function (item) {
      var a = api();
      var hero = qs(modalEl, '.' + NS + '-modal-hero');

      // Episodes frequently have no Backdrop; fall back through the image types
      // Jellyfin actually has, else the hero renders as a black box (it did).
      if (hero && a && a.getImageUrl) {
        var url = '';
        var tries = [
          [item.Id, 'Backdrop'],
          [item.ParentBackdropItemId || item.SeriesId, 'Backdrop'],
          [item.Id, 'Thumb'],
          [item.Id, 'Primary']
        ];
        for (var i = 0; i < tries.length && !url; i++) {
          if (!tries[i][0]) { continue; }
          try {
            var tag = (item.ImageTags || {})[tries[i][1]];
            if (tries[i][1] === 'Backdrop' || tag || tries[i][0] !== item.Id) {
              url = a.getImageUrl(tries[i][0], { type: tries[i][1], maxWidth: 1280 });
            }
          } catch (e) { /* try the next one */ }
        }
        hero.style.backgroundImage = url ? 'url("' + url + '")' : '';
      }

      qs(modalEl, '.' + NS + '-modal-title').textContent = item.Name || '';

      // Netflix's chip row: year, runtime or seasons, maturity, HD.
      var meta = qs(modalEl, '.' + NS + '-modal-meta');
      var bits = [];
      if (item.ProductionYear) { bits.push('<span>' + esc(item.ProductionYear) + '</span>'); }
      if (item.Type === 'Series' && item.ChildCount) {
        bits.push('<span>' + item.ChildCount + ' Season' + (item.ChildCount === 1 ? '' : 's') + '</span>');
      } else {
        var mins = ticksToMinutes(item.RunTimeTicks);
        if (mins) { bits.push('<span>' + (mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm') + '</span>'); }
      }
      if (item.OfficialRating) { bits.push('<span class="' + NS + '-rating">' + esc(item.OfficialRating) + '</span>'); }
      var vs = (item.MediaStreams || []).filter(function (x) { return x.Type === 'Video'; })[0];
      if (vs && vs.Height >= 720) { bits.push('<span class="' + NS + '-hd">' + (vs.Height >= 2160 ? '4K' : 'HD') + '</span>'); }
      meta.innerHTML = bits.join('');

      qs(modalEl, '.' + NS + '-modal-overview').textContent = item.Overview || '';

      // Right-hand column, as Netflix lays it out.
      var side = qs(modalEl, '.' + NS + '-modal-side');
      var rows = [];
      var cast = (item.People || []).filter(function (p) { return p.Type === 'Actor'; })
                                    .slice(0, 4).map(function (p) { return p.Name; });
      if (cast.length) { rows.push('<div><span>Cast:</span> ' + esc(cast.join(', ')) + '</div>'); }
      if (item.Genres && item.Genres.length) {
        rows.push('<div><span>Genres:</span> ' + esc(item.Genres.join(', ')) + '</div>');
      }
      if (item.Studios && item.Studios.length) {
        rows.push('<div><span>Studio:</span> ' +
          esc(item.Studios.map(function (x) { return x && x.Name; }).filter(Boolean).slice(0, 3).join(', ')) + '</div>');
      }
      side.innerHTML = rows.join('');
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

  /* --------------------------------------------- 5. maturity rating overlay */
  /* Netflix shows "RATED TV-MA / nudity, language, smoking" top-left for a few
   * seconds when playback starts, with a red rule down the left and a black
   * fade in and out. Jellyfin has no equivalent, so we build it.
   *
   * Hooking this reliably is the tricky part: playbackManager exists but its
   * event plumbing has moved between versions, so we prefer it when present
   * and otherwise fall back to noticing a <video> element appear. */

  var ratingShown = Object.create(null);

  function showRatingOverlay(item) {
    if (!item || !item.OfficialRating) { return; }
    if (ratingShown[item.Id]) { return; }        // once per item per page-life
    ratingShown[item.Id] = true;

    var o = el('div', NS + '-maturity');
    var rated = el('div', NS + '-maturity-rated');
    rated.textContent = 'RATED ' + item.OfficialRating;

    o.appendChild(rated);

    // Netflix lists the content descriptors underneath. Jellyfin doesn't model
    // these, so fall back to tags, which is where .nfo descriptors usually land.
    var descriptors = (item.Tags || []).slice(0, 4).join(', ');
    if (descriptors) {
      var desc = el('div', NS + '-maturity-desc');
      desc.textContent = descriptors;
      o.appendChild(desc);
    }

    document.body.appendChild(o);

    // Force a frame so the fade-in transition actually runs.
    raf(function () { o.classList.add(NS + '-maturity-in'); });

    setTimeout(function () {
      o.classList.remove(NS + '-maturity-in');
      setTimeout(function () { if (o.parentNode) { o.parentNode.removeChild(o); } }, 900);
    }, 5000);
  }

  function initRatingOverlay() {
    var pm = window.playbackManager || (window.Emby && window.Emby.playbackManager);
    var Ev = window.Events;

    if (pm && Ev && Ev.on) {
      try {
        Ev.on(pm, 'playbackstart', function () {
          var item = pm.currentItem ? pm.currentItem() : null;
          if (item) { showRatingOverlay(item); }
        });
        return;
      } catch (e) { /* fall through to the DOM fallback */ }
    }

    // Fallback: watch for a video element being added, then resolve the item.
    var seen = false;
    new MutationObserver(function () {
      var v = qs(document, '.videoPlayerContainer video, video');
      if (!v) { seen = false; return; }
      if (seen) { return; }
      seen = true;

      var id = null;
      try {
        var m = /[?&]id=([^&]+)/.exec(window.location.hash || '');
        if (m) { id = decodeURIComponent(m[1]); }
        if (!id && pm && pm.currentItem) { var ci = pm.currentItem(); id = ci && ci.Id; }
      } catch (e) { /* no id available */ }

      if (id) { fetchItem(id).then(showRatingOverlay).catch(function () {}); }
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* --------------------------------------------------------------- 6. wire */

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
