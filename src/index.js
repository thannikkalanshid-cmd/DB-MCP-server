import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const { Pool } = pg;

// Codex can launch an MCP server from any working directory. Always load the
// private connection settings from this project, not from the launch folder.
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: resolve(projectDirectory, ".env") });

const SERVER_NAME = "postgres-data";
const DEFAULT_ALLOWED_SCHEMAS = ["public"];
const MAX_SERVER_ROW_LIMIT = 1_000;
const MAX_TIMEOUT_MS = 60_000;
655555
function csv(value, fallback = []) {
  if (!value || !value.trim()) return fallback;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

const config = {
  allowedSchemas: new Set(csv(process.env.ALLOWED_SCHEMAS, DEFAULT_ALLOWED_SCHEMAS)),
  allowedTables: new Set(csv(process.env.ALLOWED_TABLES)),
  defaultRowLimit: positiveInteger(process.env.DEFAULT_ROW_LIMIT, 100, MAX_SERVER_ROW_LIMIT),
  maxRowLimit: positiveInteger(process.env.MAX_ROW_LIMIT, 500, MAX_SERVER_ROW_LIMIT),
  statementTimeoutMs: positiveInteger(process.env.STATEMENT_TIMEOUT_MS, 10_000, MAX_TIMEOUT_MS),
};

config.maxRowLimit = Math.max(config.defaultRowLimit, config.maxRowLimit);

let pool;

function databaseIsConfigured() {
  return Boolean(process.env.DATABASE_URL || process.env.PGHOST || process.env.PGHOSTADDR);
}

function getPool() {
  if (!databaseIsConfigured()) {
    throw new Error(
      "Database connection is not configured. Copy .env.example to .env and set DATABASE_URL.",
    );
  }

  if (!pool) {
    const ssl = process.env.DB_SSL_MODE === "require"
      ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" }
      : undefined;

    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "codex-postgres-mcp",
    });
  }

  return pool;
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function validateIdentifier(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 63) {
    throw new Error(`${label} must be a PostgreSQL identifier of 1 to 63 characters.`);
  }
}

function assertAllowedSchema(schema) {
  validateIdentifier(schema, "Schema");
  if (!config.allowedSchemas.has(schema)) {
    throw new Error(`Schema \"${schema}\" is not in ALLOWED_SCHEMAS.`);
  }
}

function assertAllowedTable(schema, table) {
  assertAllowedSchema(schema);
  validateIdentifier(table, "Table");

  if (
    config.allowedTables.size > 0 &&
    !config.allowedTables.has(`${schema}.${table}`)
  ) {
    throw new Error(`Table \"${schema}.${table}\" is not in ALLOWED_TABLES.`);
  }
}

async function inReadOnlyTransaction(work) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(config.statementTimeoutMs)]);
    await client.query("SELECT set_config('lock_timeout', '3000', true)");
    return await work(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection may not have reached BEGIN; releasing it is still safe.
    }
    client.release();
  }
}

async function tableColumns(client, schema, table) {
  assertAllowedTable(schema, table);
  const result = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [schema, table],
  );

  if (result.rows.length === 0) {
    throw new Error(`Table \"${schema}.${table}\" does not exist or is not accessible.`);
  }

  return new Set(result.rows.map((row) => row.column_name));
}

function assertKnownColumns(columns, knownColumns) {
  for (const column of columns) {
    validateIdentifier(column, "Column");
    if (!knownColumns.has(column)) {
      throw new Error(`Column \"${column}\" does not exist or is not accessible.`);
    }
  }
}

function safeJson(value) {
  return JSON.stringify(value, (_key, current) =>
    typeof current === "bigint" ? current.toString() : current,
  );
}

function jsonResult(value) {
  return {
    content: [{ type: "text", text: safeJson(value) }],
  };
}

function toolError(error) {
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  return {
    isError: true,
    content: [{ type: "text", text: safeJson({ error: message }) }],
  };
}

function requestHandler(handler) {
  return async (input) => {
    try {
      return await handler(input);
    } catch (error) {
      return toolError(error);
    }
  };
}

