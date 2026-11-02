import { describe, expect, it } from 'vitest';
import { asBytes, bytesEqual, signatureParts } from '../src/compat.js';

const HINT = new Uint8Array([1, 2, 3, 4]);
const SIG = new Uint8Array([9, 9]);

describe('signatureParts', () => {
  it('reads accessor-method signatures (SDK <= 16)', () => {
    const sig = {
      _hint: Buffer.from(HINT),
      hint() {
        return this._hint;
      },
      signature: () => Buffer.from(SIG),
    };
    const parts = signatureParts(sig);
    expect([...parts.hint]).toEqual([...HINT]);
    expect([...parts.signature]).toEqual([...SIG]);
  });

  it('reads property signatures with wrapped opaque values (SDK >= 17)', () => {
    const parts = signatureParts({ hint: { value: HINT }, signature: SIG });
    expect(parts.hint).toBe(HINT);
    expect(parts.signature).toBe(SIG);
  });

  it('yields empty bytes for unrecognised shapes', () => {
    const parts = signatureParts({ hint: 'nope', signature: null });
    expect(parts.hint).toHaveLength(0);
    expect(parts.signature).toHaveLength(0);
  });
});

describe('asBytes / bytesEqual', () => {
  it('normalises and compares', () => {
    expect(asBytes(Buffer.from(HINT))).toBeInstanceOf(Uint8Array);
    expect(bytesEqual(asBytes({ value: HINT }), Buffer.from(HINT))).toBe(true);
    expect(bytesEqual(HINT, new Uint8Array([1, 2, 3, 5]))).toBe(false);
    expect(bytesEqual(HINT, new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
