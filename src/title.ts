import { useEffect } from "react";

const SITE = "Buzzpoints";

// The browser tab's title: the most specific part first, the site last —
// "George Mason A · 2026 ACF Fall · Buzzpoints". Empty parts are skipped.
export function useDocTitle(...parts: (string | null | undefined | false)[]) {
  const title = [...parts.filter((p): p is string => !!p && !!p.trim()).map((p) => p.trim()), SITE].join(" · ");
  useEffect(() => { document.title = title; }, [title]);
}
