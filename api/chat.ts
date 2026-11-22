// Same-origin proxy for OpenAI-compatible chat completions, deployed as a
// Vercel serverless function. Remote providers (OpenAI, GLM/Z.ai, OpenRouter,
// …) don't send CORS headers for browser requests, so the deployed editor
// can't call them directly — instead the browser posts to /api/chat and this
// function forwards the call server-side. The API key stays in the user's
// browser (localStorage) and is only relayed per-request, never stored.
//
// Contract: POST /api/chat with an `x-ai-url` header naming the upstream
// /chat/completions URL, an optional Authorization header, and the OpenAI
// request JSON as the body. The upstream status/JSON is passed back as-is.

export const config = { runtime: 'nodejs' };
// One non-streaming completion with tool calling can take a while; 60s is the
// maximum allowed on Vercel's Hobby plan (raise alongside the plan if needed).
export const maxDuration = 60;

const PRIVATE_HOST =
  /^localhost$|^127\.|^0\.|^10\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.|\[::1\]|^\[::ffff:/i;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  const target = String(req.headers['x-ai-url'] ?? '');
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    res.status(400).json({ error: 'Missing or invalid x-ai-url header' });
    return;
  }
  if (url.protocol !== 'https:') {
    res.status(400).json({ error: 'x-ai-url must be https' });
    return;
  }
  // Never relay toward private/loopback addresses — the server-side proxy has
  // no business reaching into internal networks (SSRF guard).
  if (PRIVATE_HOST.test(url.hostname)) {
    res.status(400).json({ error: 'x-ai-url must not point at a private host' });
    return;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth) headers.Authorization = auth;

  // Collect the raw body so we forward the client's JSON untouched.
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: body || '{}',
    });
  } catch (err) {
    res.status(502).json({ error: `Upstream request failed: ${(err as Error).message}` });
    return;
  }

  const text = await upstream.text();
  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('Content-Type', contentType);
  res.send(text);
}
