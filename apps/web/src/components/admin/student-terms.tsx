'use client';

import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { NativeSelect } from '@/components/app/form';
import { StatusPill } from '@/components/app/status';
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
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api';
import { json, useApi, useApiMutation } from '@/lib/query';
import type { Student, StudentTerm, Term, TermClasses } from '@/lib/types';

/** An admin picks the student's program and class in one term. */
function AssignDialog({
  student,
  term,
  current,
}: {
  student: Student;
  term: Term;
  current: StudentTerm | undefined;
}) {
  const [open, setOpen] = useState(false);
  const classes = useApi<TermClasses>(open ? `/admin/terms/${term.id}/classes` : null);
  const [choice, setChoice] = useState(
    current ? `${current.program.code}|${current.className}` : '',
  );
  const assign = useApiMutation(
    () => {
      const [program, className] = choice.split('|');
      return apiFetch(
        `/admin/students/${student.id}/terms/${term.id}`,
        json({ program, className }, 'PUT'),
      );
    },
    {
      success: `${term.name} updated.`,
      invalidate: [`/admin/students/${student.id}`, '/admin/students', `/admin/terms/${term.id}`],
      onSuccess: () => setOpen(false),
    },
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        <Pencil aria-hidden />
        {current ? 'Change' : 'Assign'}
        <span className="sr-only"> {term.name}</span>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {student.studentCode} in {term.name}
          </DialogTitle>
          <DialogDescription>
            The sync keeps a program you set here. It still follows the ALL tab for the class within
            that program. Moving to another program withdraws the subjects that program does not
            take; their marks are kept.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={`assign-${term.id}`}>Program and class</Label>
          <NativeSelect
            id={`assign-${term.id}`}
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value="">Choose…</option>
            {classes.data?.programs.flatMap((p) =>
              p.classes.map((c) => (
                <option key={c.id} value={`${p.code}|${c.name}`}>
                  {p.code} · class {c.name}
                </option>
              )),
            )}
          </NativeSelect>
        </div>
        <DialogFooter>
          <Button disabled={!choice || assign.isPending} onClick={() => assign.mutate(undefined)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Program and class in every term of the student's generation, with an admin override. */
export function StudentTerms({ student, readOnly }: { student: Student; readOnly: boolean }) {
  const terms = useApi<Term[]>(`/admin/generations/${student.generation.id}/terms`);
  const byTerm = new Map(student.terms.map((t) => [t.termId, t]));
  return (
    <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Term</TableHead>
            <TableHead>Program</TableHead>
            <TableHead>Class</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(terms.data ?? []).map((term) => {
            const t = byTerm.get(term.id);
            return (
              <TableRow key={term.id}>
                <TableCell className="font-medium">{term.name}</TableCell>
                <TableCell>
                  {t ? (
                    <>
                      {t.program.code}
                      <span className="block text-xs text-muted-foreground">{t.program.name}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Not enrolled</span>
                  )}
                </TableCell>
                <TableCell>
                  {t ? t.className : '—'}
                  {t?.programSource === 'ADMIN' ? (
                    <StatusPill tone="info" className="ml-2">
                      Set by an admin
                    </StatusPill>
                  ) : null}
                </TableCell>
                <TableCell className="text-right">
                  {readOnly ? null : <AssignDialog student={student} term={term} current={t} />}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
