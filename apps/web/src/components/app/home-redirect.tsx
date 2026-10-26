'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { homeFor, useAuth } from '@/lib/auth';

/** Sends signed-in users from the landing page to their portal. */
export function HomeRedirect() {
  const { me } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (me) router.replace(homeFor(me));
  }, [me, router]);
  return null;
}
