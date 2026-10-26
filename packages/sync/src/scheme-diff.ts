import { tryDecimal } from '@ssrs/shared';

export interface SchemeItemLike {
  criterionId: string;
  maxMark: { toString(): string };
  weight: { toString(): string };
}

function same(a: { toString(): string }, b: { toString(): string }): boolean {
  const x = tryDecimal(a.toString());
  const y = tryDecimal(b.toString());
  return x !== null && y !== null && x.eq(y);
}

/** True when both schemes contain the same criteria with numerically equal max marks and weights. */
export function sameSchemeItems(
  a: readonly SchemeItemLike[],
  b: readonly SchemeItemLike[],
): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(b.map((i) => [i.criterionId, i]));
  return a.every((item) => {
    const other = byId.get(item.criterionId);
    return (
      other !== undefined && same(item.maxMark, other.maxMark) && same(item.weight, other.weight)
    );
  });
}
