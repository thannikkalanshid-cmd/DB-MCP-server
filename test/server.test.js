import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function withClient(run, cwd = process.cwd()) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("src/index.js")],
    cwd,
    stderr: "pipe",
  });
  const client = new Client({ name: "postgres-data-mcp-test", version: "1.0.0" });

  await client.connect(transport);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

test("advertises the database discovery and read-only query tools", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        "database_health",
        "describe_table",
        "execute_write_sql",
        "list_schemas",
        "list_tables",
        "query_table",
        "run_readonly_sql",
      ],
    );
  });
});

test("rejects writes while write operations are disabled", async () => {
  await withClient(async (client) => {
    const response = await client.callTool({
      name: "execute_write_sql",
      arguments: {
        sql: "DELETE FROM public.employees WHERE id = $1 RETURNING id",
        params: [-1],
        confirmation: "CONFIRM_WRITE",
      },
    });

    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /Write operations are disabled/i);
  });
});

test("starts successfully when Codex launches it from another directory", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    assert.equal(tools.some((tool) => tool.name === "database_health"), true);
  }, process.env.TEMP ?? process.cwd());
});

test("rejects SQL that contains multiple statements before connecting to a database", async () => {
  await withClient(async (client) => {
    const response = await client.callTool({
      name: "run_readonly_sql",
      arguments: { sql: "SELECT 1; SELECT 2" },
    });

    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /remove semicolons/i);
  });
});
