/**
 * Loads a small demo dataset for local testing (never in production):
 *
 *   pnpm demo:seed                       # students sign in with the default demo password
 *   pnpm demo:seed -- --student-password "Another-Pass-2026"
 *
 * Creates generation GEN2026 (five terms), five course offerings over terms 1–2 with criteria and
 * published grading schemes (one left without a scheme, one hidden from students), three students
 * and their marks. Two students get a ready-to-use password; the third stays PENDING so the
 * "issue credentials" flow can be tried. Only inserts: it refuses to run if GEN2026 exists.
 */
import { parseArgs } from 'node:util';
import { createPrismaClient, type Prisma } from '@ssrs/database';
import { envFields, parseEnv } from '@ssrs/shared';
import { loadRootEnv, lockedPasswordHash } from '@ssrs/shared/node';
import { z } from 'zod';
import { checkPasswordPolicy, PASSWORD_POLICY_MESSAGES } from '../auth/password-policy.js';
import { PasswordService } from '../auth/password.service.js';

const DEFAULT_STUDENT_PASSWORD = 'Student-Pass-2026x';
const GENERATION = { code: 'GEN2026', name: 'Generation 2026', start: '2026-01-05' };

const COURSES = [
  { code: 'MATH101', name: 'Mathematics I', term: 1, credits: '3', visible: true, scheme: true },
  { code: 'ENG101', name: 'English I', term: 1, credits: '2', visible: true, scheme: true },
  { code: 'PHY101', name: 'Physics I', term: 1, credits: '3', visible: false, scheme: true },
  { code: 'MATH102', name: 'Mathematics II', term: 2, credits: '3', visible: true, scheme: true },
  { code: 'ART101', name: 'Art & Design', term: 2, credits: '1.5', visible: true, scheme: false },
] as const;

const CRITERIA = [
  { key: 'Q1', name: 'Quiz 1', category: 'QUIZ', maxMark: '10', weight: '10' },
  { key: 'HW', name: 'Homework', category: 'HOMEWORK', maxMark: '20', weight: '15' },
  { key: 'MID', name: 'Midterm exam', category: 'EXAM', maxMark: '50', weight: '30' },
  { key: 'FIN', name: 'Final exam', category: 'EXAM', maxMark: '100', weight: '45' },
] as const;

const STUDENTS = [
  { code: 'GEN26-0001', name: 'Sokha Chan', gender: 'FEMALE', active: true },
  { code: 'GEN26-0002', name: 'Dara Pich', gender: 'MALE', active: true },
  { code: 'GEN26-0003', name: 'Malis Keo', gender: 'FEMALE', active: false },
] as const;

