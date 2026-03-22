/**
 * eSIM Usage Tracking - Frontend JavaScript
 * Fetches and displays real-time usage data from backend API
 */

(function() {
  'use strict';

  // Configuration
  const API_BASE = window.ESIM_API_BASE || 'https://your-backend.railway.app';
  const ICCID = window.ESIM_ICCID;
  const AUTO_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
  
  // DOM Elements
  const elements = {
    loading: document.getElementById('esim-loading'),
    error: document.getElementById('esim-error'),
    errorMessage: document.getElementById('esim-error-message'),
    dashboard: document.getElementById('esim-dashboard'),
    
    // Info
    iccid: document.getElementById('esim-iccid'),
    orderNum: document.getElementById('esim-order-num'),
    region: document.getElementById('esim-region'),
    packageName: document.getElementById('esim-package-name'),
    status: document.getElementById('esim-status'),
    
    // Usage
    progressCircle: document.getElementById('esim-progress-circle'),
    usagePercent: document.getElementById('esim-usage-percent'),
    totalData: document.getElementById('esim-total-data'),
    usedData: document.getElementById('esim-used-data'),
    remainingData: document.getElementById('esim-remaining-data'),
    
    // Validity
    days: document.getElementById('esim-days'),
    startDate: document.getElementById('esim-start-date'),
    endDate: document.getElementById('esim-end-date'),
  };

  /**
   * Format data size with units
   */
  function formatDataSize(mb) {
    if (mb >= 1024) {
      return `${(mb / 1024).toFixed(2)} GB`;
    }
    return `${mb} MB`;
  }

  /**
   * Format date string
   */
  function formatDate(dateString) {
    if (!dateString || dateString === 'null') {
      return 'Not activated';
    }
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch (e) {
      return dateString;
    }
  }

  /**
   * Get status badge HTML
   */
  function getStatusBadge(status) {
    const badges = {
      0: '<span class="esim-badge esim-badge--success">Active</span>',
      1: '<span class="esim-badge esim-badge--warning">Pending</span>',
      2: '<span class="esim-badge esim-badge--error">Expired</span>',
    };
    return badges[status] || '<span class="esim-badge esim-badge--neutral">Unknown</span>';
  }

  /**
   * Update circular progress indicator
   */
  function updateProgressCircle(percent) {
    const circle = elements.progressCircle;
    const circumference = 2 * Math.PI * 80; // 2πr where r=80
    const offset = circumference - (percent / 100) * circumference;
    
    circle.style.strokeDashoffset = offset;
    
    // Change color based on usage
    if (percent >= 90) {
      circle.style.stroke = '#ef4444'; // Red
    } else if (percent >= 75) {
      circle.style.stroke = '#f59e0b'; // Orange
    } else {
      circle.style.stroke = '#3b82f6'; // Blue
    }
  }

  /**
   * Show error state
   */
  function showError(message) {
    elements.loading.style.display = 'none';
    elements.dashboard.style.display = 'none';
    elements.error.style.display = 'block';
    elements.errorMessage.textContent = message;
  }

  /**
   * Show loading state
   */
  function showLoading() {
    elements.loading.style.display = 'block';
    elements.dashboard.style.display = 'none';
    elements.error.style.display = 'none';
  }

  /**
   * Show dashboard with data
   */
  function showDashboard(data) {
    // Update eSIM Info
    elements.iccid.textContent = data.iccid || '-';
    elements.orderNum.textContent = data.orderNum || '-';
    elements.region.textContent = data.region || '-';
    elements.packageName.textContent = data.packageName || '-';
    elements.status.innerHTML = getStatusBadge(data.status);

    // Update Usage
    const usagePercent = data.usage.usagePercent || 0;
    elements.usagePercent.textContent = `${Math.round(usagePercent)}%`;
    elements.totalData.textContent = `${data.usage.total} ${data.usage.unit}`;
    elements.usedData.textContent = formatDataSize(data.usage.usedMb);
    elements.remainingData.textContent = formatDataSize(data.usage.remainingMb);
    
    updateProgressCircle(usagePercent);

    // Update Validity
    elements.days.textContent = `${data.validity.days} days`;
    elements.startDate.textContent = formatDate(data.validity.beginDate);
    elements.endDate.textContent = formatDate(data.validity.endDate);

    // Show dashboard
    elements.loading.style.display = 'none';
    elements.error.style.display = 'none';
    elements.dashboard.style.display = 'block';
  }

  /**
   * Fetch usage data from API
   */
  async function fetchUsageData(iccid) {
    const url = `${API_BASE}/api/esim/${iccid}/usage`;
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
        // Enable CORS credentials if needed
        credentials: 'omit',
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('eSIM not found. Please check your link and try again.');
        } else if (response.status === 429) {
          throw new Error('Too many requests. Please wait a moment and try again.');
        } else {
          throw new Error(`Failed to load usage data (Error ${response.status})`);
        }
      }

      const data = await response.json();
      return data;
      
    } catch (error) {
      // Network or parsing error
      if (error.message.includes('Failed to fetch')) {
        throw new Error('Unable to connect to server. Please check your internet connection.');
      }
      throw error;
    }
  }

  /**
   * Main load function
   */
  async function loadEsimUsage() {
    // Validate ICCID
    if (!ICCID || ICCID.length < 15) {
      showError('Invalid or missing ICCID. Please check your link.');
      return;
    }

    showLoading();

    try {
      const data = await fetchUsageData(ICCID);
      showDashboard(data);
      
      // Schedule next auto-refresh
      setTimeout(loadEsimUsage, AUTO_REFRESH_INTERVAL);
      
    } catch (error) {
      console.error('eSIM Usage Error:', error);
      showError(error.message || 'An unexpected error occurred. Please try again.');
    }
  }

  // Expose to global scope for manual refresh
  window.loadEsimUsage = loadEsimUsage;

  // Initialize on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadEsimUsage);
  } else {
    loadEsimUsage();
  }

})();