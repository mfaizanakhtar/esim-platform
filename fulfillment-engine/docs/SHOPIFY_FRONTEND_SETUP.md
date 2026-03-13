# Phase 2: Shopify Frontend Setup - Step-by-Step Guide

> **Document Type**: Feature  
> **Status**: ✅ Current  
> **Last Updated**: 2026-03-01  
> **Purpose**: Shopify theme frontend for usage tracking (Phase 2)

---

This guide provides complete instructions for implementing the eSIM usage tracking page in your Shopify theme.

---

## Prerequisites

- Access to Shopify Admin
- Access to Shopify theme code editor (or CLI)
- Your backend API URL (e.g., `https://your-backend.railway.app`)
- Basic knowledge of Shopify Liquid templates

---

## File Structure Overview

You'll create 3 new files in your Shopify theme:

```
themes/
└── your-theme/
    ├── templates/
    │   └── page.esim-usage.liquid          ← Main template
    ├── assets/
    │   ├── esim-usage.js                   ← JavaScript logic
    │   └── esim-usage.css                  ← Styles
    └── sections/ (optional)
        └── esim-usage-section.liquid       ← Reusable section (optional)
```

---

## Step 1: Create Liquid Template

### File: `templates/page.esim-usage.liquid`

**Location**: Shopify Admin → Online Store → Themes → [Your Theme] → Actions → Edit Code → Templates → Add a new template → Page → Name it `esim-usage`

**Complete Code**:

