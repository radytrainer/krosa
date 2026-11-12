'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { NOTICE_DURATION_MS, NOTICE_PARAM, noticeText } from '@/lib/notices';

function Notice() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const code = params.get(NOTICE_PARAM);
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (code === null) return;
    const text = noticeText(code);
    // Once per arrival: the code leaves the URL at once, so a reload or Back shows nothing.
    if (text && shown.current !== code) {
      shown.current = code;
      // The toaster is a polite live region, so screen readers announce it.
      toast.info(text, { id: `notice-${code}`, duration: NOTICE_DURATION_MS });
    }
    const rest = new URLSearchParams(params);
    rest.delete(NOTICE_PARAM);
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [code, params, pathname, router]);

  return null;
}

/** Shows the notice named by `?notice=` (fixed codes only, lib/notices.ts) once, then drops it. */
export function UrlNotice() {
  return (
    <Suspense fallback={null}>
      <Notice />
    </Suspense>
  );
}
