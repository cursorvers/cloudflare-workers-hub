export function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) continue;
    const rawValue = rest.join('=') || '';
    try {
      out[rawKey] = decodeURIComponent(rawValue);
    } catch {
      out[rawKey] = rawValue;
    }
  }
  return out;
}