```liquid
{% comment %}
  eSIM Usage Tracking Page
  Template for displaying real-time data usage for customer eSIMs
  URL: /pages/my-esim-usage?iccid=XXXXX
{% endcomment %}

<div class="page-width">
  <div class="esim-usage-wrapper">
    {%- comment -%} Page Header {%- endcomment -%}
    <div class="esim-usage-header">
      <h1 class="esim-usage-title">{{ page.title | default: "My eSIM Usage" }}</h1>
      <p class="esim-usage-subtitle">Track your data usage in real-time</p>
    </div>

    {%- comment -%} Loading State {%- endcomment -%}
    <div id="esim-loading" class="esim-loading">
      <div class="esim-spinner"></div>
      <p>Loading your usage data...</p>
    </div>

    {%- comment -%} Error State {%- endcomment -%}
    <div id="esim-error" class="esim-error" style="display: none;">
      <div class="esim-error-icon">⚠️</div>
      <h2 class="esim-error-title">Unable to Load Usage Data</h2>
      <p class="esim-error-message" id="esim-error-message"></p>
      <div class="esim-error-actions">
        <button onclick="location.reload()" class="esim-button esim-button--primary">
          Try Again
        </button>
        <a href="{{ routes.root_url }}" class="esim-button esim-button--secondary">
          Back to Home
        </a>
      </div>
    </div>

    {%- comment -%} Usage Dashboard {%- endcomment -%}
    <div id="esim-dashboard" class="esim-dashboard" style="display: none;">
      
      {%- comment -%} eSIM Info Card {%- endcomment -%}
      <div class="esim-card esim-info-card">
        <h2 class="esim-card-title">eSIM Information</h2>
        <div class="esim-info-grid">
          <div class="esim-info-item">
            <span class="esim-info-label">ICCID</span>
            <span class="esim-info-value" id="esim-iccid">-</span>
          </div>
          <div class="esim-info-item">
            <span class="esim-info-label">Order Number</span>
            <span class="esim-info-value" id="esim-order-num">-</span>
          </div>
          <div class="esim-info-item">
            <span class="esim-info-label">Region</span>
            <span class="esim-info-value" id="esim-region">-</span>
          </div>
          <div class="esim-info-item">
            <span class="esim-info-label">Package</span>
            <span class="esim-info-value" id="esim-package-name">-</span>
          </div>
          <div class="esim-info-item">
            <span class="esim-info-label">Status</span>
            <span class="esim-status-badge" id="esim-status">-</span>
          </div>
        </div>
      </div>

      {%- comment -%} Data Usage Card {%- endcomment -%}
      <div class="esim-card esim-usage-card">
        <h2 class="esim-card-title">Data Usage</h2>
        
        {%- comment -%} Circular Progress {%- endcomment -%}
        <div class="esim-usage-visual">
          <div class="esim-circle-progress">
            <svg width="200" height="200" viewBox="0 0 200 200">
              <circle 
                cx="100" 
                cy="100" 
                r="80" 
                fill="none" 
                stroke="#e5e7eb" 
                stroke-width="12"
              />
              <circle 
                id="esim-progress-circle"
                cx="100" 
                cy="100" 
                r="80" 
                fill="none" 
                stroke="#3b82f6" 
                stroke-width="12"
                stroke-dasharray="502.65"
                stroke-dashoffset="502.65"
                transform="rotate(-90 100 100)"
                style="transition: stroke-dashoffset 1s ease;"
              />
            </svg>
            <div class="esim-circle-text">
              <div class="esim-circle-percent" id="esim-usage-percent">0%</div>
              <div class="esim-circle-label">Used</div>
            </div>
          </div>
        </div>

        {%- comment -%} Usage Stats {%- endcomment -%}
        <div class="esim-usage-stats">
          <div class="esim-stat">
            <span class="esim-stat-label">Total Data</span>
            <span class="esim-stat-value" id="esim-total-data">-</span>
          </div>
          <div class="esim-stat">
            <span class="esim-stat-label">Used</span>
            <span class="esim-stat-value esim-stat-value--used" id="esim-used-data">-</span>
          </div>
          <div class="esim-stat">
            <span class="esim-stat-label">Remaining</span>
            <span class="esim-stat-value esim-stat-value--remaining" id="esim-remaining-data">-</span>
          </div>
        </div>
      </div>

      {%- comment -%} Validity Card {%- endcomment -%}
      <div class="esim-card esim-validity-card">
        <h2 class="esim-card-title">Validity Period</h2>
        <div class="esim-validity-grid">
          <div class="esim-validity-item">
            <span class="esim-validity-icon">📅</span>
            <div>
              <div class="esim-validity-label">Duration</div>
              <div class="esim-validity-value" id="esim-days">-</div>
            </div>
          </div>
          <div class="esim-validity-item">
            <span class="esim-validity-icon">▶️</span>
            <div>
              <div class="esim-validity-label">Start Date</div>
              <div class="esim-validity-value" id="esim-start-date">Not activated</div>
            </div>
          </div>
          <div class="esim-validity-item">
            <span class="esim-validity-icon">⏹️</span>
            <div>
              <div class="esim-validity-label">End Date</div>
              <div class="esim-validity-value" id="esim-end-date">-</div>
            </div>
          </div>
        </div>
      </div>

      {%- comment -%} Help Section 
      <div class="esim-card esim-help-card">
        <h2 class="esim-card-title">Need Help?</h2>
        <p>If you have questions about your eSIM or need assistance, please contact our support team.</p>
        <div class="esim-help-actions">
          <a href="{{ routes.root_url }}/pages/contact" class="esim-button esim-button--secondary">
            Contact Support
          </a>
          <a href="{{ routes.root_url }}/pages/esim-help" class="esim-button esim-button--secondary">
            eSIM Help Guide
          </a>
        </div>
      </div>
      {%- endcomment -%}

      {%- comment -%} Refresh Button {%- endcomment -%}
      <div class="esim-actions">
        <button onclick="window.loadEsimUsage()" class="esim-button esim-button--refresh">
          Refresh Usage Data
        </button>
        <p class="esim-refresh-note">Data updates automatically every 5 minutes</p>
      </div>

    </div>
  </div>
</div>

{%- comment -%} Include JavaScript and CSS {%- endcomment -%}
{{ 'esim-usage.css' | asset_url | stylesheet_tag }}

<script>
  // Pass backend API URL to JavaScript
  // IMPORTANT: Replace this URL with your actual backend URL
  window.ESIM_API_BASE = 'https://esim-api-production-a56a.up.railway.app';
  window.ESIM_ICCID = new URLSearchParams(window.location.search).get('iccid');
</script>

{{ 'esim-usage.js' | asset_url | script_tag }}
```

---

## Step 2: Create JavaScript File

### File: `assets/esim-usage.js`

**Location**: Shopify Admin → Online Store → Themes → [Your Theme] → Actions → Edit Code → Assets → Add a new asset → Create a blank file → Name it `esim-usage.js`

**Complete Code**:

```javascript
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
```

---

## Step 3: Create CSS File

### File: `assets/esim-usage.css`

**Location**: Shopify Admin → Online Store → Themes → [Your Theme] → Actions → Edit Code → Assets → Add a new asset → Create a blank file → Name it `esim-usage.css`

**Complete Code**:

