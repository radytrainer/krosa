#!/usr/bin/env bash
# Runs one database command against exactly one, named database, or refuses.
#
#   scripts/db-guard.sh <expected-database> <database-url> <command> [args...]
#
# Checks, before anything runs:
#   - the expected name, the URL and the command are all non-empty;
#   - the database name parsed from the URL is exactly <expected-database>
#     (an empty name would make PostgreSQL fall back to the user's own database);
#   - `ssrs` (the dev database, real student data) is refused unless
#     DB_GUARD_ALLOW_SSRS=yes is set for this one run, after explicit approval.
# Then prints the host and database, and runs the command with DATABASE_URL set to <database-url>.
#
# Command `psql` is special: it runs psql in the Postgres container (DB_GUARD_PG_CONTAINER,
# default student-score-system-postgres-1) against the checked database, with ON_ERROR_STOP=1
# and the URL's user and password. Use it for SQL; use any other command (pnpm db:deploy,
# npx prisma migrate deploy, node script.mjs) as is.
#
# Examples:
#   scripts/db-guard.sh ssrs_copy_20261112 "$COPY_URL" pnpm --filter @ssrs/database migrate:deploy
#   scripts/db-guard.sh ssrs_copy_20261112 "$COPY_URL" psql -c 'SELECT 1'
#   scripts/db-guard.sh postgres "$ADMIN_URL" psql -c 'CREATE DATABASE ssrs_copy_20261112'
set -euo pipefail

die() {
  echo "db-guard: $*" >&2
  exit 2
}

expected="${1:-}"
url="${2:-}"
[ -n "$expected" ] || die 'missing <expected-database>'
[ -n "$url" ] || die 'missing or empty <database-url>'
shift 2
[ "$#" -gt 0 ] || die 'missing <command>'

case "$url" in
  postgres://* | postgresql://*) ;;
  *) die 'the URL must start with postgres:// or postgresql://' ;;
esac

# postgresql://user:pass@host:port/name?params
rest="${url#*://}"
authority="${rest%%/*}"
[ "$authority" != "$rest" ] || die 'the URL has no database name (it would default to the user database)'
path="${rest#*/}"
name="${path%%\?*}"
[ -n "$name" ] || die 'the URL has no database name (it would default to the user database)'
case "$name" in */* | *' '*) die "unexpected database name: $name" ;; esac
hostport="${authority##*@}"
userinfo=''
[ "$hostport" = "$authority" ] || userinfo="${authority%@*}"

[ "$name" = "$expected" ] || die "the URL names database '$name', not '$expected'; refusing"
if [ "$name" = 'ssrs' ] && [ "${DB_GUARD_ALLOW_SSRS:-}" != 'yes' ]; then
  die "'ssrs' holds real student data: set DB_GUARD_ALLOW_SSRS=yes only after explicit approval"
fi

echo "db-guard: host=$hostport database=$name command=$1" >&2

if [ "$1" = 'psql' ]; then
  shift
  user="${userinfo%%:*}"
  pass=''
  [ "$userinfo" = "$user" ] || pass="${userinfo#*:}"
  [ -n "$user" ] || die 'the URL has no user name'
  container="${DB_GUARD_PG_CONTAINER:-student-score-system-postgres-1}"
  # The password is URL-encoded in the URL; decode %XX for psql.
  pass="$(printf '%b' "${pass//%/\\x}")"
  exec docker exec -i -e PGPASSWORD="$pass" "$container" \
    psql -v ON_ERROR_STOP=1 -X -q -U "$user" -d "$name" "$@"
fi

DATABASE_URL="$url" exec "$@"
