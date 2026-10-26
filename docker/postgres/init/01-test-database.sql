-- Runs once when the local PostgreSQL volume is first created.
-- A separate database for integration tests so they never touch development data.
SELECT format('CREATE DATABASE %I OWNER %I', current_database() || '_test', current_user)
\gexec
