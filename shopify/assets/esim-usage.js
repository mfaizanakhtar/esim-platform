/**
 * eSIM Usage Tracking
 * Supports ICCID, order number, or email search via GET /api/esim/usage?q=
 * Auto-submits when ?iccid= or ?q= URL param is present (email link flow).
 */

(function () {
  'use strict';

  var API_BASE = window.ESIM_API_BASE || 'https://your-backend.railway.app';
  var AUTO_REFRESH = 5 * 60 * 1000;
  var refreshTimer = null;
  var currentQuery = null;

  // ── DOM refs ──────────────────────────────────────────────────────────────

  var searchForm = document.getElementById('esim-search-form');
  var searchInput = document.getElementById('esim-query');
  var submitBtn = document.getElementById('esim-submit');
  var notFound = document.getElementById('esim-not-found');
  var loadingEl = document.getElementById('esim-loading');
  var errorEl = document.getElementById('esim-error');
  var errorMsg = document.getElementById('esim-error-message');
  var dashboard = document.getElementById('esim-dashboard');
  var multiResults = document.getElementById('esim-multi-results');
  var refreshBtn = document.getElementById('esim-refresh-btn');

  // Single-result elements
  var els = {
    iccid: document.getElementById('esim-iccid'),
    orderNum: document.getElementById('esim-order-num'),
    regionItem: document.getElementById('esim-region-item'),
    region: document.getElementById('esim-region'),
    packageItem: document.getElementById('esim-package-item'),
    packageName: document.getElementById('esim-package-name'),
    statusItem: document.getElementById('esim-status-item'),
    status: document.getElementById('esim-status'),
    vendorItem: document.getElementById('esim-vendor-item'),
    vendorOrder: document.getElementById('esim-vendor-order'),
    // FiRoam
    firoamVisual: document.getElementById('esim-firoam-visual'),
    firoamStats: document.getElementById('esim-firoam-stats'),
    progressCircle: document.getElementById('esim-progress-circle'),
    usagePercent: document.getElementById('esim-usage-percent'),
    totalData: document.getElementById('esim-total-data'),
    usedData: document.getElementById('esim-used-data'),
    remainingData: document.getElementById('esim-remaining-data'),
    // TGT
    tgtStats: document.getElementById('esim-tgt-stats'),
    tgtTotal: document.getElementById('esim-tgt-total'),
    tgtUsed: document.getElementById('esim-tgt-used'),
    tgtResidual: document.getElementById('esim-tgt-residual'),
    // Validity
    validityCard: document.getElementById('esim-validity-card'),
    days: document.getElementById('esim-days'),
    startDate: document.getElementById('esim-start-date'),
    endDate: document.getElementById('esim-end-date'),
  };

  // ── Init ──────────────────────────────────────────────────────────────────

  var params = new URLSearchParams(window.location.search);
  var autoQuery = params.get('iccid') || params.get('q');

  if (autoQuery) {
    searchInput.value = autoQuery;
    doSearch(autoQuery);
  }

  searchForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = searchInput.value.trim();
    if (q) doSearch(q);
  });

  refreshBtn.addEventListener('click', function () {
    if (currentQuery) doSearch(currentQuery);
  });

  // ── Search ────────────────────────────────────────────────────────────────

  function doSearch(q) {
    currentQuery = q;
    clearTimeout(refreshTimer);
    setLoading(true);
    hideAll();
    loadingEl.style.display = 'block';

    fetch(API_BASE + '/api/esim/usage?q=' + encodeURIComponent(q))
      .then(function (res) {
        return res.json().then(function (body) {
          return { status: res.status, body: body };
        });
      })
      .then(function (r) {
        setLoading(false);
        hideAll();

        if (r.status === 404) {
          notFound.style.display = 'block';
          return;
        }
        if (r.status !== 200) {
          showError('Unexpected error (' + r.status + '). Please try again.');
          return;
        }

        var body = r.body;
        if (body.results && Array.isArray(body.results)) {
          if (body.results.length === 0) {
            notFound.style.display = 'block';
          } else {
            renderMulti(body.results);
          }
        } else {
          renderSingle(body);
          refreshTimer = setTimeout(function () {
            doSearch(currentQuery);
          }, AUTO_REFRESH);
        }
      })
      .catch(function () {
        setLoading(false);
        hideAll();
        showError('Unable to connect to server. Please check your connection.');
      });
  }

  // ── Single result ─────────────────────────────────────────────────────────

  function renderSingle(data) {
    var isFiroam = data.provider === 'firoam' || (!data.provider && data.usage && data.usage.usedMb != null);

    // Info card
    els.iccid.textContent = data.iccid || '—';
    els.orderNum.textContent = data.orderNum || '—';

    if (data.region) {
      els.region.textContent = data.region;
      els.regionItem.style.display = '';
    } else {
      els.regionItem.style.display = 'none';
    }

    if (data.packageName) {
      els.packageName.textContent = data.packageName;
      els.packageItem.style.display = '';
    } else {
      els.packageItem.style.display = 'none';
    }

    if (data.status != null) {
      els.status.innerHTML = statusBadge(data.status);
      els.statusItem.style.display = '';
    } else {
      els.statusItem.style.display = 'none';
    }

    if (data.vendorOrderNo) {
      els.vendorOrder.textContent = data.vendorOrderNo;
      els.vendorItem.style.display = '';
    } else {
      els.vendorItem.style.display = 'none';
    }

    // Usage
    if (isFiroam) {
      renderFiroamUsage(data.usage);
      els.firoamVisual.style.display = '';
      els.firoamStats.style.display = '';
      els.tgtStats.style.display = 'none';
      renderValidity(data.validity);
      els.validityCard.style.display = '';
    } else {
      renderTgtUsage(data.usage);
      els.firoamVisual.style.display = 'none';
      els.firoamStats.style.display = 'none';
      els.tgtStats.style.display = '';
      els.validityCard.style.display = 'none';
    }

    dashboard.style.display = 'grid';
  }

  function renderFiroamUsage(usage) {
    if (!usage) return;
    var pct = Math.min(100, Math.max(0, usage.usagePercent || 0));
    var circumference = 502.65;
    var offset = circumference - (pct / 100) * circumference;
    els.progressCircle.style.strokeDashoffset = offset;
    els.progressCircle.style.stroke = pct >= 90 ? '#ef4444' : pct >= 75 ? '#f59e0b' : '#3b82f6';
    els.usagePercent.textContent = Math.round(pct) + '%';
    els.totalData.textContent = formatMb(usage.totalMb != null ? usage.totalMb : 0);
    els.usedData.textContent = formatMb(usage.usedMb != null ? usage.usedMb : 0);
    els.remainingData.textContent = formatMb(usage.remainingMb != null ? usage.remainingMb : 0);
  }

  function renderTgtUsage(usage) {
    if (!usage) return;
    els.tgtTotal.textContent = usage.dataTotal != null ? String(usage.dataTotal) : '—';
    els.tgtUsed.textContent = usage.dataUsage != null ? String(usage.dataUsage) : '—';
    els.tgtResidual.textContent = usage.dataResidual != null ? String(usage.dataResidual) : '—';
  }

  function renderValidity(validity) {
    if (!validity) {
      els.days.textContent = '—';
      els.startDate.textContent = 'Not activated';
      els.endDate.textContent = '—';
      return;
    }
    els.days.textContent = validity.days ? validity.days + ' days' : '—';
    els.startDate.textContent = formatDate(validity.beginDate);
    els.endDate.textContent = formatDate(validity.endDate);
  }

  // ── Multi-result (email search) ───────────────────────────────────────────

  function renderMulti(results) {
    var html = '<div class="esim-multi-header"><h2>Found ' + results.length + ' eSIM' + (results.length > 1 ? 's' : '') + '</h2></div>';
    html += '<div class="esim-multi-grid">';
    results.forEach(function (data) {
      html += renderMiniCard(data);
    });
    html += '</div>';
    multiResults.innerHTML = html;
    multiResults.style.display = 'block';
  }

  function renderMiniCard(data) {
    var isFiroam = data.provider === 'firoam' || (!data.provider && data.usage && data.usage.usedMb != null);
    var html = '<div class="esim-card esim-mini-card">';
    html += '<div class="esim-mini-order">Order ' + esc(data.orderNum || '—') + '</div>';
    html += '<div class="esim-mini-iccid">' + esc(data.iccid || '—') + '</div>';

    if (isFiroam && data.usage) {
      var pct = Math.min(100, Math.max(0, data.usage.usagePercent || 0));
      html += '<div class="esim-mini-bar">';
      html += '<div class="esim-mini-bar-track"><div class="esim-mini-bar-fill" style="width:' + pct + '%;background:' + (pct >= 90 ? '#ef4444' : pct >= 75 ? '#f59e0b' : '#3b82f6') + '"></div></div>';
      html += '<div class="esim-mini-bar-label">' + formatMb(data.usage.usedMb || 0) + ' of ' + formatMb(data.usage.totalMb || 0) + ' (' + Math.round(pct) + '%)</div>';
      html += '</div>';
      if (data.region) html += '<div class="esim-mini-meta">' + esc(data.region) + '</div>';
    } else if (data.usage) {
      if (data.usage.dataUsage != null) html += '<div class="esim-mini-meta">Used: ' + esc(String(data.usage.dataUsage)) + '</div>';
      if (data.usage.dataResidual != null) html += '<div class="esim-mini-meta">Remaining: ' + esc(String(data.usage.dataResidual)) + '</div>';
    }

    html += '<button class="esim-button esim-button--secondary esim-mini-btn" onclick="window._esimView(' + JSON.stringify(data) + ')">View Details</button>';
    html += '</div>';
    return html;
  }

  window._esimView = function (data) {
    hideAll();
    renderSingle(data);
    currentQuery = data.iccid || currentQuery;
    refreshTimer = setTimeout(function () { doSearch(currentQuery); }, AUTO_REFRESH);
  };

  // ── Helpers ───────────────────────────────────────────────────────────────

  function hideAll() {
    notFound.style.display = 'none';
    loadingEl.style.display = 'none';
    errorEl.style.display = 'none';
    dashboard.style.display = 'none';
    multiResults.style.display = 'none';
  }

  function setLoading(on) {
    submitBtn.disabled = on;
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorEl.style.display = 'block';
  }

  function formatMb(mb) {
    if (mb == null) return '—';
    if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
    return mb + ' MB';
  }

  function formatDate(str) {
    if (!str || str === 'null') return 'Not activated';
    try {
      return new Date(str).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
      return str;
    }
  }

  function statusBadge(status) {
    var map = {
      0: '<span class="esim-badge esim-badge--success">Active</span>',
      1: '<span class="esim-badge esim-badge--warning">Pending</span>',
      2: '<span class="esim-badge esim-badge--error">Expired</span>',
    };
    return map[status] || '<span class="esim-badge esim-badge--neutral">Unknown</span>';
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
