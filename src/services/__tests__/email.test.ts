import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// vi.hoisted — vitest moves this block to the very top of the file, before
// any vi.mock calls, so values returned here are safe to use in mock factories.
// MUST be assigned to a single `const` — destructuring breaks factory hoisting.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  class MockPDFDocument {
    page = { width: 595, height: 842 };
    private _handlers: Record<string, Array<(arg?: Buffer) => void>> = {};

    on(event: string, handler: (arg?: Buffer) => void) {
      this._handlers[event] = this._handlers[event] ?? [];
      this._handlers[event].push(handler);
      return this;
    }
    rect() {
      return this;
    }
    fill() {
      return this;
    }
    fillColor() {
      return this;
    }
    fontSize() {
      return this;
    }
    font() {
      return this;
    }
    text() {
      return this;
    }
    image() {
      return this;
    }
    fillAndStroke() {
      return this;
    }
    stroke() {
      return this;
    }
    addPage() {
      return this;
    }
    end() {
      const fake = Buffer.from('fake-pdf');
      (this._handlers['data'] ?? []).forEach((h) => h(fake));
      (this._handlers['end'] ?? []).forEach((h) => h());
    }
  }

  return {
    MockPDFDocument,
    mockSend: vi.fn(),
    mockQRToBuffer: vi.fn(),
    MockResend: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Module mocks — factories may only reference `mocks.*`, not destructured vars
// ---------------------------------------------------------------------------
vi.mock('resend', () => ({
  Resend: mocks.MockResend,
}));

vi.mock('qrcode', () => ({
  default: { toBuffer: mocks.mockQRToBuffer },
}));

vi.mock('pdfkit', () => ({
  default: mocks.MockPDFDocument,
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// ---------------------------------------------------------------------------
import { sendDeliveryEmail, recordDeliveryAttempt, type DeliveryEmailData } from '~/services/email';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const basePayload: DeliveryEmailData = {
  to: 'customer@example.com',
  orderNumber: '#1001',
  productName: 'USA 5GB 30 Days',
  esimPayload: {
    lpa: 'LPA:1$smdp.example.com$ABCDEF123456',
    activationCode: 'ABCDEF123456',
    iccid: '89883030000123456789',
  },
  region: 'USA',
  dataAmount: '5GB',
  validity: '30 days',
};

// ---------------------------------------------------------------------------
// sendDeliveryEmail
// ---------------------------------------------------------------------------
describe('sendDeliveryEmail', () => {
  beforeEach(() => {
    vi.stubEnv('RESEND_API_KEY', 'test-resend-key');
    vi.stubEnv('EMAIL_FROM', 'orders@test.com');
    mocks.mockQRToBuffer.mockResolvedValue(Buffer.from('fake-qr'));
    mocks.MockResend.mockImplementation(function () {
      return { emails: { send: mocks.mockSend } };
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('returns success with messageId on happy path', async () => {
    mocks.mockSend.mockResolvedValueOnce({ data: { id: 'msg-abc-123' }, error: null });

    const result = await sendDeliveryEmail(basePayload);

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg-abc-123');
    expect(result.error).toBeUndefined();
  });

  it('calls resend.emails.send with correct recipient and subject', async () => {
    mocks.mockSend.mockResolvedValueOnce({ data: { id: 'msg-999' }, error: null });

    await sendDeliveryEmail(basePayload);

    expect(mocks.mockSend).toHaveBeenCalledOnce();
    const callArg = mocks.mockSend.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.to).toBe('customer@example.com');
    expect(callArg.subject).toContain('#1001');
    expect(callArg.from).toBe('orders@test.com');
  });

  it('attaches qrcode.png and PDF to the email', async () => {
    mocks.mockSend.mockResolvedValueOnce({ data: { id: 'msg-789' }, error: null });

    await sendDeliveryEmail(basePayload);

    const callArg = mocks.mockSend.mock.calls[0][0] as {
      attachments: Array<{ filename: string }>;
    };
    const filenames = callArg.attachments.map((a) => a.filename);
    expect(filenames).toContain('qrcode.png');
    expect(filenames).toContain('eSIM-#1001.pdf');
  });

  it('returns failure when Resend returns an error object', async () => {
    mocks.mockSend.mockResolvedValueOnce({
      data: null,
      error: { message: 'Invalid API key', name: 'validation_error' },
    });

    const result = await sendDeliveryEmail(basePayload);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid API key');
    expect(result.messageId).toBeUndefined();
  });

  it('returns failure when Resend throws', async () => {
    mocks.mockSend.mockRejectedValueOnce(new Error('Network timeout'));

    const result = await sendDeliveryEmail(basePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network timeout');
  });

  it('returns failure when RESEND_API_KEY is not set', async () => {
    vi.unstubAllEnvs(); // removes the API key set in beforeEach

    const result = await sendDeliveryEmail(basePayload);

    expect(result.success).toBe(false);
    expect(result.error).toContain('RESEND_API_KEY');
    expect(mocks.mockSend).not.toHaveBeenCalled();
  });

  it('works without optional fields (productName, region, etc.)', async () => {
    mocks.mockSend.mockResolvedValueOnce({ data: { id: 'msg-min' }, error: null });

    const minimal: DeliveryEmailData = {
      to: 'user@test.com',
      orderNumber: '#2000',
      esimPayload: {
        lpa: 'LPA:1$smdp.io$MINCODEABC',
        activationCode: 'MINCODEABC',
        iccid: '89883030000000000001',
      },
    };

    const result = await sendDeliveryEmail(minimal);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// recordDeliveryAttempt
// ---------------------------------------------------------------------------
describe('recordDeliveryAttempt', () => {
  it('calls prisma.deliveryAttempt.create with correct data', async () => {
    const mockCreate = vi.fn().mockResolvedValue({});
    const mockPrisma = {
      deliveryAttempt: { create: mockCreate },
    } as unknown as PrismaClient;

    await recordDeliveryAttempt(mockPrisma, 'delivery-id-abc', 'email', 'success');

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        deliveryId: 'delivery-id-abc',
        channel: 'email',
        result: 'success',
      },
    });
  });

  it('propagates database errors', async () => {
    const mockPrisma = {
      deliveryAttempt: {
        create: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      },
    } as unknown as PrismaClient;

    await expect(
      recordDeliveryAttempt(mockPrisma, 'delivery-id-xyz', 'email', 'failed'),
    ).rejects.toThrow('DB connection lost');
  });
});
