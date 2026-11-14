'use client';

import { MessageSquareText } from 'lucide-react';
import { TeacherComment } from '@/components/results/course-result';
import { Button } from '@/components/ui/button';

/** The comment toggle in a table row. The comment itself shows in the row below it. */
export function CommentToggle({
  open,
  onToggle,
  controls,
  studentLabel,
}: {
  open: boolean;
  onToggle(): void;
  controls: string;
  studentLabel: string;
}) {
  return (
    <Button
      variant={open ? 'secondary' : 'ghost'}
      size="icon-sm"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={`${open ? 'Hide' : 'Show'} teacher comment for ${studentLabel}`}
      onClick={onToggle}
    >
      <MessageSquareText aria-hidden />
    </Button>
  );
}

/** Plain text, line breaks kept: TeacherComment renders a text node, never HTML. */
export function CommentPanel({ id, text }: { id: string; text: string }) {
  return (
    <div id={id} className="max-w-3xl">
      <TeacherComment text={text} />
    </div>
  );
}
