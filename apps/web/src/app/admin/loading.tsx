import { PageSkeleton } from '@/components/app/loading';

/** Shown while this page's code loads; the page then shows its own placeholders. */
export default function Loading() {
  return <PageSkeleton summary />;
}
