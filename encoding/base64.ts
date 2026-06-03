/**
 * Cross-runtime base64 / UTF-8 helpers.
 *
 * Works identically in:
 *   - Browser / Vite (uses native `btoa`/`atob` + `TextEncoder`)
 *   - Deno Edge Functions (same globals)
 *
 * Use this from BOTH `src/lib/sourceCodeUtils.ts` (browser) and
 * `supabase/functions/<fn>/index.ts` (Deno) so the encoding contract for
 * source-code storage stays in lockstep.
 *
 * Storage contract (project-wide): source code is stored as UTF-8 → bytes →
 * base64. Decoding reverses the same pipeline. Callers that accept user
 * input should use `ensureBase64` so plain text and pre-encoded base64 are
 * both accepted transparently.
 */

/** Encode arbitrary text to base64 via the UTF-8 byte representation.
 *  Equivalent to the classic `btoa(unescape(encodeURIComponent(text)))` but
 *  uses `TextEncoder` so it works in Deno (which lacks `unescape`). */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Decode a base64 string back to UTF-8 text. Returns the original input on
 *  decode failure so callers don't accidentally render `undefined`. */
export function base64ToUtf8(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return b64;
  }
}

/** Heuristic: does `text` look like a valid base64-encoded blob? Conservative
 *  — when in doubt, returns false so callers will re-encode. */
export function looksLikeBase64(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  const stripped = text.replace(/\s+/g, "");
  if (stripped.length === 0 || stripped.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) return false;
  try {
    atob(stripped);
    return true;
  } catch {
    return false;
  }
}

/**
 * Accept either plain text or an already-base64 blob and return base64
 * suitable for storage. If `isBase64` is explicit, trust the caller and skip
 * detection. Otherwise apply the round-trip-decode heuristic — only treat
 * input as base64 if it decodes to valid UTF-8.
 */
export function ensureBase64(content: string, isBase64?: boolean | null): string {
  if (isBase64 === true) return content;
  if (isBase64 === false) return utf8ToBase64(content);

  const trimmed = content.trim();
  const looks =
    /^[A-Za-z0-9+/=\s]+$/.test(trimmed) &&
    trimmed.length % 4 === 0 &&
    trimmed.length >= 8;
  if (looks) {
    try {
      const decoded = atob(trimmed);
      const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return trimmed;
    } catch {
      /* fall through to encode-as-plaintext */
    }
  }
  return utf8ToBase64(content);
}

/** Remove all non-ASCII characters, keeping printable ASCII + tab/LF/CR. */
export function stripNonAscii(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
}
