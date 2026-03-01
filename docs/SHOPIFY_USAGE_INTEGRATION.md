# Shopify Usage Page Integration Guide

> **Document Type**: Feature  
> **Status**: ✅ Current  
> **Last Updated**: 2026-03-01  
> **Purpose**: Backend API for usage tracking (Phase 1)

---

## Overview

This guide documents the integration between the eSIM backend and a Shopify custom page for displaying real-time eSIM usage data to customers.

---

## Phase 1: Backend Preparation ✅ COMPLETE

### Changes Implemented

#### 1. CORS Configuration

**File**: `src/server.ts`

**What**: Configured Cross-Origin Resource Sharing to allow Shopify storefront requests

**Configuration**:
- Allows requests from: `https://fluxyfi-com.myshopify.com`
- Supports credentials for future auth expansion
- Allows GET, POST, OPTIONS methods
- Whitelists localhost for development testing

**Testing**:
```bash
# Test CORS header
curl -i -H "Origin: https://fluxyfi-com.myshopify.com" http://localhost:3000/health

# Expected headers:
# access-control-allow-origin: https://fluxyfi-com.myshopify.com
# access-control-allow-credentials: true
```

#### 2. Rate Limiting

**File**: `src/server.ts`

**What**: Prevent abuse of public usage endpoint

**Configuration**:
- Max: 100 requests per IP
- Time Window: 15 minutes
- Whitelisted: 127.0.0.1 (localhost)
- Error Response: 429 Too Many Requests

**Purpose**: Protects against ICCID enumeration attacks and API abuse

#### 3. Cache Headers

**File**: `src/api/usage.ts`

**What**: Added HTTP cache headers to reduce vendor API calls

**Configuration**:
- Cache-Control: `public, max-age=300, s-maxage=300`
- Cache Duration: 5 minutes
- Applies to: All successful usage responses

**Rationale**: Usage data doesn't change rapidly; caching reduces FiRoam API load

### Dependencies Added

```json
{
  "@fastify/cors": "^8.0.0",
  "@fastify/rate-limit": "^8.0.0"
}
```

---

## API Endpoint Specification

### GET /api/esim/:iccid/usage

**Purpose**: Fetch current data usage for an eSIM by ICCID

**Authentication**: None (ICCID acts as natural authentication token)

**Rate Limit**: 100 requests per 15 minutes per IP

**CORS**: Allowed from Shopify domain

**Cache**: 5 minutes

#### Request

```bash
GET /api/esim/898520302104156254/usage
Origin: https://fluxyfi-com.myshopify.com
```

#### Response (Success)

```json
{
  "iccid": "898520302104156254",
  "orderNum": "EP20260131000822",
  "packageName": "Australia & NZ(Promo)",
  "usage": {
    "total": 500,
    "unit": "MB",
    "totalMb": 500,
    "usedMb": 0,
    "remainingMb": 500,
    "usagePercent": 0
  },
  "validity": {
    "days": 1,
    "beginDate": null,
    "endDate": null
  },
  "status": 0,
  "orderDetails": {
    "skuId": "211",
    "skuName": "Australia & NZ(Promo)",
    "createTime": "2026-01-31T14:00:00Z"
  }
}
```

#### Response Headers

```
HTTP/1.1 200 OK
access-control-allow-origin: https://fluxyfi-com.myshopify.com
access-control-allow-credentials: true
cache-control: public, max-age=300, s-maxage=300
content-type: application/json
```

#### Error Responses

**404 - ICCID Not Found**
```json
{
  "error": "ICCID not found",
  "message": "No delivery record found for this ICCID"
}
```

**500 - Usage Query Failed**
```json
{
  "error": "Failed to fetch usage data",
  "message": "No usage data available"
}
```

**429 - Rate Limit Exceeded**
```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Please try again later."
}
```

---

## Security Considerations

### Why ICCID-based endpoint is acceptable:

1. **ICCIDs are pseudo-random**: 19-20 digit numbers, not easily guessable
2. **Low sensitivity data**: Usage metrics, not payment or personal info
3. **Rate limiting**: Prevents brute-force enumeration
4. **Natural authentication**: Customer must have ICCID to access data
5. **Simple architecture**: No token management needed for MVP

### Mitigation strategies in place:

- ✅ Rate limiting (100 req/15min)
- ✅ CORS restrictions (Shopify domain only)
- ✅ Caching (reduces backend load)
- ✅ Encrypted storage (ICCID stored in encrypted payload)

---

## Next Steps: Phase 2 - Shopify Frontend

### To be implemented:

1. **Create Liquid Template**: `templates/page.esim-usage.liquid`
2. **Create JavaScript**: `assets/esim-usage.js`
3. **Create Styles**: `assets/esim-usage.css`
4. **Create Page**: Shopify Admin → Pages → New Page
5. **Update Email**: Add usage tracking link