const filterSchema = z.object({
  column: z.string().min(1).max(63),
  operator: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "like", "ilike", "in", "is_null", "not_null"]).default("eq"),
  value: z.unknown().optional(),
});

const server = new McpServer(
  { name: SERVER_NAME, version: "1.0.0" },
  {
    instructions:
      "Use the discovery tools before retrieving data. This server is read-only: never ask it to change database data. Prefer query_table for filtered single-table lookups. Use run_readonly_sql only for joins, aggregates, or other cases query_table cannot express, and always pass values through params ($1, $2, ...).",
  },
);

server.tool(
  "database_health",
  "Check whether the read-only PostgreSQL connection is available. Does not reveal credentials.",
  {},
  requestHandler(async () => {
    const result = await inReadOnlyTransaction((client) =>
      client.query("SELECT current_database() AS database, current_user AS user, now() AS checked_at"),
    );
    return jsonResult({
      connected: true,
      database: result.rows[0].database,
      user: result.rows[0].user,
      checked_at: result.rows[0].checked_at,
      allowed_schemas: [...config.allowedSchemas],
      table_allow_list_enabled: config.allowedTables.size > 0,
      max_row_limit: config.maxRowLimit,
    });
  }),
);

server.tool(
  "list_schemas",
  "List database schemas that this MCP server is allowed to inspect.",
  {},
  requestHandler(async () => {
    const allowedSchemas = [...config.allowedSchemas];
    const result = await inReadOnlyTransaction((client) =>
      client.query(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1::text[]) ORDER BY schema_name",
        [allowedSchemas],
      ),
    );
    return jsonResult({ schemas: result.rows.map((row) => row.schema_name) });
  }),
);

