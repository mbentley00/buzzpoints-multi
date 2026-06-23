// Issues presigned client-upload tokens so the browser can upload packet/QBJ
// files straight to the private Blob store, bypassing the 4.5 MB function
// request-body limit. Uses the project's OIDC credentials (VERCEL_OIDC_TOKEN +
// BLOB_STORE_ID) — no read-write token needed — and verifies upload-completed
// callbacks with BLOB_WEBHOOK_PUBLIC_KEY (the SDK default).
//
// Flow: client `uploadPresigned()` POSTs here to get a presigned PUT URL, uploads
// directly to Blob, then sends the returned blob references to /api/ingest.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleUploadPresigned, type HandleUploadPresignedBody } from "@vercel/blob/client";
import { issueSignedToken } from "@vercel/blob";
import { currentUser } from "./_lib/auth.js";

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB per file

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  // Token issuance requires a logged-in account; the upload-completed callback
  // comes from Vercel Blob (verified by signature), so allow it through.
  const body = (req.body || {}) as HandleUploadPresignedBody;
  if (body?.type !== "blob.upload-completed" && !currentUser(req))
    return res.status(401).json({ error: "Log in to upload files." });

  try {
    const result = await handleUploadPresigned({
      request: req as unknown as Request,
      body,
      getSignedToken: async (pathname) => {
        // Only allow uploads under the temp prefix; ingest reads then deletes them.
        if (!pathname.startsWith("uploads/")) throw new Error("Invalid upload path.");
        const token = await issueSignedToken({ pathname, operations: ["put"] });
        return { token, urlOptions: { maximumSizeInBytes: MAX_BYTES, addRandomSuffix: true } };
      },
    });
    return res.status(200).json(result);
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }
}
