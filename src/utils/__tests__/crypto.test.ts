import { describe, it, expect, beforeEach } from 'vitest';
import { encrypt, decrypt } from '~/utils/crypto';

describe('Crypto Utils - Encryption/Decryption', () => {
  beforeEach(() => {
    // Set a test encryption key
    process.env.ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long!';
  });

  describe('Basic Encryption/Decryption', () => {
    it('should encrypt and decrypt a string successfully', () => {
      const plaintext = 'LPA:1$smdp.io$activation-code-12345';

      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(encrypted).not.toBe(plaintext);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertext for same plaintext', () => {
      const plaintext = 'sensitive-data';

      const encrypted1 = encrypt(plaintext);
      const encrypted2 = encrypt(plaintext);

      // Different IV should produce different ciphertext
      expect(encrypted1).not.toBe(encrypted2);

      // But both should decrypt to same plaintext
      expect(decrypt(encrypted1)).toBe(plaintext);
      expect(decrypt(encrypted2)).toBe(plaintext);
    });

    it('should handle empty string', () => {
      const plaintext = '';

      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle special characters', () => {
      const plaintext = 'eSIM-データ-🔐-@#$%^&*()';

      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle long strings', () => {
      const plaintext = 'A'.repeat(10000);

      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
      expect(decrypted.length).toBe(10000);
    });
  });

  describe('LPA String Encryption', () => {
    it('should encrypt LPA string correctly', () => {
      const lpa = 'LPA:1$smdp.io$CODE123';

      const encrypted = encrypt(lpa);

      expect(encrypted).toBeDefined();
      expect(typeof encrypted).toBe('string');
      expect(encrypted.length).toBeGreaterThan(0);
    });

    it('should decrypt LPA string correctly', () => {
      const lpa = 'LPA:1$smdp.io$CODE123';

      const encrypted = encrypt(lpa);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(lpa);
    });

    it('should handle multiple LPA formats', () => {
      const lpaFormats = [
        'LPA:1$smdp.io$CODE123',
        'LPA:1$sm-v4-009-a-gtm.pr.go-esim.com$L8MG6H-RN24AQ-1MFY61',
        'LPA:1$prod.smdp.rsp.goog$activation-code',
      ];

      lpaFormats.forEach((lpa) => {
        const encrypted = encrypt(lpa);
        const decrypted = decrypt(encrypted);
        expect(decrypted).toBe(lpa);
      });
    });
  });

  describe('Activation Code Encryption', () => {
    it('should encrypt activation code', () => {
      const activationCode = 'L8MG6H-RN24AQ-1MFY61';

      const encrypted = encrypt(activationCode);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(activationCode);
    });

    it('should handle various activation code formats', () => {
      const codes = [
        'CODE123',
        'L8MG6H-RN24AQ-1MFY61',
        '1234567890ABCDEF',
        'activation_code_with_underscores',
      ];

      codes.forEach((code) => {
        const encrypted = encrypt(code);
        const decrypted = decrypt(encrypted);
        expect(decrypted).toBe(code);
      });
    });
  });

  describe('ICCID Encryption', () => {
    it('should encrypt ICCID correctly', () => {
      const iccid = '8901260222193581828';

      const encrypted = encrypt(iccid);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(iccid);
    });

    it('should handle various ICCID formats', () => {
      const iccids = ['8901260222193581828', '89012603191234567890', '890126'];

      iccids.forEach((iccid) => {
        const encrypted = encrypt(iccid);
        const decrypted = decrypt(encrypted);
        expect(decrypted).toBe(iccid);
      });
    });
  });

  describe('Key Format Handling', () => {
    it('should handle hex key format', () => {
      process.env.ENCRYPTION_KEY =
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

      const plaintext = 'test-data';
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle passphrase key format', () => {
      process.env.ENCRYPTION_KEY = 'my-super-secret-passphrase';

      const plaintext = 'test-data';
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should throw error if encryption key not set', () => {
      delete process.env.ENCRYPTION_KEY;

      expect(() => encrypt('test')).toThrow('ENCRYPTION_KEY not set');
    });
  });

  describe('Error Handling', () => {
    it('should throw error on invalid ciphertext', () => {
      const invalidCiphertext = 'invalid-base64-data';

      expect(() => decrypt(invalidCiphertext)).toThrow();
    });

    it('should throw error on corrupted ciphertext', () => {
      const plaintext = 'test-data';
      const encrypted = encrypt(plaintext);

      // Corrupt the ciphertext
      const corrupted = encrypted.slice(0, -5) + 'xxxxx';

      expect(() => decrypt(corrupted)).toThrow();
    });

    it('should throw error on tampered authentication tag', () => {
      const plaintext = 'test-data';
      const encrypted = encrypt(plaintext);

      // Decode, modify tag, re-encode
      const buffer = Buffer.from(encrypted, 'base64');
      buffer[15] = buffer[15] ^ 0xff; // Flip bits in auth tag
      const tampered = buffer.toString('base64');

      expect(() => decrypt(tampered)).toThrow();
    });
  });

  describe('Data Integrity', () => {
    it('should detect modified ciphertext', () => {
      const plaintext = 'important-data';
      const encrypted = encrypt(plaintext);

      // Modify one byte in the middle
      const buffer = Buffer.from(encrypted, 'base64');
      buffer[buffer.length - 10] = buffer[buffer.length - 10] ^ 0xff;
      const modified = buffer.toString('base64');

      expect(() => decrypt(modified)).toThrow();
    });

    it('should use GCM mode for authenticated encryption', () => {
      const plaintext = 'sensitive-data';
      const encrypted = encrypt(plaintext);

      // GCM produces IV (12 bytes) + Tag (16 bytes) + Ciphertext
      const buffer = Buffer.from(encrypted, 'base64');
      expect(buffer.length).toBeGreaterThanOrEqual(28); // IV + Tag minimum
    });
  });

  describe('Performance', () => {
    it('should handle bulk encryption efficiently', () => {
      const plaintexts = Array.from({ length: 100 }, (_, i) => `data-${i}`);

      const start = Date.now();
      const encrypted = plaintexts.map((p) => encrypt(p));
      const decrypted = encrypted.map((e) => decrypt(e));
      const elapsed = Date.now() - start;

      expect(decrypted).toEqual(plaintexts);
      expect(elapsed).toBeLessThan(1000); // Should complete in less than 1 second
    });
  });
});
