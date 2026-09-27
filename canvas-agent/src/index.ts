#!/usr/bin/env node
import { startHttpServer } from "./server/http.js";
import { startMcpServer } from "./server/mcp.js";
import { runStoryCli } from "./story-pipeline/cli.js";

if (process.argv[2] === "mcp") await startMcpServer();
else if (process.argv[2] === "story") await runStoryCli(process.argv.slice(3));
else startHttpServer();
