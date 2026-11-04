import Image from 'next/image';
import { cn } from '@/lib/utils';

/**
 * Passerelles Numériques logo, from passerellesnumeriques.org (public/brand). The blue version
 * is for light backgrounds, the white one for dark mode.
 */
export function PnLogo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-block', className)}>
      <Image
        src="/brand/PN-Logo-English-Blue-Baseline.png"
        alt="Passerelles Numériques – A Gateway for Life"
        width={344}
        height={146}
        priority
        className="h-full w-auto dark:hidden"
      />
      <Image
        src="/brand/PN-Logo-English-White-Baseline.png"
        alt="Passerelles Numériques – A Gateway for Life"
        width={344}
        height={146}
        priority
        className="hidden h-full w-auto dark:block"
      />
    </span>
  );
}

/** The PN circle alone, for tight spots such as the navigation bar. */
export function PnMark({ className }: { className?: string }) {
  return (
    <Image
      src="/brand/pn-mark.png"
      alt="Passerelles Numériques"
      width={96}
      height={96}
      className={cn('shrink-0 rounded-full', className)}
    />
  );
}