```css
/**
 * eSIM Usage Tracking - Styles
 * Mobile-first responsive design
 */

/* Container */
.esim-usage-wrapper {
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px;
}

/* Header */
.esim-usage-header {
  text-align: center;
  margin-bottom: 40px;
}

.esim-usage-title {
  font-size: 2rem;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 8px;
}

.esim-usage-subtitle {
  font-size: 1rem;
  color: #6b7280;
  margin: 0;
}

/* Loading State */
.esim-loading {
  text-align: center;
  padding: 60px 20px;
}

.esim-spinner {
  width: 50px;
  height: 50px;
  margin: 0 auto 20px;
  border: 4px solid #e5e7eb;
  border-top-color: #3b82f6;
  border-radius: 50%;
  animation: esim-spin 1s linear infinite;
}

@keyframes esim-spin {
  to { transform: rotate(360deg); }
}

.esim-loading p {
  color: #6b7280;
  font-size: 1rem;
}

/* Error State */
.esim-error {
  text-align: center;
  padding: 60px 20px;
  background: #fef2f2;
  border-radius: 12px;
  border: 2px solid #fee2e2;
}

.esim-error-icon {
  font-size: 3rem;
  margin-bottom: 16px;
}

.esim-error-title {
  font-size: 1.5rem;
  font-weight: 600;
  color: #991b1b;
  margin-bottom: 12px;
}

.esim-error-message {
  color: #7f1d1d;
  font-size: 1rem;
  margin-bottom: 24px;
}

.esim-error-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  flex-wrap: wrap;
}

/* Dashboard Layout */
.esim-dashboard {
  display: grid;
  grid-template-columns: 1fr;
  gap: 24px;
}

@media (min-width: 768px) {
  .esim-dashboard {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (min-width: 1024px) {
  .esim-dashboard {
    grid-template-columns: repeat(3, 1fr);
  }
  
  .esim-usage-card {
    grid-column: span 2;
  }
}

/* Cards */
.esim-card {
  background: white;
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  border: 1px solid #e5e7eb;
}

.esim-card-title {
  font-size: 1.25rem;
  font-weight: 600;
  color: #1f2937;
  margin: 0 0 20px 0;
}

/* Info Card */
.esim-info-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}

@media (min-width: 640px) {
  .esim-info-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

.esim-info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.esim-info-label {
  font-size: 0.875rem;
  color: #6b7280;
  font-weight: 500;
}

.esim-info-value {
  font-size: 1rem;
  color: #1f2937;
  font-weight: 600;
  word-break: break-all;
}

/* Status Badges */
.esim-badge {
  display: inline-block;
  padding: 4px 12px;
  border-radius: 9999px;
  font-size: 0.875rem;
  font-weight: 600;
}

.esim-badge--success {
  background: #d1fae5;
  color: #065f46;
}

.esim-badge--warning {
  background: #fef3c7;
  color: #92400e;
}

.esim-badge--error {
  background: #fee2e2;
  color: #991b1b;
}

.esim-badge--neutral {
  background: #e5e7eb;
  color: #374151;
}

/* Usage Card */
.esim-usage-visual {
  display: flex;
  justify-content: center;
  margin-bottom: 32px;
}

.esim-circle-progress {
  position: relative;
  width: 200px;
  height: 200px;
}

.esim-circle-text {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  text-align: center;
}

.esim-circle-percent {
  font-size: 2.5rem;
  font-weight: 700;
  color: #1f2937;
  line-height: 1;
}

.esim-circle-label {
  font-size: 1rem;
  color: #6b7280;
  margin-top: 4px;
}

.esim-usage-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  padding-top: 24px;
  border-top: 1px solid #e5e7eb;
}

.esim-stat {
  text-align: center;
}

.esim-stat-label {
  display: block;
  font-size: 0.875rem;
  color: #6b7280;
  margin-bottom: 8px;
}

.esim-stat-value {
  display: block;
  font-size: 1.125rem;
  font-weight: 700;
  color: #1f2937;
}

.esim-stat-value--used {
  color: #3b82f6;
}

.esim-stat-value--remaining {
  color: #10b981;
}

/* Validity Card */
.esim-validity-grid {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.esim-validity-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: #f9fafb;
  border-radius: 8px;
}

.esim-validity-icon {
  font-size: 1.5rem;
}

.esim-validity-label {
  font-size: 0.875rem;
  color: #6b7280;
  margin-bottom: 4px;
}

.esim-validity-value {
  font-size: 1rem;
  font-weight: 600;
  color: #1f2937;
}

/* Help Card */
.esim-help-card p {
  color: #6b7280;
  margin-bottom: 20px;
  line-height: 1.6;
}

.esim-help-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

/* Buttons */
.esim-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 24px;
  font-size: 1rem;
  font-weight: 600;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  text-decoration: none;
  transition: all 0.2s;
}

.esim-button--primary {
  background: #1a1f71;
  color: white;
}

.esim-button--primary:hover {
  background: #13165a;
}

.esim-button--secondary {
  background: white;
  color: #374151;
  border: 1px solid #d1d5db;
}

.esim-button--secondary:hover {
  background: #f9fafb;
}

.esim-button--refresh {
  background: #1a1f71;
  color: white;
  width: 100%;
}

.esim-button--refresh:hover {
  background: #13165a;
}

/* Actions Section */
.esim-actions {
  grid-column: 1 / -1;
  text-align: center;
  padding-top: 20px;
}

.esim-refresh-note {
  margin-top: 12px;
  font-size: 0.875rem;
  color: #6b7280;
}

/* Mobile Optimizations */
@media (max-width: 640px) {
  .esim-usage-title {
    font-size: 1.5rem;
  }
  
  .esim-card {
    padding: 16px;
  }
  
  .esim-card-title {
    font-size: 1.125rem;
  }
  
  .esim-circle-progress {
    width: 160px;
    height: 160px;
  }
  
  .esim-circle-progress svg {
    width: 160px;
    height: 160px;
  }
  
  .esim-circle-percent {
    font-size: 2rem;
  }
  
  .esim-usage-stats {
    gap: 12px;
  }
  
  .esim-stat-value {
    font-size: 1rem;
  }
}
```