server.tool(
  "list_tables",
  "List accessible base tables in one allowed schema. Call this before querying an unfamiliar database.",
  { schema: z.string().min(1).max(63).default("public") },
  requestHandler(async ({ schema }) => {
    assertAllowedSchema(schema);
    const result = await inReadOnlyTransaction((client) =>
      client.query(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = $1 AND table_type = 'BASE TABLE'
          ORDER BY table_name`,
        [schema],
      ),
    );

    const tables = result.rows
      .map((row) => row.table_name)
      .filter((table) => config.allowedTables.size === 0 || config.allowedTables.has(`${schema}.${table}`));
    return jsonResult({ schema, tables });
  }),
);

server.tool(
  "describe_table",
  "Show a table's columns, PostgreSQL types, nullability, and defaults. Use this before applying filters.",
  {
    schema: z.string().min(1).max(63).default("public"),
    table: z.string().min(1).max(63),
  },
  requestHandler(async ({ schema, table }) => {
    assertAllowedTable(schema, table);
    const result = await inReadOnlyTransaction((client) =>
      client.query(
        `SELECT column_name, data_type, udt_name, is_nullable, column_default, ordinal_position
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`,
        [schema, table],
      ),
    );
    if (result.rows.length === 0) {
      throw new Error(`Table \"${schema}.${table}\" does not exist or is not accessible.`);
    }
    return jsonResult({ schema, table, columns: result.rows });
  }),
);

server.tool(
  "query_table",
  "Retrieve rows from one approved table using safe, structured conditions. Values are always passed as query parameters.",
  {
    schema: z.string().min(1).max(63).default("public"),
    table: z.string().min(1).max(63),
    columns: z.array(z.string().min(1).max(63)).min(1).optional(),
    filters: z.array(filterSchema).default([]),
    order_by: z.array(z.object({
      column: z.string().min(1).max(63),
      direction: z.enum(["asc", "desc"]).default("asc"),
    })).default([]),
    limit: z.number().int().min(1).max(MAX_SERVER_ROW_LIMIT).optional(),
    offset: z.number().int().min(0).max(1_000_000).default(0),
  },
  requestHandler(async ({ schema, table, columns, filters, order_by: orderBy, limit, offset }) => {
    const requestedLimit = Math.min(limit ?? config.defaultRowLimit, config.maxRowLimit);
    const fetchLimit = requestedLimit + 1;

    const output = await inReadOnlyTransaction(async (client) => {
      const knownColumns = await tableColumns(client, schema, table);
      if (columns) assertKnownColumns(columns, knownColumns);

      const selectedColumns = columns
        ? columns.map(quoteIdentifier).join(", ")
        : "*";
      const values = [];
      const clauses = [];
      const operators = {
        eq: "=",
        ne: "!=",
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
        like: "LIKE",
        ilike: "ILIKE",
      };

      for (const filter of filters) {
        assertKnownColumns([filter.column], knownColumns);
        const column = quoteIdentifier(filter.column);

        if (filter.operator === "is_null") {
          clauses.push(`${column} IS NULL`);
          continue;
        }
        if (filter.operator === "not_null") {
          clauses.push(`${column} IS NOT NULL`);
          continue;
        }

        if (filter.value === undefined) {
          throw new Error(`Filter \"${filter.column}\" requires a value.`);
        }

        if (filter.value === null) {
          if (filter.operator === "eq") clauses.push(`${column} IS NULL`);
          else if (filter.operator === "ne") clauses.push(`${column} IS NOT NULL`);
          else throw new Error("null may only be used with eq or ne filters.");
          continue;
        }

        values.push(filter.value);
        const placeholder = `$${values.length}`;
        if (filter.operator === "in") {
          if (!Array.isArray(filter.value) || filter.value.length === 0) {
            throw new Error(`The in filter for \"${filter.column}\" requires a non-empty array.`);
          }
          clauses.push(`${column} = ANY(${placeholder})`);
        } else {
          const operator = operators[filter.operator];
          if (!operator) throw new Error(`Unsupported filter operator: ${filter.operator}`);
          clauses.push(`${column} ${operator} ${placeholder}`);
        }
      }

      const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      if (orderBy.length > 0) assertKnownColumns(orderBy.map((item) => item.column), knownColumns);
      const order = orderBy.length > 0
        ? ` ORDER BY ${orderBy.map((item) => `${quoteIdentifier(item.column)} ${item.direction.toUpperCase()}`).join(", ")}`
        : "";

      values.push(fetchLimit, offset);
      const query = `SELECT ${selectedColumns} FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}${where}${order} LIMIT $${values.length - 1} OFFSET $${values.length}`;
      const result = await client.query(query, values);
      const truncated = result.rows.length > requestedLimit;
      return {
        rows: truncated ? result.rows.slice(0, requestedLimit) : result.rows,
        row_count: Math.min(result.rows.length, requestedLimit),
        truncated,
        limit: requestedLimit,
        offset,
      };
    });

    return jsonResult(output);
  }),
);

server.tool(
  "run_readonly_sql",
  "Run one parameterized SELECT or WITH query for approved use cases such as joins and aggregates. This tool is disabled when ALLOWED_TABLES is set. Use $1, $2, ... placeholders with params; never put values directly into SQL.",
  {
    sql: z.string().min(1).max(50_000),
    params: z.array(z.unknown()).default([]),
    limit: z.number().int().min(1).max(MAX_SERVER_ROW_LIMIT).optional(),
  },
  requestHandler(async ({ sql, params, limit }) => {
    if (config.allowedTables.size > 0) {
      throw new Error("run_readonly_sql is disabled while ALLOWED_TABLES is set. Use query_table instead.");
    }

    const trimmedSql = sql.trim();
    if (!/^(select|with)\b/i.test(trimmedSql)) {
      throw new Error("Only a SELECT statement or a WITH query that returns rows is allowed.");
    }
    if (trimmedSql.includes(";")) {
      throw new Error("Only one statement is allowed; remove semicolons from the SQL.");
    }

    const requestedLimit = Math.min(limit ?? config.defaultRowLimit, config.maxRowLimit);
    const fetchLimit = requestedLimit + 1;
    const result = await inReadOnlyTransaction((client) =>
      client.query(
        `SELECT * FROM (${trimmedSql}) AS mcp_result LIMIT $${params.length + 1}`,
        [...params, fetchLimit],
      ),
    );
    const truncated = result.rows.length > requestedLimit;
    return jsonResult({
      rows: truncated ? result.rows.slice(0, requestedLimit) : result.rows,
      row_count: Math.min(result.rows.length, requestedLimit),
      truncated,
      limit: requestedLimit,
    });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
