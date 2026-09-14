import { uploadPresigned } from "@vercel/blob/client";

// A file uploaded straight to Blob, referenced by its store pathname so the
// server can read it back via the private-store helpers.
export interface UploadedRef {
  name: string;       // original filename (round detection still uses this)
  pathname: string;   // Blob store pathname
  url: string;        // Blob URL (informational)
}

const UPLOAD_CONCURRENCY = 6;
const sanitize = (name: string) => (name || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);

// Validate that each file is JSON (gives a clean error before uploading), then
// upload all files directly to the private Blob store via presigned URLs.
// `onProgress(done, total)` fires after each file completes.
export async function uploadFiles(
  files: FileList | File[],
  onProgress?: (done: number, total: number) => void
): Promise<UploadedRef[]> {
  const arr = Array.from(files);
  // Pre-validate JSON so a bad file fails fast with a helpful message.
  for (const f of arr) {
    try { JSON.parse(await f.text()); }
    catch { throw new Error(`${f.name} is not valid JSON.`); }
  }
  // A few at a time, not one by one: a tournament's game files number in the
  // hundreds, and sequential uploads took minutes with nothing visibly happening.
  // Results keep the input order; the timestamp is taken once so names stay unique.
  const out: UploadedRef[] = new Array(arr.length);
  const stamp = Date.now();
  let next = 0, done = 0;
  const worker = async () => {
    while (next < arr.length) {
      const i = next++;
      const f = arr[i];
      const pathname = `uploads/${stamp}-${i}-${sanitize(f.name)}`;
      const res = await uploadPresigned(pathname, f, {
        access: "private",
        handleUploadUrl: "/api/blob-upload",
        contentType: "application/json",
        multipart: f.size > 8 * 1024 * 1024,
      });
      out[i] = { name: f.name, pathname: res.pathname, url: res.url };
      onProgress?.(++done, arr.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, arr.length) }, worker));
  return out;
}
