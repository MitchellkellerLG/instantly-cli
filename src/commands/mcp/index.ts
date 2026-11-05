import { Command } from 'commander';
import { startMcpServer } from '../../mcp/server.js';
import { mcpOptionsFrom } from '../../mcp/compact.js';

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Start the MCP server for AI assistant integration (Claude, Cursor, VS Code, Windsurf)')
    .option('--surface <name>', 'compact: four discovery tools (find, describe, preview, run). legacy: one tool per command (default).')
    .option('--allow-write <ids>', 'compact only: comma-separated command IDs the operator permits to execute after a preview (default: none)')
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

  Writes are refused unless the operator adds --allow-write <command ids>.
  Legacy stays the default and keeps one tool per command, with no preview enforcement.

  Agency: name every client as a profile (login --profile <client>).
  set INSTANTLY_PROFILE=<slug>. Every tool accepts profile.
  Mutating tools require profile + workspace_id matching the bound pair.
  Call status first (slug, workspace_id, workspace_name). One process, one profile.`)
    .action(async (flags: { surface?: string; allowWrite?: string; allowUnknownCost?: boolean }) => {
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
