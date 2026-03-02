import { describe, it, expect } from 'vitest';
import {
  parseSmdpFromLpa,
  buildEmailHtml,
  buildEmailText,
  type DeliveryEmailData,
} from '../emailTemplates';

// ---------------------------------------------------------------------------
// Shared test fixture
// ---------------------------------------------------------------------------

const baseData: DeliveryEmailData = {
  to: 'customer@example.com',
  orderNumber: '#1001',
  esimPayload: {
    lpa: 'LPA:1$smdp.example.com$ACTCODE123',
    activationCode: 'ACTCODE123',
    iccid: '8901000000000000001',
  },
};

// ---------------------------------------------------------------------------
// parseSmdpFromLpa
// ---------------------------------------------------------------------------

describe('parseSmdpFromLpa', () => {
  it('extracts SM-DP+ address from a well-formed LPA string', () => {
    expect(parseSmdpFromLpa('LPA:1$smdp.example.com$ACTIVATION_CODE')).toBe('smdp.example.com');
  });

  it('extracts address when LPA has exactly two $ segments', () => {
    expect(parseSmdpFromLpa('LPA:1$provider.io')).toBe('provider.io');
  });

  it('returns "smdp.io" fallback when string has no $ separator', () => {
    expect(parseSmdpFromLpa('nodollar')).toBe('smdp.io');
  });

  it('returns "smdp.io" fallback for empty string', () => {
    expect(parseSmdpFromLpa('')).toBe('smdp.io');
  });

  it('handles multiple $ segments and returns the second part', () => {
    expect(parseSmdpFromLpa('LPA:1$smdp.roamwifi.hk$CODE$EXTRA')).toBe('smdp.roamwifi.hk');
  });
});

// ---------------------------------------------------------------------------
// buildEmailHtml
// ---------------------------------------------------------------------------

describe('buildEmailHtml', () => {
  it('returns a non-empty HTML string', () => {
    const html = buildEmailHtml(baseData);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(100);
  });

  it('includes DOCTYPE declaration', () => {
    expect(buildEmailHtml(baseData)).toContain('<!DOCTYPE html>');
  });

  it('includes the order number', () => {
    expect(buildEmailHtml(baseData)).toContain('#1001');
  });

  it('includes the activation code in the manual codes section', () => {
    expect(buildEmailHtml(baseData)).toContain('ACTCODE123');
  });

  it('includes the ICCID', () => {
    expect(buildEmailHtml(baseData)).toContain('8901000000000000001');
  });

  it('includes the SM-DP+ address', () => {
    expect(buildEmailHtml(baseData)).toContain('smdp.example.com');
  });

  it('uses productName when provided', () => {
    const html = buildEmailHtml({ ...baseData, productName: 'Turkey 5GB 30 Days' });
    expect(html).toContain('Turkey 5GB 30 Days');
  });

  it('falls back to "Your eSIM" when productName is omitted', () => {
    const html = buildEmailHtml(baseData);
    expect(html).toContain('Your eSIM');
  });

  it('includes region when provided', () => {
    const html = buildEmailHtml({ ...baseData, region: 'Europe' });
    expect(html).toContain('Europe');
  });

  it('includes dataAmount when provided', () => {
    const html = buildEmailHtml({ ...baseData, dataAmount: '10GB' });
    expect(html).toContain('10GB');
  });

  it('includes validity when provided', () => {
    const html = buildEmailHtml({ ...baseData, validity: '30 days' });
    expect(html).toContain('30 days');
  });

  it('omits the details box when no optional fields are supplied', () => {
    // When none of region/dataAmount/validity are present, the details section should not render
    const html = buildEmailHtml(baseData);
    expect(html).not.toContain('eSIM Details');
  });

  it('includes the iPhone install button with LPA-encoded URL', () => {
    const html = buildEmailHtml(baseData);
    expect(html).toContain('esimsetup.apple.com');
    expect(html).toContain(encodeURIComponent(baseData.esimPayload.lpa));
  });

  it('includes the usage dashboard link with the ICCID', () => {
    const html = buildEmailHtml(baseData);
    expect(html).toContain('my-esim-usage');
    expect(html).toContain('8901000000000000001');
  });

  it('includes the CID reference for inline QR code', () => {
    expect(buildEmailHtml(baseData)).toContain('cid:qrcode');
  });

  it('includes current year in the footer', () => {
    const html = buildEmailHtml(baseData);
    expect(html).toContain(String(new Date().getFullYear()));
  });

  it('renders all optional metadata fields at once', () => {
    const html = buildEmailHtml({
      ...baseData,
      productName: 'Japan 3GB',
      region: 'Japan',
      dataAmount: '3GB',
      validity: '15 days',
    });
    expect(html).toContain('Japan 3GB');
    expect(html).toContain('Japan');
    expect(html).toContain('3GB');
    expect(html).toContain('15 days');
  });
});

// ---------------------------------------------------------------------------
// buildEmailText
// ---------------------------------------------------------------------------

describe('buildEmailText', () => {
  it('returns a non-empty plain-text string', () => {
    const text = buildEmailText(baseData);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(50);
  });

  it('includes the order number', () => {
    expect(buildEmailText(baseData)).toContain('#1001');
  });

  it('includes the activation code', () => {
    expect(buildEmailText(baseData)).toContain('ACTCODE123');
  });

  it('includes the ICCID', () => {
    expect(buildEmailText(baseData)).toContain('8901000000000000001');
  });

  it('includes the SM-DP+ address', () => {
    expect(buildEmailText(baseData)).toContain('smdp.example.com');
  });

  it('uses productName when provided', () => {
    const text = buildEmailText({ ...baseData, productName: 'Korea 5GB' });
    expect(text).toContain('Korea 5GB');
  });

  it('falls back to "Your eSIM" when productName is omitted', () => {
    expect(buildEmailText(baseData)).toContain('Your eSIM');
  });

  it('includes region when provided', () => {
    const text = buildEmailText({ ...baseData, region: 'Asia' });
    expect(text).toContain('Asia');
  });

  it('includes dataAmount when provided', () => {
    const text = buildEmailText({ ...baseData, dataAmount: '5GB' });
    expect(text).toContain('5GB');
  });

  it('includes validity when provided', () => {
    const text = buildEmailText({ ...baseData, validity: '7 days' });
    expect(text).toContain('7 days');
  });

  it('includes usage tracking URL with ICCID', () => {
    const text = buildEmailText(baseData);
    expect(text).toContain('my-esim-usage');
    expect(text).toContain('8901000000000000001');
  });

  it('includes current year in the footer', () => {
    expect(buildEmailText(baseData)).toContain(String(new Date().getFullYear()));
  });

  it('does not include HTML tags', () => {
    const text = buildEmailText(baseData);
    expect(text).not.toMatch(/<[^>]+>/);
  });
});
