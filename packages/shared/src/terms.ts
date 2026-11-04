/**
 * Every generation has exactly this many terms. The database enforces the same limit with the
 * CHECK `terms_number_check` (number BETWEEN 1 AND 5); a test keeps the two equal.
 */
export const TERMS_PER_GENERATION = 5;
