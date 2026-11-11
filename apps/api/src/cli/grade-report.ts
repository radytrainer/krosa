/**
 * Read-only report of the letters the official scale gives (docs/decisions.md G1–G4):
 *
 *   pnpm grades:report
 *
 * Counts COMPLETE subjects (ENROLLED enrollments of ACTIVE offerings) by letter, per generation,
 * split into released and hidden. Grades are computed when results are read, never stored, so
 * there is nothing to recalculate: the report shows what students and admins will see. Prints
 * counts only, never names. Writes nothing.
 */
import { createPrismaClient } from '@ssrs/database';
import {
  computeCourseResult,
  envFields,
  gradeFor,
  OFFICIAL_GRADE_BANDS,
  parseEnv,
  type GradeBandInput,
} from '@ssrs/shared';
import { loadRootEnv } from '@ssrs/shared/node';
import { z } from 'zod';

type Counts = Record<string, number>;

async function main(): Promise<void> {
  loadRootEnv();
  const env = parseEnv(z.object({ DATABASE_URL: envFields.postgresUrl }), process.env);
  const prisma = createPrismaClient({ connectionString: env.DATABASE_URL, poolMax: 1 });
  try {
    const generations = await prisma.generation.findMany({
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        gradeScale: { select: { confirmed: true, bands: true } },
      },
    });
    for (const generation of generations) {
      const scale = generation.gradeScale;
      const stored: GradeBandInput[] | null = scale?.confirmed ? scale.bands : null;
      const enrollments = await prisma.enrollment.findMany({
        where: { status: 'ENROLLED', offering: { generationId: generation.id, status: 'ACTIVE' } },
        select: {
          offering: {
            select: {
              visibility: true,
              schemes: {
                where: { status: 'PUBLISHED' },
                select: { items: { select: { criterionId: true, maxMark: true, weight: true } } },
              },
            },
          },
          scores: { select: { criterionId: true, status: true, mark: true } },
        },
      });
      const released: Counts = {};
      const hidden: Counts = {};
      const statuses: Counts = {};
      let differ = 0;
      for (const e of enrollments) {
        const result = computeCourseResult(
          e.offering.schemes[0]?.items ?? null,
          e.scores.flatMap((s) => (s.status === 'CLEARED' ? [] : [{ ...s, status: s.status }])),
        );
        statuses[result.status] = (statuses[result.status] ?? 0) + 1;
        if (result.status !== 'COMPLETE') continue;
        const letter = gradeFor(OFFICIAL_GRADE_BANDS, result.finalScore) ?? 'none';
        if (stored && gradeFor(stored, result.finalScore) !== letter) differ++;
        const bucket = e.offering.visibility === 'VISIBLE' ? released : hidden;
        bucket[letter] = (bucket[letter] ?? 0) + 1;
      }
      const line = (c: Counts) =>
        ['A', 'B', 'C', 'D', 'E', 'F', 'none']
          .filter((l) => c[l])
          .map((l) => `${l} ${c[l]}`)
          .join(', ') || 'none';
      process.stdout.write(
        [
          `Generation ${generation.code}`,
          `  stored scale: ${scale ? `${scale.bands.length} bands, ${scale.confirmed ? 'confirmed' : 'not confirmed'}` : 'none'}`,
          `  enrollments by status: ${JSON.stringify(statuses)}`,
          `  COMPLETE, released: ${line(released)}`,
          `  COMPLETE, hidden:   ${line(hidden)}`,
          `  stored grades changed: 0 (grades are never stored)`,
          stored ? `  stored scale differs from the official one for: ${differ}` : '',
        ]
          .filter(Boolean)
          .join('\n') + '\n',
      );
    }
    if (!generations.length) process.stdout.write('No generations.\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${(err as Error).message}\n`);
  process.exit(1);
});
