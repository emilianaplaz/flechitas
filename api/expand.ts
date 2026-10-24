// Vercel function: GET /api/expand?url=<google maps short link>
// Follows the redirects of a Google Maps short link (maps.app.goo.gl / goo.gl/maps)
// and returns the final long URL, which contains coordinates or a place name.
// Only Google's short-link hosts are fetched, so this can't be used as an open proxy.
// vite.config.ts imports expandShortUrl so `npm run dev` serves the same endpoint.

const SHORT = /(^|\.)(goo\.gl|g\.co)$/i;

export async function expandShortUrl(
  input: string,
): Promise<{ status: number; body: { url?: string; error?: string } }> {
  let current: URL;
  try {
    current = new URL(input);
  } catch {
    return { status: 400, body: { error: 'URL inválida' } };
  }
  if (!SHORT.test(current.hostname)) {
    return { status: 400, body: { error: 'Solo se aceptan enlaces de Google Maps' } };
  }
  for (let hop = 0; hop < 6; hop++) {
    // Once we've left the short-link hosts we have the long URL — stop there.
    if (!SHORT.test(current.hostname)) break;
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile' },
      });
    } catch {
      return { status: 502, body: { error: 'No se pudo abrir el enlace' } };
    }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current);
      continue;
    }
    break;
  }
  // Consent interstitial (rare outside the EU): the real link is in ?continue=
  const cont = current.hostname.startsWith('consent.') ? current.searchParams.get('continue') : null;
  return { status: 200, body: { url: cont ?? current.toString() } };
}

export async function GET(request: Request): Promise<Response> {
  const target = new URL(request.url).searchParams.get('url') ?? '';
  const result = await expandShortUrl(target);
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
  });
}