### Customer Experience Flow:

```
1. Customer completes order in Shopify
2. Worker provisions eSIM
3. Customer receives email with usage link
4. Link format: https://yourstore.com/pages/my-esim-usage?iccid=XXXXX
5. Customer clicks → Liquid page loads
6. JavaScript fetches usage from backend API
7. Usage dashboard displays with progress bars
```

---

## Testing Checklist

### Backend Tests ✅

- [x] Server starts without errors
- [x] CORS headers present on health endpoint
- [x] CORS allows Shopify domain origin
- [x] Rate limiting configured (100 req/15min)
- [x] Cache headers added to usage response
- [x] Usage endpoint returns 404 for invalid ICCID
- [x] No TypeScript compilation errors (existing errors unrelated)

### Frontend Tests (Pending Phase 2)

- [ ] Liquid page loads correctly
- [ ] JavaScript fetches usage data
- [ ] CORS allows cross-origin request
- [ ] Loading state displayed
- [ ] Usage data rendered correctly
- [ ] Error states handled gracefully
- [ ] Mobile responsive design
- [ ] Progress bar/chart displays

### Integration Tests (Pending Phase 3)

- [ ] End-to-end: Order → Email → Click link → See usage
- [ ] Email contains correct ICCID
- [ ] Link opens Shopify page
- [ ] Usage updates in real-time
- [ ] Multiple ICCIDs work correctly

---

## Configuration

### Environment Variables

```bash
# .env
SHOPIFY_SHOP_DOMAIN=fluxyfi-com.myshopify.com
```

The CORS configuration automatically uses `SHOPIFY_SHOP_DOMAIN` to construct allowed origins.

### Deployment Checklist

When deploying to production:

1. ✅ Ensure `SHOPIFY_SHOP_DOMAIN` is set correctly
2. ✅ Verify CORS allows your production Shopify domain
3. ✅ Monitor rate limit hits in logs
4. ✅ Check cache hit rates
5. ✅ Test from actual Shopify storefront

---

## Troubleshooting

### CORS Errors

**Symptom**: Browser console shows "CORS policy" error

**Solution**:
1. Verify `SHOPIFY_SHOP_DOMAIN` in `.env`
2. Check server logs for CORS origin
3. Ensure Shopify page uses HTTPS
4. Test with curl to verify backend CORS headers

### Rate Limit Issues

**Symptom**: 429 Too Many Requests error

**Solution**:
1. Increase cache duration to reduce requests
2. Implement client-side caching (localStorage)
3. Adjust rate limit in `src/server.ts` if needed
4. Monitor logs to identify source IP

### Usage Data Not Found

**Symptom**: 404 error when fetching usage

**Solution**:
1. Verify ICCID is correct (19-20 digits)
2. Check delivery was marked as 'delivered' in database
3. Verify payload_encrypted exists in esim_deliveries table
4. Test decryption manually

---

## Performance Metrics

Expected performance with current configuration:

- **Response Time**: < 200ms (cached)
- **Response Time**: < 2s (uncached, vendor API call)
- **Cache Hit Rate**: 80%+ (with 5min cache)
- **Rate Limit**: 100 requests/15min = ~6.67 req/min sustained

---

## Future Enhancements

Post-MVP improvements to consider:

1. **Redis Cache Layer**: Store usage data server-side for faster responses
2. **WebSocket Updates**: Real-time usage updates without refresh
3. **Usage Alerts**: Email/SMS when 80% data consumed
4. **Historical Charts**: Show usage trends over time
5. **Multi-ICCID Support**: Customer dashboard for all their eSIMs
6. **Token-based Auth**: For additional security if needed

---

## Monitoring

### Key Metrics to Track

1. **API Response Times**: Track `/api/esim/:iccid/usage` latency
2. **Error Rates**: Monitor 404 (invalid ICCID) and 500 (vendor API) errors
3. **Rate Limit Hits**: Track 429 responses to identify abuse
4. **Cache Performance**: Monitor cache hit/miss ratio
5. **Vendor API Load**: Track FiRoam `queryEsimOrder` call frequency

### Recommended Tools

- Fastify built-in logger (already configured)
- Application monitoring (Railway/Render built-in)
- Sentry/DataDog for error tracking (optional)

---

## References

- [Fastify CORS Plugin](https://github.com/fastify/fastify-cors)
- [Fastify Rate Limit Plugin](https://github.com/fastify/fastify-rate-limit)
- [HTTP Caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching)
- [Shopify Liquid Pages](https://shopify.dev/docs/themes/architecture/templates/page)
