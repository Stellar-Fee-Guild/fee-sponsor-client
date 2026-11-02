/**
 * Small adapters over XDR objects whose shape changed between `@stellar/stellar-sdk` majors.
 * Up to v16, XDR struct fields are accessor methods returning `Buffer`s (`sig.hint()`); from v17
 * they are plain properties, and opaque values may be wrapped (`sig.hint.value`).
 */

type XdrValue = unknown;

function readField(obj: unknown, name: string): XdrValue {
  const value = (obj as Record<string, unknown>)[name];
  return typeof value === 'function' ? (value as () => unknown).call(obj) : value;
}

/** Normalise a `Buffer`, `Uint8Array` or wrapped opaque XDR value to bytes. */
export function asBytes(value: XdrValue): Uint8Array {
  if (value instanceof Uint8Array) return value;
  const inner = (value as { value?: unknown } | null | undefined)?.value;
  if (inner instanceof Uint8Array) return inner;
  return new Uint8Array();
}

/** The `hint` and `signature` bytes of a `DecoratedSignature`, on any supported SDK version. */
export function signatureParts(sig: unknown): { hint: Uint8Array; signature: Uint8Array } {
  return {
    hint: asBytes(readField(sig, 'hint')),
    signature: asBytes(readField(sig, 'signature')),
  };
}

/** Constant-shape byte comparison (not constant-time; nothing here is secret). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