/** student → course → criterion → mark ('ABS' = absent). Missing entries are "not entered". */
const MARKS: Record<string, Record<string, Record<string, string>>> = {
  'GEN26-0001': {
    MATH101: { Q1: '8.5', HW: '18', MID: '41', FIN: 'ABS' },
    ENG101: { Q1: '9', HW: '17.5' },
    PHY101: { Q1: '7' },
    MATH102: { Q1: '10', HW: '19', MID: '44', FIN: '88' },
  },
  'GEN26-0002': { MATH101: { Q1: '6', HW: '12', MID: '30', FIN: '64' } },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Map lookup for keys the dataset above guarantees; a typo in it fails loudly. */
function get<V>(map: Map<string, V>, key: string): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Demo dataset references unknown key "${key}"`);
  return value;
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: { 'student-password': { type: 'string' } },
    strict: true,
  });

  loadRootEnv();
  const env = parseEnv(
    z.object({ NODE_ENV: envFields.nodeEnv, DATABASE_URL: envFields.postgresUrl }),
    process.env,
  );
  if (env.NODE_ENV === 'production') fail('Refusing to load demo data with NODE_ENV=production.');

  const studentPassword = values['student-password'] ?? DEFAULT_STUDENT_PASSWORD;
  for (const s of STUDENTS) {
    const problems = checkPasswordPolicy(studentPassword, s.code);
    if (problems.length) fail(problems.map((p) => PASSWORD_POLICY_MESSAGES[p]).join(' '));
  }
  const passwordHash = await new PasswordService().hash(studentPassword);

  const prisma = createPrismaClient({ connectionString: env.DATABASE_URL, poolMax: 1 });
  try {
    if (await prisma.generation.findUnique({ where: { code: GENERATION.code } })) {
      fail(
        `Generation ${GENERATION.code} already exists; demo data is loaded only into a fresh database.`,
      );
    }
    const taken = await prisma.user.findMany({
      where: { username: { in: STUDENTS.map((s) => s.code) } },
      select: { username: true },
    });
    if (taken.length) fail(`Users already exist: ${taken.map((u) => u.username).join(', ')}.`);

    await prisma.$transaction(
      async (tx) => {
        const start = new Date(`${GENERATION.start}T00:00:00Z`);
        const generation = await tx.generation.create({
          data: {
            code: GENERATION.code,
            name: GENERATION.name,
            startDate: start,
            terms: {
              create: [1, 2, 3, 4, 5].map((n) => ({
                number: n,
                name: `Term ${n}`,
                startDate: new Date(start.getTime() + (n - 1) * 84 * DAY_MS),
                endDate: new Date(start.getTime() + (n * 84 - 3) * DAY_MS),
              })),
            },
          },
          include: { terms: true },
        });

        // offering id and criterion ids per course code
        const offerings = new Map<string, { id: string; criteria: Map<string, string> }>();
        for (const c of COURSES) {
          const course = await tx.course.upsert({
            where: { code: c.code },
            update: {},
            create: { code: c.code, name: c.name },
          });
          const term = get(
            new Map(generation.terms.map((t) => [String(t.number), t])),
            String(c.term),
          );
          const offering = await tx.courseOffering.create({
            data: {
              termId: term.id,
              generationId: generation.id,
              courseId: course.id,
              externalKey: `T${c.term}-${c.code}`,
              title: c.name,
              credits: c.credits,
              visibility: c.visible ? 'VISIBLE' : 'HIDDEN',
            },
          });
          const criteria = new Map<string, string>();
          for (const [i, k] of CRITERIA.entries()) {
            const row = await tx.assessmentCriterion.create({
              data: {
                offeringId: offering.id,
                key: k.key,
                name: k.name,
                category: k.category,
                displayOrder: i + 1,
              },
            });
            criteria.set(k.key, row.id);
          }
          if (c.scheme) {
            // Items can only be written while the scheme is a DRAFT (database trigger).
            const scheme = await tx.gradingScheme.create({
              data: { offeringId: offering.id, version: 1, origin: 'ADMIN', totalWeight: '100' },
            });
            await tx.gradingSchemeItem.createMany({
              data: CRITERIA.map((k) => ({
                schemeId: scheme.id,
                offeringId: offering.id,
                criterionId: get(criteria, k.key),
                maxMark: k.maxMark,
                weight: k.weight,
              })),
            });
            await tx.gradingScheme.update({
              where: { id: scheme.id },
              data: { status: 'PUBLISHED', publishedAt: new Date() },
            });
          }
          offerings.set(c.code, { id: offering.id, criteria });
        }

        for (const s of STUDENTS) {
          const user = await tx.user.create({
            data: {
              username: s.code,
              role: 'STUDENT',
              status: s.active ? 'ACTIVE' : 'PENDING',
              passwordHash: s.active ? passwordHash : lockedPasswordHash(),
              passwordChangedAt: s.active ? new Date() : null,
            },
          });
          const student = await tx.student.create({
            data: {
              studentCode: s.code,
              userId: user.id,
              generationId: generation.id,
              fullName: s.name,
              gender: s.gender,
              className: 'A1',
            },
          });
          for (const [code, offering] of offerings) {
            const enrollment = await tx.enrollment.create({
              data: { studentId: student.id, offeringId: offering.id },
            });
            const marks = MARKS[s.code]?.[code] ?? {};
            const scores: Prisma.AssessmentScoreCreateManyInput[] = Object.entries(marks).map(
              ([key, mark]) => ({
                enrollmentId: enrollment.id,
                offeringId: offering.id,
                criterionId: get(offering.criteria, key),
                status: mark === 'ABS' ? 'ABSENT' : 'RECORDED',
                mark: mark === 'ABS' ? '0' : mark,
              }),
            );
            if (scores.length) await tx.assessmentScore.createMany({ data: scores });
          }
        }

        await tx.auditLog.create({
          data: {
            actorType: 'SYSTEM',
            action: 'demo.seeded',
            entityType: 'generation',
            entityId: generation.id,
            metadata: { students: STUDENTS.length, offerings: COURSES.length },
          },
        });
      },
      { timeout: 60_000 },
    );

    const active = STUDENTS.filter((s) => s.active).map((s) => `${s.code} (${s.name})`);
    process.stdout.write(
      [
        `Loaded demo data: ${GENERATION.code}, ${COURSES.length} course offerings, ${STUDENTS.length} students.`,
        `Student sign-in: ${active.join(', ')} with password "${studentPassword}".`,
        `GEN26-0003 (Malis Keo) is PENDING: issue a password from the admin portal to test that flow.`,
        '',
      ].join('\n'),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
