const MAX_NAME_LENGTH = 255;

/**
 * Normalizes a user-supplied file/folder name: NFC, strips control characters and
 * path separators, collapses dot-only names. Returns null if nothing usable remains.
 */
export function sanitizeFileName(raw: string): string | null {
  let name = raw.normalize("NFC");
  // Control chars (incl. null byte) and characters illegal on common filesystems
  name = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_");
  name = name.trim();
  if (name === "" || /^\.+$/.test(name)) return null;
  if (name.length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = name.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  return name;
}

export interface ByteRange {
  start: number;
  /** Inclusive end offset. */
  end: number;
}

/**
 * Parses a single-range HTTP `Range` header against a resource size.
 * - `undefined` header → null (serve the whole body)
 * - unsupported/multi-range/garbage → null (RFC 9110 allows ignoring the header)
 * - syntactically valid but unsatisfiable → "unsatisfiable" (respond 416)
 */
export function parseRangeHeader(header: string | undefined, size: number): ByteRange | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return null;

  if (startStr === "") {
    // Suffix range: last N bytes
    const suffix = Number(endStr);
    if (!Number.isSafeInteger(suffix) || suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startStr);
  if (!Number.isSafeInteger(start) || start >= size) return "unsatisfiable";
  let end = endStr === "" ? size - 1 : Number(endStr);
  if (!Number.isSafeInteger(end) || end < start) return "unsatisfiable";
  end = Math.min(end, size - 1);
  return { start, end };
}

const INLINE_SAFE_MIME = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain)$/i;

/**
 * Decides how stored content may be served. Anything that a browser could execute
 * (HTML, SVG, XML, JS…) is never served inline with its real type.
 */
export function resolveServedContentType(
  storedMime: string,
  options: { asText?: boolean; attachment?: boolean }
): { contentType: string; disposition: "inline" | "attachment" } {
  const mime = storedMime.split(";")[0].trim().toLowerCase();
  if (options.asText) return { contentType: "text/plain; charset=utf-8", disposition: "inline" };
  if (options.attachment) return { contentType: "application/octet-stream", disposition: "attachment" };
  if (INLINE_SAFE_MIME.test(mime)) return { contentType: mime, disposition: "inline" };
  return { contentType: "application/octet-stream", disposition: "attachment" };
}

/** RFC 6266/5987 Content-Disposition value with an ASCII fallback. */
export function contentDispositionHeader(disposition: "inline" | "attachment", fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
