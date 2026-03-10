# Email Usage Tracking Update

> **Document Type**: Feature  
> **Status**: ✅ Current  
> **Last Updated**: 2026-03-01  
> **Purpose**: Usage tracking links in delivery emails

---

## Overview
Updated the eSIM delivery email template to include a direct link to the customer usage tracking page.

## Changes Made

### 1. HTML Email Template
Added a new prominent section between eSIM details and installation QR code:

**Visual Design:**
- Blue gradient background (light blue shades)
- Large heading: "📊 Track Your Data Usage"
- Blue CTA button: "📈 View My Usage Dashboard"
- Link format: `https://fluxyfi.com/pages/my-esim-usage?iccid={ICCID}`

**Styling:**
- Gradient background: `#e0f2fe` to `#dbeafe`
- Blue border: `#3b82f6`
- Button color: `#3b82f6` with shadow effect
- Responsive design compatible with all email clients

**Content:**
```html
<div style="background: linear-gradient(135deg, #e0f2fe 0%, #dbeafe 100%); padding: 25px; border-radius: 12px; margin: 25px 0; border: 2px solid #3b82f6;">
  <h2>📊 Track Your Data Usage</h2>
  <p>Monitor your eSIM data usage in real-time and check remaining balance.</p>
  <a href="https://fluxyfi.com/pages/my-esim-usage?iccid={ICCID}">
    📈 View My Usage Dashboard
  </a>
  <p><em>Check your remaining data, usage history, and validity period</em></p>
</div>
```

### 2. Plain Text Email Template
Added tracking section with direct URL:

```
📊 TRACK YOUR DATA USAGE
Monitor your eSIM data usage in real-time:
https://fluxyfi.com/pages/my-esim-usage?iccid={ICCID}

Check your remaining data, usage history, and validity period.
```

## Email Flow

1. **Customer completes purchase** → Shopify order created
2. **Backend provisions eSIM** → FiRoam API call
3. **Email sent** → Contains:
   - eSIM details (region, data, validity)
   - **NEW: Usage tracking link** ← Customer clicks here
   - QR code for installation
   - Installation instructions
4. **Customer lands on usage page** → Real-time data displayed

## Link Format

```
https://fluxyfi.com/pages/my-esim-usage?iccid={ICCID}
```

Example:
```
https://fluxyfi.com/pages/my-esim-usage?iccid=8948010010006928716
```

## Customer Experience

### Email Receipt
- Customer receives delivery email immediately after purchase
- Email contains prominent blue section: "Track Your Data Usage"
- Single click takes them directly to their usage dashboard

### Usage Dashboard (Phase 2 - Shopify Frontend)
Shows:
- ICCID
- Shopify Order Number (e.g., #1001)
- Region/Country
- Package Name
- Data Usage (MB/GB used, remaining, percentage)
- Validity Period (start/end dates, days remaining)
- Status (Active/Expired/etc.)

## Testing Checklist

- [ ] Email renders correctly in Gmail
- [ ] Email renders correctly in Outlook
- [ ] Email renders correctly in Apple Mail
- [ ] Email renders correctly on mobile devices
- [ ] Link is clickable and properly formatted
- [ ] ICCID is correctly inserted into URL
- [ ] Plain text version includes working URL
- [ ] Usage page loads with correct data (after Phase 2)

## Next Steps

### Immediate (Backend)
1. ✅ Email template updated
2. ✅ Build verification passed
3. ⏳ Deploy to Railway
4. ⏳ Add `SHOPIFY_SHOP_DOMAIN=fluxyfi-com.myshopify.com` to Railway env

### Phase 2 (Shopify Frontend - User Task)
1. Follow guide in `docs/SHOPIFY_FRONTEND_SETUP.md`
2. Create page template: `templates/page.esim-usage.liquid`
3. Upload JavaScript: `assets/esim-usage.js`
4. Upload CSS: `assets/esim-usage.css`
5. Create page in Shopify Admin with URL: `/pages/my-esim-usage`
6. Test end-to-end flow

## Files Modified

- `/src/services/email.ts` - Added usage tracking section to both HTML and plain text email templates

## Related Documentation

- [SHOPIFY_USAGE_INTEGRATION.md](./SHOPIFY_USAGE_INTEGRATION.md) - Backend API integration (Phase 1)
- [SHOPIFY_FRONTEND_SETUP.md](./SHOPIFY_FRONTEND_SETUP.md) - Shopify frontend setup (Phase 2)
- [AGENTS.md](../AGENTS.md) - Overall architecture and requirements

## Example Email Preview

```
┌─────────────────────────────────────────────┐
│ 🎉 Your eSIM is Ready!                      │
│ Order #1001                                 │
├─────────────────────────────────────────────┤
│                                             │
│ 📱 eSIM Details                             │
│ Region: United States                       │
│ Data: 5GB                                   │
│ Validity: 30 days                           │
│                                             │
├─────────────────────────────────────────────┤
│                                             │
│ 📊 Track Your Data Usage                   │ ← NEW!
│ Monitor your eSIM data usage in real-time   │
│                                             │
│  [📈 View My Usage Dashboard]              │
│                                             │
│ Check your remaining data, usage history    │
├─────────────────────────────────────────────┤
│                                             │
│ 📲 Install Your eSIM                        │
│ [QR Code Image]                             │
│ ...installation instructions...             │
└─────────────────────────────────────────────┘
```

## Success Metrics

- Customer can access usage dashboard within 1 click from email
- Usage data refreshes automatically every 5 minutes
- Mobile-friendly design works on all devices
- Clear visual hierarchy guides customer to important actions
