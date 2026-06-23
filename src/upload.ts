import { uploadPresigned } from "@vercel/blob/client";

// A file uploaded straight to Blob, referenced by its store pathname so the
// server can read it back via the private-store helpers.
export interface UploadedRef {
  name: string;       // original filename (round detection still uses this)
  pathname: string;   // Blob store pathname
  url: string;        // Blob URL (informational)
}

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
  const out: UploadedRef[] = [];
  for (let i = 0; i < arr.length; i++) {
    const f = arr[i];
    const pathname = `uploads/${Date.now()}-${i}-${sanitize(f.name)}`;
    const res = await uploadPresigned(pathname, f, {
      access: "private",
      handleUploadUrl: "/api/blob-upload",
      contentType: "application/json",
      multipart: f.size > 8 * 1024 * 1024,
    });
    out.push({ name: f.name, pathname: res.pathname, url: res.url });
    onProgress?.(i + 1, arr.length);
  }
  return out;
}
