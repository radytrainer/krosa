'use client';

import { ArrowRight, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Field, fieldErrors } from '@/components/app/form';
import { ErrorState } from '@/components/app/states';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api';
import { json, useApiMutation } from '@/lib/query';
import type { EditStudentNameBody, Student } from '@/lib/types';

const MAX = 200;

/** NUL and other control characters are refused by the API; catch them here first. */
const CONTROL = /[\u0000-\u001f\u007f]/;

function problem(value: string, required: boolean): string | null {
  const v = value.trim();
  if (!v) return required ? 'Required.' : null;
  if (v.length > MAX) return `At most ${MAX} characters.`;
  if (CONTROL.test(v)) return 'Remove the invisible control characters.';
  return null;
}

/**
 * The request body: first and last name when they changed (so a view without them never clears
 * them), or when the full name built from them differs from the stored one (e.g. stored as
 * "LAST FIRST"), so the server rebuilds it; the full name only when it is not built from first
 * and last. Empty when nothing differs: never sent.
 */
function buildBody(
  student: Student,
  first: string,
  last: string,
  full: string,
): EditStudentNameBody {
  const f = first.trim();
  const l = last.trim();
  const body: EditStudentNameBody = {};
  if (f !== (student.firstName ?? '')) body.firstName = f || null;
  if (l !== (student.lastName ?? '')) body.lastName = l || null;
  if (f && l) {
    // Both given: send both whenever anything differs, so the server rebuilds "FIRST LAST",
    // including when the stored full name has another order and neither part changed.
    const differs = 'firstName' in body || 'lastName' in body || `${f} ${l}` !== student.fullName;
    if (differs) {
      body.firstName = f;
      body.lastName = l;
    }
  } else if (full.trim() !== student.fullName || 'firstName' in body || 'lastName' in body) {
    body.fullName = full.trim();
  }
  return body;
}

function Change({ label, from, to }: { label: string; from: string; to: string }) {
  const changed = from !== to;
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2 break-words">
        <span className={changed ? 'line-through decoration-1' : undefined}>{from || '—'}</span>
        {changed ? (
          <>
            <ArrowRight aria-label="changes to" className="size-4 shrink-0" />
            <span className="font-medium">{to || '—'}</span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">(unchanged)</span>
        )}
      </dd>
    </div>
  );
}

/**
 * "Edit name": corrects a student's name when the system is wrong (e.g. a sync skipped them with
 * a name mismatch). Two steps: the form, then old → new before saving.
 */
export function EditStudentName({ student }: { student: Student }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'form' | 'review'>('form');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [full, setFull] = useState('');
  const save = useApiMutation(
    (body: EditStudentNameBody) =>
      apiFetch<Student>(`/admin/students/${student.id}/name`, json(body, 'PATCH')),
    {
      success: 'Name updated.',
      invalidate: ['/admin/students', '/admin/audit'],
      onSuccess: () => setOpen(false),
    },
  );

  const derived = first.trim() && last.trim() ? `${first.trim()} ${last.trim()}` : null;
  const newFull = derived ?? full.trim();
  const errors = {
    firstName: problem(first, false),
    lastName: problem(last, false),
    fullName: derived ? null : problem(full, true),
  };
  const server = fieldErrors(save.error);
  const invalid = Object.values(errors).some(Boolean);
  const body = buildBody(student, first, last, full);
  const unchanged = Object.keys(body).length === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (save.isPending) return;
        setOpen(next);
        if (next) {
          setStep('form');
          setFirst(student.firstName ?? '');
          setLast(student.lastName ?? '');
          setFull(student.fullName);
          save.reset();
        }
      }}
    >
      <DialogTrigger render={<Button variant="outline" />}>
        <Pencil aria-hidden />
        Edit name
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{step === 'form' ? 'Edit name' : 'Save this name?'}</DialogTitle>
          <DialogDescription>
            {step === 'form'
              ? 'Use this when the system has the name wrong. The next sync compares the sheet with this name; it does not change it.'
              : 'Check the change. It is recorded in the audit log.'}
          </DialogDescription>
        </DialogHeader>
        {step === 'form' ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!invalid && !unchanged) setStep('review');
            }}
          >
            <Field label="First name" error={errors.firstName ?? server['firstName']}>
              {(p) => (
                <Input
                  {...p}
                  value={first}
                  maxLength={MAX + 50}
                  onChange={(e) => setFirst(e.target.value)}
                />
              )}
            </Field>
            <Field label="Last name" error={errors.lastName ?? server['lastName']}>
              {(p) => (
                <Input
                  {...p}
                  value={last}
                  maxLength={MAX + 50}
                  onChange={(e) => setLast(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Full name"
              required={!derived}
              hint={derived ? 'Built from first and last name.' : undefined}
              error={errors.fullName ?? server['fullName']}
            >
              {(p) => (
                <Input
                  {...p}
                  value={derived ?? full}
                  disabled={Boolean(derived)}
                  maxLength={MAX + 50}
                  onChange={(e) => setFull(e.target.value)}
                />
              )}
            </Field>
            {unchanged ? (
              <p className="text-xs text-muted-foreground">Nothing changed yet.</p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={invalid || unchanged}>
                {unchanged ? 'No changes' : 'Review'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <dl className="space-y-3 rounded-lg bg-muted p-4 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Student ID</dt>
                <dd className="font-mono">{student.studentCode}</dd>
              </div>
              <Change label="First name" from={student.firstName ?? ''} to={first.trim()} />
              <Change label="Last name" from={student.lastName ?? ''} to={last.trim()} />
              <Change label="Full name" from={student.fullName} to={newFull} />
            </dl>
            {save.error ? <ErrorState error={save.error} /> : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep('form')} disabled={save.isPending}>
                Back
              </Button>
              <Button
                onClick={() => !unchanged && save.mutate(body)}
                disabled={save.isPending || unchanged}
              >
                {unchanged ? 'No changes' : save.isPending ? 'Saving…' : 'Save name'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
