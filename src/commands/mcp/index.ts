import { Command } from 'commander';
import { startMcpServer } from '../../mcp/server.js';
import { mcpOptionsFrom } from '../../mcp/compact.js';

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Start the MCP server for AI assistant integration (Claude, Cursor, VS Code, Windsurf)')
    .option('--surface <name>', 'compact: four discovery tools (find, describe, preview, run). legacy: one tool per command (default).')
    .option('--allow-write <ids>', 'comma-separated command IDs the operator permits as writes (compact: after a preview; legacy: registered as tools). Default: none, env INSTANTLY_MCP_ALLOW_WRITES')
    .option('--allow-sensitive <ids>', 'legacy only: comma-separated command IDs allowed to return credential material, e.g. dfy_orders_list_accounts, api_keys_list. Default: none, env INSTANTLY_MCP_ALLOW_SENSITIVE')
    .option('--allow-unknown-cost', 'compact only: also permit allowed writes whose cost is unknown')
    .addHelpText('after', `
MCP Configuration:

  For Claude Desktop / Cursor / VS Code, add to your MCP config:

  {
    "mcpServers": {
      "instantly": {
        "command": "npx",
        "args": ["instantly-cli", "mcp"],
        "env": {
          "INSTANTLY_API_KEY": "your-api-key"
        }
      }
    }
  }

  Or if installed globally:

  {
    "mcpServers": {
      "instantly": {
        "command": "instantly",
        "args": ["mcp"],
        "env": {
          "INSTANTLY_API_KEY": "your-api-key"
        }
      }
    }
  }

  Compact surface (four tools, schemas loaded on demand, writes preview-first):

  { "command": "instantly", "args": ["mcp", "--surface", "compact"] }

  Default exposure is a reviewed read allowlist on both surfaces. Writes are refused unless the
  operator adds --allow-write <command ids> (or INSTANTLY_MCP_ALLOW_WRITES). On the legacy surface,
  credential-bearing reads such as password exports need --allow-sensitive <command ids>.
  These are startup settings; a model cannot change them through tool arguments.

  Agency: name every client as a profile (login --profile <client>) and start one server per client
  with INSTANTLY_PROFILE=<slug> or --profile <slug>. A server is pinned to that one profile for its
  whole life; a different profile in a tool call is refused. Legacy write tools also need
  workspace_id matching the workspace shown by the status tool.`)
    .action(async (flags: { surface?: string; allowWrite?: string; allowSensitive?: string; allowUnknownCost?: boolean }) => {
      process.on('SIGINT', () => process.exit(0));
      process.on('SIGTERM', () => process.exit(0));

      try {
        await startMcpServer(mcpOptionsFrom({ ...flags, profile: program.opts().profile }));
      } catch (error: any) {
        console.error('Failed to start MCP server:', error.message ?? error);
        process.exit(1);
      }
    });
}
