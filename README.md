# PostgreSQL data MCP for Codex

This is a local **read-only** MCP server. It lets Codex discover your PostgreSQL tables and retrieve data with filters, joins, and aggregate queries. It never stores your database password in Codex configuration.

## What Codex can do

After it is connected, you can ask things such as:

- “List the tables in my database.”
- “Show me the columns in `public.orders`.”
- “Find the 25 most recent paid orders for customer 42.”
- “Give me total revenue by month for 2026.”

The server first exposes table discovery tools, then uses:

- `query_table` for a single table and structured conditions (`equals`, ranges, contains a list, case-insensitive matches, ordering, limits).
- `run_readonly_sql` for joins and aggregates. Query values use PostgreSQL placeholders (`$1`, `$2`, ...), never string interpolation.

Every database tool runs in a PostgreSQL `READ ONLY` transaction, has a timeout, limits returned rows, and only allows schemas listed in `ALLOWED_SCHEMAS`.

## Optional write operations

Writes are disabled by default. To enable carefully controlled `INSERT`, `UPDATE`, and `DELETE` operations, set this in your private `.env` file and restart Codex:

```env
ENABLE_WRITE_OPERATIONS=true
```

The `execute_write_sql` MCP tool is labelled destructive so Codex requests approval. It also requires the literal confirmation `CONFIRM_WRITE`, exactly one parameterized statement, a `RETURNING` clause, and a `WHERE` clause for `UPDATE` and `DELETE`. Always ask Codex to show the matching rows before approving a change.

## 1. Make a least-privilege database user

Run the following in `psql` as a database administrator. Replace the database name, password, schema, and table names to match your system. Grant access only to tables Codex actually needs.

```sql
CREATE ROLE codex_mcp LOGIN PASSWORD 'use-a-long-unique-password';
GRANT CONNECT ON DATABASE your_database TO codex_mcp;
GRANT USAGE ON SCHEMA public TO codex_mcp;
GRANT SELECT ON TABLE public.orders, public.customers TO codex_mcp;

-- Keep the account read-only even if an application bug is introduced.
ALTER ROLE codex_mcp SET default_transaction_read_only = on;
```

If new tables will be created later and this account should be able to read them, have the table owner run the following (change the schema if necessary):

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT SELECT ON TABLES TO codex_mcp;
```

## 2. Configure the connection

Copy `.env.example` to `.env`, then set `DATABASE_URL` to the read-only account you made above. The `.env` file is ignored by Git.

```powershell
Copy-Item .env.example .env
```

For example:

```env
DATABASE_URL=postgresql://codex_mcp:your-password@127.0.0.1:5432/your_database
ALLOWED_SCHEMAS=public
ALLOWED_TABLES=public.orders,public.customers
```

`ALLOWED_TABLES` is optional but recommended. When you set it, `run_readonly_sql` is disabled so a free-form SQL query cannot bypass the table allow-list. For cross-table analytics, leave it blank and enforce table access through the database role grants instead.

## 3. Install and validate

```powershell
npm install
npm run check
```

The server uses standard input/output for MCP. Do not run `npm start` by itself in a normal terminal; Codex starts it when needed.

## 4. Connect it to Codex

From this folder, run:

```powershell
codex mcp add postgres-data -- node C:\sample_mcp\src\index.js
codex mcp list
```

Then restart the Codex desktop app (or open a fresh Codex session). In the desktop app, `/mcp` displays the connected server.

Codex stores this local MCP configuration in its host configuration. The ChatGPT desktop app, Codex CLI, and Codex IDE extension on the same host share that configuration. See the [official MCP documentation](https://developers.openai.com/codex/mcp/) for the supported local connection formats and settings.

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | PostgreSQL connection string. Required unless standard `PGHOST` variables are already set. |
| `ALLOWED_SCHEMAS` | `public` | Comma-separated schemas to expose. |
| `ALLOWED_TABLES` | empty | Optional `schema.table` allow-list. Disables free-form SQL when set. |
| `DEFAULT_ROW_LIMIT` | `100` | Rows returned unless the request asks for fewer. |
| `MAX_ROW_LIMIT` | `500` | Hard cap on rows returned (maximum 1,000). |
| `STATEMENT_TIMEOUT_MS` | `10000` | Time limit per query, maximum 60 seconds. |
| `DB_SSL_MODE` | `disable` | Use `require` if the database requires TLS. |

## Security notes

- Keep `.env` private; do not paste its contents into Codex chat, source control, or tickets.
- Use a separate, SELECT-only role—never an owner, superuser, or application write account.
- Keep `ALLOWED_SCHEMAS` narrow. Use `ALLOWED_TABLES` for ordinary lookups.
- Database permissions are the final security boundary. The MCP server’s checks are an additional guardrail, not a replacement for PostgreSQL grants.
