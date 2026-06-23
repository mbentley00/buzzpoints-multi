// Shared Blob helpers. The store is private, so reads go through `get` (which
// authenticates via the deployment's OIDC token) and content is streamed back.
import { get } from "@vercel/blob";

export async function readBlobText(pathname: string, useCache = true): Promise<string | null> {
  const r = await get(pathname, { access: "private", useCache });
  if (!r || r.statusCode !== 200) return null;
  return new Response(r.stream as unknown as ReadableStream).text();
}

export async function readBlobJson<T>(pathname: string, useCache = true): Promise<T | null> {
  const t = await readBlobText(pathname, useCache);
  if (t === null) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}
