'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * A password field with its own Show / Hide toggle. Hidden by default; each field toggles on its
 * own. Hidden again when its form is submitted or reset, and whenever the page is left (the state
 * does not outlive the component). Pass `autoComplete` ("current-password" or "new-password") so
 * password managers keep working: the input keeps its name and autocomplete in both modes.
 */
export function PasswordInput({
  className,
  id,
  ...props
}: Omit<ComponentProps<'input'>, 'type'> & { id: string }) {
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const hide = () => setShown(false);
    form.addEventListener('submit', hide);
    form.addEventListener('reset', hide);
    return () => {
      form.removeEventListener('submit', hide);
      form.removeEventListener('reset', hide);
    };
  }, []);

  return (
    <div className="relative">
      <Input
        {...props}
        ref={ref}
        id={id}
        type={shown ? 'text' : 'password'}
        // A shown password is still a password: no spellcheck or autocorrect sends it anywhere.
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        className={cn('pr-10', className)}
      />
      <button
        type="button"
        aria-controls={id}
        aria-pressed={shown}
        aria-label={shown ? 'Hide password' : 'Show password'}
        title={shown ? 'Hide password' : 'Show password'}
        onClick={() => setShown((s) => !s)}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4"
      >
        {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
      </button>
    </div>
  );
}