---

## Step 4: Create Page in Shopify Admin

### Navigation Path:
**Shopify Admin → Online Store → Pages → Add page**

### Configuration:

1. **Title**: `My eSIM Usage`

2. **Content**: Add a simple message (optional):
   ```
   Track your eSIM data usage in real-time. 
   If you were redirected here from your delivery email, your usage data should appear automatically.
   ```

3. **Template**: Select `page.esim-usage` from dropdown

4. **SEO Settings** (optional but recommended):
   - **Page title**: `Track Your eSIM Data Usage`
   - **Description**: `Monitor your eSIM data usage in real-time with our usage tracking dashboard`
   - **URL handle**: `my-esim-usage` (this creates `/pages/my-esim-usage`)

5. **Visibility**: 
   - ✅ Visible (customers can access with link)
   - Or Hidden (only accessible via direct link - more secure)

6. **Save** the page

---

## Step 5: Configure Backend API URL

### Update the Template Directly

Since page templates don't support theme settings, you need to hardcode your backend URL.

**Edit** `templates/page.esim-usage.liquid`, find this line around line 175:

```liquid
window.ESIM_API_BASE = 'https://your-backend.railway.app';
```

**Replace with your actual backend URL**:

```liquid
window.ESIM_API_BASE = 'https://your-actual-backend.railway.app';
```

**Important**: 
- No trailing slash
- Must be HTTPS (not HTTP)
- Example: `https://esim-backend-production.up.railway.app`

---

## Step 6: Test the Integration

### Test 1: Access the Page

1. Visit: `https://your-store.myshopify.com/pages/my-esim-usage`
2. You should see an error: "Invalid or missing ICCID"
3. ✅ This is expected (page works, just needs ICCID)

### Test 2: Test with Real ICCID

1. Get a real ICCID from your database or test order
2. Visit: `https://your-store.myshopify.com/pages/my-esim-usage?iccid=898520302104156254`
3. Should show loading → then dashboard with usage data
4. ✅ Data should display correctly

### Test 3: Test CORS

1. Open browser DevTools (F12) → Console
2. Check for CORS errors
3. ✅ No errors should appear

### Test 4: Test Error Handling

1. Visit with invalid ICCID: `?iccid=1234567890`
2. Should show friendly error message
3. ✅ "eSIM not found" error displays

### Test 5: Mobile Responsive

1. Open DevTools → Toggle device toolbar
2. Test on various screen sizes
3. ✅ Layout adapts correctly

---

## Step 7: Update Delivery Email

Now update your email template to include the usage tracking link.

### File: `src/emails/esim-delivery.html` (in your backend repo)

