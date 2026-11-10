const FETCH_TIMEOUT_MS = 45_000;
const MAX_BODY_BYTES = 20 * 1024 * 1024;

/**
 * Fetches a source as text. Some docs sites content-negotiate on Accept and redirect by
 * locale, so HTML sources ask for HTML and every request asks for English.
 */
export async function fetchText(url: string, file: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "swapcheck-registry/0.1", Accept: file.endsWith(".html") ? "text/html" : "*/*", "Accept-Language": "en" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = new Uint8Array(await res.arrayBuffer());
  if (buffer.byteLength > MAX_BODY_BYTES) throw new Error("response is larger than the size limit");
  return new TextDecoder().decode(buffer);
}
