-- Separate from the next migration: PostgreSQL cannot use a new enum value in the transaction
-- that adds it.
ALTER TYPE "SourceStatus" ADD VALUE 'PENDING';