Add this button/section:

```html
<!-- Usage Tracking Section -->
<div style="margin: 30px 0; padding: 20px; background: #f0f9ff; border-radius: 8px;">
  <h2 style="margin: 0 0 12px 0; color: #1e40af;">📊 Track Your Data Usage</h2>
  <p style="margin: 0 0 16px 0; color: #374151;">
    Monitor your eSIM data usage in real-time with our usage tracking dashboard.
  </p>
  <a href="https://your-store.myshopify.com/pages/my-esim-usage?iccid={{iccid}}" 
     style="display: inline-block; padding: 12px 24px; background: #3b82f6; color: white; text-decoration: none; border-radius: 6px; font-weight: 600;">
    View My Usage Dashboard
  </a>
  <p style="margin: 16px 0 0 0; font-size: 0.875rem; color: #6b7280;">
    Bookmark this link to check your usage anytime.
  </p>
</div>
```

Make sure `{{iccid}}` is available in your email template context.

---

## Troubleshooting

### Issue: CORS Error in Browser Console

**Error**: `Access to fetch at '...' from origin '...' has been blocked by CORS policy`

**Solution**:
1. Verify backend CORS is configured for your Shopify domain
2. Check `SHOPIFY_SHOP_DOMAIN` environment variable in backend
3. Restart backend server after changing CORS config

### Issue: "Failed to fetch" Error

**Error**: `Unable to connect to server`

**Solution**:
1. Verify backend API URL is correct in theme settings
2. Check backend is running: `curl https://your-backend.railway.app/health`
3. Verify SSL certificate is valid (HTTPS required)

### Issue: Page Shows HTML Code Instead of Rendering

**Error**: Liquid code visible on page

**Solution**:
1. Ensure template file is saved as `.liquid` not `.html`
2. Template must be in `templates/` folder
3. Page must be assigned the correct template in Admin

### Issue: JavaScript Not Loading

**Error**: Dashboard doesn't appear, stuck on loading

**Solution**:
1. Check browser console for JavaScript errors
2. Verify `esim-usage.js` uploaded to `assets/` folder
3. Clear browser cache and hard refresh (Ctrl+Shift+R)
4. Check file name matches exactly: `esim-usage.js`

### Issue: Styles Not Applied

**Error**: Page renders but looks unstyled

**Solution**:
1. Verify `esim-usage.css` uploaded to `assets/` folder
2. Check Liquid includes CSS: `{{ 'esim-usage.css' | asset_url | stylesheet_tag }}`
3. Clear Shopify theme cache: Edit code → Save without changes
4. Hard refresh browser

### Issue: Can't Find ICCID

**Error**: "Invalid or missing ICCID"

**Solution**:
1. Verify URL contains `?iccid=` parameter
2. ICCID must be 15-20 digits
3. Check backend logs for actual ICCID format
4. Test with: `?iccid=898520302104156254` (example from tests)

---

## Checklist

Before going live:

- [ ] All 3 files created (Liquid, JS, CSS)
- [ ] Page created in Shopify Admin
- [ ] Template assigned to page
- [ ] Backend API URL configured
- [ ] Test with real ICCID - shows data
- [ ] Test with fake ICCID - shows error
- [ ] Mobile responsive checked
- [ ] CORS working (no console errors)
- [ ] Delivery email updated with link
- [ ] Help/support links work
- [ ] SSL certificate valid (HTTPS)
- [ ] Backend rate limiting tested

---

## Next Steps: Phase 3

Once Phase 2 is complete and tested:

1. **Email Integration**: Update delivery email template
2. **Testing**: Place real test order and verify full flow
3. **Monitoring**: Watch for errors in backend logs
4. **Optimization**: Add Redis cache if needed
5. **Enhancements**: Add features like usage alerts

---

## Support Links

**Backend Documentation**: `docs/SHOPIFY_USAGE_INTEGRATION.md`  
**Shopify Liquid Docs**: https://shopify.dev/docs/themes/liquid  
**Fastify CORS**: https://github.com/fastify/fastify-cors  

---

## Quick Reference

**Page URL Format**:
```
https://your-store.myshopify.com/pages/my-esim-usage?iccid=XXXXX
```

**API Endpoint**:
```
GET https://your-backend.railway.app/api/esim/:iccid/usage
```

**Template Files**:
```
templates/page.esim-usage.liquid
assets/esim-usage.js
assets/esim-usage.css
```
