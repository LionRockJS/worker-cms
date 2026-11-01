// ============================================================
// Server-side masking of personal data.
//
// The client toggle in assets/privacy-table.js masks a rendered cell, which
// hides a value from someone looking over a shoulder. It cannot withhold one:
// the cleartext is in the response body, and in the DOM, for anyone who
// received the page. Confidentiality has to be decided before the value is
// serialized, which is what this module is for.
//
// A viewer without `pii:reveal` is served the mask instead of the value, so
// the data never leaves the Worker. A viewer holding it is served the value
// and keeps the client toggle, which then masks by default as a convenience
// rather than as a control.
//
// The output deliberately matches the client's own mask, so a withheld value
// and a client-masked one are indistinguishable on screen; the difference is
// whether anything can reveal it.
// ============================================================

export type PrivateFieldKind = 'name' | 'email' | 'phone' | 'contact';

const MASK = '***';

/** Keeps enough shape to tell two rows apart without disclosing the value. */
function maskToken(value: string): string {
  const chars = [...String(value ?? '')];
  if (!chars.length) return '';
  if (chars.length <= 4) return chars[0] + MASK;
  if (/[A-Za-z]/.test(value)) return chars.slice(0, 2).join('') + MASK + chars[chars.length - 1];
  return chars[0] + MASK + chars[chars.length - 1];
}

/** The domain's registrable part stays legible; the local part and host do not. */
function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at <= 0) return maskToken(value);
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const parts = domain.split('.');
  if (parts.length < 2) return `${maskToken(local)}@${maskToken(domain)}`;
  return `${maskToken(local)}@${maskToken(parts[0])}.${parts.slice(1).join('.')}`;
}

export function maskPrivateValue(value: string | null | undefined, kind: PrivateFieldKind): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (kind === 'email' || text.includes('@')) return maskEmail(text);
  if (kind === 'phone') return maskToken(text.replace(/\s+/g, ''));
  // A display name may hold several tokens; separators are kept so the shape
  // of the original reads the same.
  return text.split(/([\s·]+)/).map(part => (/^[\s·]+$/.test(part) ? part : maskToken(part))).join('');
}
