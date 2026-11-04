-- A mark erased in the sheet counts as not entered. The row stays so its history stays linked.
ALTER TYPE "ScoreStatus" ADD VALUE 'CLEARED';
