# Instantly CLI

**Instantly.ai in your terminal.** Run cold email campaigns, manage leads, monitor deliverability, and automate every outbound motion — from a single command line.

274 command definitions shared by the CLI and MCP, covering all 255 operations in the pinned [Instantly.ai public V2 API spec](https://api.instantly.ai/openapi/api_v2.json), plus retained upstream commands. Built for humans, scripts, CI/CD pipelines, and AI agents.

```bash
npm install -g instantly-cli
```

---

## API coverage and maintenance

This fork extends [Brandon Charleson's original CLI](https://github.com/bcharleson/instantly-cli) with 103 generated command definitions. One definition drives both the CLI and MCP. Coverage counts unique HTTP method and path pairs, normalizing parameter names and trailing slashes. Coverage proves endpoint availability against the spec, not live service behavior or complete parameter coverage in legacy commands. Tests use mocked HTTP only, with no real API keys.

| Public API path group | Upstream covered | This fork covered / spec |
|---|---:|---:|
| account-campaign-mappings | 1 | 1 / 1 |
| accounts | 14 | 16 / 16 |
| agent-items | 0 | 2 / 2 |
| api-keys | 3 | 3 / 3 |
| audit-logs | 1 | 1 / 1 |
| background-jobs | 2 | 2 / 2 |
| block-lists-entries | 5 | 9 / 9 |
| campaigns | 15 | 19 / 19 |
| crm-actions | 2 | 2 / 2 |
| custom-tag-mappings | 1 | 1 / 1 |
| custom-tags | 6 | 6 / 6 |
| dfy-email-account-orders | 7 | 7 / 7 |
| domains | 0 | 3 / 3 |
| emails | 8 | 9 / 9 |
| inbox-placement-analytics | 5 | 5 / 5 |
| inbox-placement-reports | 2 | 2 / 2 |
| inbox-placement-tests | 6 | 6 / 6 |
| lead-labels | 6 | 6 / 6 |
| lead-lists | 6 | 6 / 6 |
| leads | 12 | 13 / 13 |
| oauth | 0 | 3 / 3 |
| supersearch-enrichment | 10 | 27 / 27 |
| subsequences | 8 | 11 / 11 |
| email-verification | 2 | 2 / 2 |
| webhook-events | 4 | 4 / 4 |
| webhooks | 8 | 8 / 8 |
| workspace-billing | 2 | 2 / 2 |
| workspace-group-members | 5 | 5 / 5 |
| workspace-members | 5 | 5 / 5 |
| workspaces | 6 | 8 / 8 |
| ai-agents | 0 | 61 / 61 |
| **Total** | **152** | **255 / 255** |

The 15 off-spec operations in `custom-prompt-templates`, `sales-flow`, and `email-templates` remain available and show `[Undocumented API]` in CLI help and MCP descriptions. Their availability is not guaranteed by the public spec.

### Generated commands

New command names use the spec's operation ID in kebab case. Discover options with `instantly <group> --help` and `instantly <group> <command> --help`. New groups include `ai-agents`, `agent-items`, `company-lists`, `saved-searches`, and `domains`. New OAuth operations share the existing `oauth` group.

Generated commands accept request bodies through `--body '<json>'`. MCP callers can pass a native JSON object in `body`. Path and query parameters have individual flags; numbers, booleans, and arrays accept JSON values. JSON schemas validate nested bodies before HTTP. Server defaults are preserved rather than inserted locally.

```bash
instantly saved-searches list-saved-searches --limit 20
instantly ai-agents list-lead-finder-agents --help
instantly --profile client-a --workspace '<bound-workspace-uuid>' \
  domains update-domain-forwarding --domain example.com \
  --body '{"forwarding_domain":"destination.com","forwarding_mode":"redirect"}'
```

The existing agency guard applies to every generated command. Reads under a profile verify the live workspace. Every new non-GET operation, including PUT and POST previews, requires the bound workspace UUID under a profile. For MCP, pass `profile` and matching `workspace_id` for mutations. Account destination IDs in a body do not replace this source-workspace confirmation.

### Updating the spec

```bash
# Fetch the public documentation only. No API key is needed.
curl --fail --location https://api.instantly.ai/openapi/api_v2.json -o spec/api_v2.json
npm run spec:generate
npm run spec:generated-check
npm run spec:check
npm run typecheck
npm test -- --maxWorkers=2 --minWorkers=1
npm run build
npm run smoke:coverage
```

Review generated changes before committing. The generator resolves local references, rejects unsupported request content and parameter locations, and generates only operations absent from hand-written definitions. It uses the existing command registry and fails on name collisions. Generated request schemas retain the API's original validation rules; AJV enforces conditions and exclusive unions that MCP's Zod schema view cannot fully express. Unsupported external or recursive request references fail generation rather than silently widening validation.

`npm run spec:check` checks the pinned spec offline. `npm run spec:check -- --live` fetches the public spec and fails on uncovered operations. CI runs both checks on pull requests, default-branch pushes, weekly, and manually. A failed live check requires a reviewed spec refresh and regeneration. No CI step calls authenticated Instantly endpoints.

### Credits and license

Maintained in [LeadGrowGTM/instantly-cli](https://github.com/LeadGrowGTM/instantly-cli). Original implementation and project history: [Brandon Charleson](https://github.com/bcharleson/instantly-cli). API coverage extension and maintenance: [Mitchell Keller](https://github.com/MitchellkellerLG). Selected capabilities were independently implemented after comparison with [Instantly.ai's official @instantlyai/cli 0.2.7](https://www.npmjs.com/package/@instantlyai/cli).

Both upstream packages declare MIT. Brandon Charleson's repository has no LICENSE file as inspected on 2026-10-29. The official npm tarball also has no LICENSE file; its README says MIT. Its linked [GitLab source](https://gitlab.com/foomonk/instantly-cli) required sign-in, so the versioned sources embedded in its published sourcemaps were used for comparison. This fork supplies MIT text and credits both upstreams in [LICENSE](LICENSE); this does not imply either upstream supplied a license file.

The package and binary names remain unchanged. The existing npm install commands refer to the upstream package; this fork has not been published to npm. To use this fork, clone this repository, run `npm ci` and `npm run build`, then run `node dist/index.js --help` from the repository root.

### Official CLI coalesce

The official 0.2.7 package registers 167 command definitions across 31 groups, plus login, logout, OAuth, and MCP entrypoints (its README advertises 156 tools). All official command names are already present here; 163 endpoint declarations match, while four undocumented sales-flow paths differ. The comparison retains this fork's 274 definitions, 255/255 public API endpoint coverage, generated-command design, and profile/workspace guards. The adopted features extend existing definitions for both CLI and MCP:

| Official feature | Disposition | Result or reason |
|---|---|---|
| Account creation settings | Adopted | Reply-to, tracking domain, CNAME override, warmup JSON, warmup tag, slow ramp, placement limit, sending gap, provider code. Provider descriptions follow the pinned spec. |
| Webhook delivery headers and custom label creation | Adopted | `webhooks create --custom-interest-value` and `create`/`update --headers`. Headers accept CLI JSON or native MCP objects; invalid values fail before HTTP. |
| Workspace-member pagination and invitation filter | Adopted | `--limit`, `--starting-after`, `--accepted true/false`. False stays false; omitted options preserve server defaults. |
| Reply reminders and assignment | Adopted | `email reply --reminder-ts <iso> --assigned-to <uuid>`, retaining recipient validation. |
| Array input handling | Adopted | Warmup enable/disable, lead move, bulk assignment, and subsequence move accept CSV, JSON array strings, or native MCP arrays before schema validation. Campaign bulk actions already support these forms. |
| Lead list/move request mapping and AI template IDs | Adopted | Lead-list `--campaign-id` maps to API `campaign`; move `--lead-ids`/`--from-campaign-id` map to `ids`/`campaign`. AI `--template-id` accepts strings. Existing CLI and MCP input names remain compatible. |
| Campaigns, leads, accounts, email, analytics, webhooks, enrichment, workspace, billing, and remaining groups | Already covered | All 167 official command names exist here; 163 endpoint declarations match. This fork also retains extra handwritten and generated commands. Endpoint coverage does not imply every legacy parameter is covered. |
| API-key flag/env/config, interactive login, OAuth | Already covered | Retain our bound profiles and live workspace checks. The official auth model has one stored key and no profile guard. |
| JSON, pretty JSON, quiet, field selection | Already covered | Same output modes. No CSV or table renderer found in the published official implementation. |
| MCP stdio, shared registry, Claude/Gemini/agent guidance | Already covered | Retain our additional status and health tools and workspace confirmation. |
| Retry, timeouts, rate limits, HTML conversion | Already covered | Retain our HTTP client, sequence normalization, and delivery diagnostics. |
| Official API-base-URL environment override | Skipped | Not needed for the requested capabilities; mocked fetch already supports offline testing without redirecting credentials. |
| Official plural `/sales-flows` paths | Skipped | Four official definitions use `/sales-flows`; this fork retains its existing `/sales-flow` paths. Neither is in the pinned public spec, so changing them is deferred without live validation. |
| Official auth replacement, formatting-only refactors, release tooling | Skipped | No new user capability; replacing auth would discard profile/workspace isolation. |

Examples (profiled writes still require `--workspace`):

```bash
instantly --profile client-a --workspace '<bound-workspace-uuid>' webhooks create \
  --url https://example.com/hook --custom-interest-value 3 --headers '{"X-Source":"outreach"}'
instantly --profile client-a workspace-members list --accepted false --limit 20
instantly --profile client-a --workspace '<bound-workspace-uuid>' accounts warmup-enable \
  --account-ids '["sender1@example.com","sender2@example.com"]'
```

## What is Instantly?

[Instantly.ai](https://instantly.ai) is the leading cold email and outbound sales platform. It handles everything needed to run high-volume outbound at scale:

- **Email infrastructure** — connect unlimited sending accounts (Google Workspace, Microsoft 365, SMTP/IMAP), auto-rotate senders, manage warmup
- **Campaign management** — multi-step email sequences with A/B testing, scheduling, and conditional logic
- **Lead management** — import, enrich, deduplicate, and track prospects across campaigns
- **Deliverability** — inbox placement testing, sender reputation monitoring, blocklist management, and warmup analytics
- **Unified inbox** — read, reply, and forward across all sending accounts from one place
- **AI features** — AI-powered lead labeling, interest classification, and response handling

## What This CLI Enables

The Instantly CLI provides access to the public API. Some dashboard features have no public API endpoint.

**Campaign operations** — create campaigns, add leads, launch sequences, pause/resume, duplicate, and monitor sending status without opening a browser.

**Lead lifecycle** — import leads in bulk, move them between campaigns, update interest status, merge duplicates, assign to subsequences, and manage labels — all scriptable.

**Account management** — connect sending accounts, enable/disable warmup, test DNS/SMTP/IMAP health, pause underperforming senders, and monitor CTD (click-to-deliver) status.

**Deliverability monitoring** — run inbox placement tests, analyze where emails land (inbox vs. spam vs. promotions), track ESP-level performance, and get actionable insights.

**Analytics & reporting** — pull campaign stats, daily breakdowns, per-step sequence analytics, warmup performance, and account-level sending volumes into any reporting tool.

**Team & workspace admin** — manage workspace members, API keys, billing info, audit logs, and whitelabel domains.

**AI agent integration** — every command works as both a CLI subcommand and an MCP tool, so AI assistants (Claude, Cursor, Windsurf) can manage your outbound directly.

---

## Install

### npm (recommended)

```bash
npm install -g instantly-cli
```

### npx (zero-install)

```bash
npx instantly-cli campaigns list
```

### From source

```bash
git clone https://github.com/LeadGrowGTM/instantly-cli.git
cd instantly-cli
npm install && npm run build
npm link
```

---

## Authentication

Default mode is **one workspace, one key**. Existing single-key users do not need profiles.

Resolve order **without** `--profile` / `INSTANTLY_PROFILE`:

1. **`--api-key` flag** — pass on any command: `instantly campaigns list --api-key <key>`
2. **Environment variable** — `export INSTANTLY_API_KEY=your-key`
3. **cwd `.env`** — `INSTANTLY_API_KEY` in a local `.env` file
4. **Stored config** — run `instantly login` to save your key to `~/.instantly/config.json` (mode `0600`)

Get your API key from [app.instantly.ai/app/settings/integrations](https://app.instantly.ai/app/settings/integrations).

### For AI agents and scripts

Set the environment variable — no interactive prompts, no config files:

```bash
export INSTANTLY_API_KEY=your-key
instantly campaigns list
```

### Interactive login (default / single-key)

```bash
instantly login
# Prompts for your API key, validates it, stamps api_key + workspace_id + workspace_name onto ~/.instantly/config.json
```

`npx instantly-cli campaigns list` keeps working with one key. `--profile` is not required for old single-key users.

### Opt-in workspace profiles (agency / agent mode)

Profiles are **opt-in** and live **beside** the default config, never inside it:

`~/.instantly/profiles/<slug>.json` = `{ api_key, workspace_id, workspace_name }` (mode `0600`)

Rules, fail-closed:

- One process, one workspace. There is no `--all-profiles` and no comma-separated key list.
- `instantly login --profile acme` validates the key, GETs the live workspace, and binds that workspace UUID + name. It **does not** write or overwrite `~/.instantly/config.json`.
- Commands accept `--profile <slug>` and/or `INSTANTLY_PROFILE=<slug>`.
- When a profile is selected, it wins over a leftover cwd `.env` `INSTANTLY_API_KEY`.
- Every profiled command re-fetches the live workspace. If `workspace.id` ≠ the bound id, the command aborts.
- Write commands (campaign activate/pause, leads bulk-add, email reply/forward, and other mutations) also require `--workspace <uuid>` matching the bound id.
- When `--workspace` is passed on any path (default or profile), the live workspace id must match or the command aborts. Omitted on the default single-key path: no extra flag required.

```bash
# Bind a client workspace to a named profile (does not touch default login)
instantly login --profile acme --api-key "$ACME_KEY"
instantly login --profile client-a --api-key "$CLIENT_A_KEY"

# Read-only: profile is enough
instantly --profile acme campaigns list
INSTANTLY_PROFILE=client-a instantly status

# Writes must confirm the bound workspace UUID
instantly --profile acme --workspace 11111111-1111-4111-8111-111111111111 \
  campaigns activate 33333333-3333-4333-8333-333333333333

# Inspect / manage profiles (never prints API keys)
instantly profile list
instantly profile whoami
instantly profile remove acme
```

`instantly status` / `whoami` / `profile list` always print `profile` (slug or `default`), `workspace_id`, `workspace_name`, and `source`. They never print the API key. Confirm this bound pair before campaigns, health, or writes. Agencies should `login --profile <client>` for every key, including the house org.

Every existing command group (campaigns, leads, accounts, email, analytics, health, webhooks, oauth, …) uses this same resolver. There is no second, profile-only API.

After merge, dogfood with fake slugs `client-a` / `client-b` (your real keys stay local):

```bash
instantly status                                          # default: profile "default" + bound workspace id/name
instantly login --profile client-a --api-key "$CLIENT_A_KEY"
# confirm ~/.instantly/config.json is unchanged
instantly --profile client-a status                       # prints bound workspace id + name
instantly --profile client-a campaigns list
instantly --profile client-a health
instantly --profile client-a --workspace "$WRONG_UUID" campaigns activate "$CAMPAIGN_ID"
# → abort; no mutation
# two files in ~/.instantly/profiles; never one command looping both
```

---

## Quick Start

```bash
# Authenticate
instantly login

# List campaigns
instantly campaigns list

# Create a campaign and start sending
instantly campaigns create --name "Q2 Outreach"
instantly leads bulk-add --campaign-id <id> --leads '[{"email":"cto@startup.com","first_name":"Alex"}]'
instantly campaigns activate <id>

# Check analytics
instantly analytics campaign --id <id>

# Read replies
instantly email list --campaign-id <id> --is-read false

# Connect a Google sending account via OAuth
instantly oauth connect google
```

---

## Output Formats

Every command outputs JSON by default — ready for piping to `jq`, parsing in scripts, or feeding to other tools.

```bash
# Default: compact JSON
instantly campaigns list

# Pretty-printed JSON
instantly campaigns list --pretty

# Select specific fields
instantly campaigns list --fields "id,name,status"

# Suppress output (exit code only)
instantly campaigns list --quiet
```

---

## Commands

### Profiles

Opt-in named workspace profiles for agents that must isolate client keys.

```bash
instantly login --profile acme --api-key <key>        # Bind key → workspace; does not write config.json
instantly profile add acme --api-key <key>            # Same persist path as login --profile
instantly profile list                                # Slug + workspace id/name only
instantly profile whoami                              # Source + profile + live workspace
instantly profile remove acme                         # Deletes the profile file only
```

### Health

Read-only rollup of existing API data for the active profile or default key: disconnected accounts, bounce totals, warmup status, and campaign sending status.

```bash
instantly health
instantly --profile acme health
```

### Campaigns (11)

Create, manage, and control outbound email campaigns.

```bash
instantly campaigns list                              # List all campaigns (paginated)
instantly campaigns get <id>                          # Get full campaign details
instantly campaigns create --name "Q2 Outreach"       # Create a new campaign
instantly campaigns update <id> --name "Q2 Updated"   # Update campaign settings
instantly campaigns activate <id>                     # Start sending
instantly campaigns pause <id>                        # Pause sending
instantly campaigns duplicate <id>                    # Clone a campaign
instantly campaigns search-by-contact --email "a@b.com"  # Find campaigns containing a lead
instantly campaigns count-launched                    # Count active campaigns
instantly campaigns sending-status <id>               # Diagnose why a campaign isn't sending
instantly campaigns delete <id>                       # Delete permanently
```

Instantly delivers HTML. Pass readable copy with real line breaks in each variant body; the CLI converts plain-text newlines to `<br/>`/`<p>`. Do not write a run-on string. Existing HTML is left unchanged. Skipped when text_only.

Applies to `campaigns create` / `update` and `subsequences create` (same Instantly `body` key).

delay on step N waits before step N+1. First email does not wait. Pass delay_unit (minutes|hours|days; omitted unit is set to days). Instantly uses only `sequences[0]`. A multi-step sequence with delay 0 or missing delay on a non-last step is rejected — the follow-up would send the same day. Last step delay may be 0. `email_gap` is a per-send rate limit, not the step gap. `pre_delay` is subsequence-only.

```bash
# Preferred: readable copy with real line breaks — CLI converts
instantly campaigns create --name "Plain Body" --sequences \
  '[{"steps":[{"type":"email","delay":3,"delay_unit":"days","variants":[{"subject":"Hi {{first_name}}","body":"Hi {{first_name}},\n\nWorth a quick chat?"}]},{"type":"email","delay":0,"delay_unit":"days","variants":[{"subject":"Re: Hi","body":"Just bumping this."}]}]}]'

# Already tagged HTML is stored as-is (single email: last-step delay may be 0)
instantly campaigns create --name "With Sequences" --sequences \
  '[{"steps":[{"type":"email","delay":0,"delay_unit":"days","variants":[{"subject":"Hi {{first_name}}","body":"<div>Hello</div>"}]}]}]'
```

### Leads (12)

Import, manage, and move prospects across campaigns.

```bash
instantly leads list --campaign-id <id>               # List leads in a campaign
instantly leads get <id>                              # Get lead details
instantly leads create --email "a@b.com" --campaign-id <id>  # Add a single lead
instantly leads update <id> --first-name "Jane"       # Update lead data
instantly leads bulk-add --campaign-id <id> --leads '[{"email":"a@b.com"}]'  # Add up to 1,000 leads
instantly leads bulk-delete --campaign-id <id> --delete-all  # Remove leads in bulk
instantly leads bulk-assign --lead-ids "id1,id2" --account-id <id>  # Assign leads to senders
instantly leads move --lead-ids "id1,id2" --to-campaign-id <id>  # Move between campaigns
instantly leads merge --lead-ids "id1,id2"            # Merge duplicate leads
instantly leads update-interest-status --lead-id <id> --interest-status 1  # Set interest level
instantly leads remove-from-subsequence --lead-id <id> --subsequence-id <id>
instantly leads delete <id>                           # Delete a lead
```

### Email Accounts (12)

Connect and manage sending accounts — SMTP/IMAP, Google, or Microsoft.

```bash
instantly accounts list                               # List all sending accounts
instantly accounts get <id>                           # Get account details
instantly accounts create --email "..." --smtp-host "..."  # Connect SMTP/IMAP account
instantly accounts update <email> --daily-limit 50    # Update account settings
instantly accounts warmup-enable --account-ids "id1,id2"  # Start warmup
instantly accounts warmup-disable --account-ids "id1,id2"  # Stop warmup
instantly accounts test-vitals <id>                   # Run DNS/SMTP/IMAP health checks
instantly accounts pause <email>                      # Pause an account
instantly accounts resume <email>                     # Resume a paused account
instantly accounts mark-fixed <email>                 # Clear error flags
instantly accounts ctd-status                         # Check click-to-deliver status
instantly accounts delete <id>                        # Remove account
```

### Email / Unified Inbox (8)

Read and respond to emails across all sending accounts.

```bash
instantly email list                                  # List all emails
instantly email list --campaign-id <id> --is-read false  # Unread replies for a campaign
instantly email get <id>                              # Get email content
instantly email reply --reply-to-uuid <id> --eaccount "user@domain.com" --subject "Re: Hello" --body-text "Thanks!"
instantly email forward --forward-uuid <id> --eaccount "user@domain.com" --to "team@co.com"
instantly email update <id> --is-read true            # Update email properties
instantly email delete <id>                           # Delete an email
instantly email mark-read <thread-id>                 # Mark entire thread as read
instantly email unread-count                          # Count unread emails
```

### Analytics (6)

Measure campaign performance at every level.

```bash
instantly analytics campaign                          # Stats for all campaigns
instantly analytics campaign --id <id>                # Stats for one campaign
instantly analytics campaign-overview                 # Aggregated overview
instantly analytics daily-campaign --campaign-id <id> # Day-by-day breakdown
instantly analytics campaign-steps --campaign-id <id> # Per-step sequence analytics
instantly analytics daily-account                     # Daily sending volume per account
instantly analytics warmup --emails "user@domain.com" # Warmup performance
```

### Webhooks (8)

Subscribe to real-time events from your campaigns.

```bash
instantly webhooks list                               # List all webhooks
instantly webhooks get <id>                           # Get webhook details
instantly webhooks create --url "https://..." --event-type lead_interested
instantly webhooks update <id> --url "https://..."    # Update webhook
instantly webhooks test <id>                          # Fire a test payload
instantly webhooks event-types                        # List available event types
instantly webhooks resume <id>                        # Re-enable a suspended webhook
instantly webhooks delete <id>                        # Delete webhook
```

### Webhook Events (4)

Inspect webhook delivery history.

```bash
instantly webhook-events list                         # List webhook events
instantly webhook-events get <id>                     # Get event details
instantly webhook-events summary                      # Event delivery summary
instantly webhook-events summary-by-date              # Summary grouped by date
```

### Lead Lists (6)

Manage reusable lead lists for imports and enrichment.

```bash
instantly lead-lists list                             # List all lead lists
instantly lead-lists get <id>                         # Get list details
instantly lead-lists create --name "Q2 Prospects"     # Create a list
instantly lead-lists update <id> --name "Updated"     # Rename a list
instantly lead-lists verification-stats <id>          # Email verification breakdown
instantly lead-lists delete <id>                      # Delete a list
```

### Enrichment / SuperSearch (10)

Enrich leads with company and contact intelligence.

```bash
instantly enrichment enrich --search-filters '{"job_titles":["CTO"]}' --limit 100
instantly enrichment count --search-filters '{"industries":["SaaS"]}'
instantly enrichment get <resource-id>                # Get enrichment settings
instantly enrichment run --resource-id <id>           # Trigger enrichment
instantly enrichment create --name "Q2" --search-filters '{}' --enrichment-settings '{}'
instantly enrichment update-settings <resource-id> --enrichment-settings '{}'
instantly enrichment ai --resource-id <id> --prompt "Find CTOs in SaaS"
instantly enrichment ai-progress <resource-id>        # Check AI enrichment status
instantly enrichment history <resource-id>            # View enrichment history
instantly enrichment preview --search-filters '{}'    # Preview matching leads
```

### Blocklist (5)

Prevent sending to specific domains or email addresses.

```bash
instantly blocklist list                              # List blocked entries
instantly blocklist get <id>                          # Get entry details
instantly blocklist create --value "spam@domain.com"  # Block an email/domain
instantly blocklist update <id> --value "new@domain.com"  # Update entry
instantly blocklist delete <id>                       # Remove from blocklist
```

### Custom Tags (6)

Organize campaigns, leads, and resources with tags.

```bash
instantly custom-tags list                            # List all tags
instantly custom-tags get <id>                        # Get tag details
instantly custom-tags create --label "High Priority"  # Create a tag
instantly custom-tags update <id> --label "Urgent"    # Rename a tag
instantly custom-tags toggle --tag-ids "t1" --resource-ids "r1" --resource-type 1 --assign
instantly custom-tags delete <id>                     # Delete a tag
```

### Custom Tag Mappings (1)

```bash
instantly custom-tag-mappings list                    # List tag-to-resource mappings
```

### Lead Labels (6)

AI-powered labeling to categorize lead reply intent.

```bash
instantly lead-labels list                            # List all labels
instantly lead-labels get <id>                        # Get label details
instantly lead-labels create --label "Hot Lead" --interest-status "positive"
instantly lead-labels update <id> --label "Warm Lead" # Update label
instantly lead-labels test-ai --reply-text "Yes, I'm interested"  # Test AI classification
instantly lead-labels delete <id>                     # Delete label
```

### Workspace (6)

Manage workspace settings and whitelabel configuration.

```bash
instantly workspace get                               # Get workspace info
instantly workspace update --name "My Workspace"      # Update workspace
instantly workspace whitelabel-create --domain "mail.example.com"
instantly workspace whitelabel-get                    # Get whitelabel domain
instantly workspace whitelabel-delete                 # Remove whitelabel
instantly workspace change-owner --email "new@co.com" # Transfer ownership
```

### Workspace Members (5)

Manage team access and roles.

```bash
instantly workspace-members list                      # List team members
instantly workspace-members get <id>                  # Get member details
instantly workspace-members create --email "user@co.com" --role admin
instantly workspace-members update <id> --role member # Change role
instantly workspace-members delete <id>               # Remove member
```

### Workspace Group Members (5)

Manage workspace group membership.

```bash
instantly workspace-group-members list                # List group members
instantly workspace-group-members get <id>            # Get member details
instantly workspace-group-members create --user-id <id> --group-id <id>
instantly workspace-group-members get-admin            # Get admin info
instantly workspace-group-members delete <id>         # Remove from group
```

### Workspace Billing (2)

```bash
instantly workspace-billing plan-details              # View current plan
instantly workspace-billing subscription-details      # View subscription info
```

### Subsequences (8)

Multi-branch sequences that trigger based on lead behavior.

```bash
instantly subsequences list --campaign-id <id>        # List subsequences
instantly subsequences create --campaign-id <id> --name "Follow-up" --conditions '{}' --schedule '{}' --sequences '[]'
instantly subsequences update <id> --name "New Name"  # Update subsequence
instantly subsequences duplicate <id> --campaign-id <target-id> --name "Copy"
instantly subsequences pause <id>                     # Pause sending
instantly subsequences resume <id>                    # Resume sending
instantly subsequences sending-status <id>            # Check sending status
instantly subsequences delete <id>                    # Delete subsequence
```

### Background Jobs (2)

Monitor async bulk operations.

```bash
instantly background-jobs list                        # List jobs
instantly background-jobs list --status completed --type import
instantly background-jobs get <id>                    # Get job details
```

### Email Verification (2)

Verify email addresses before sending.

```bash
instantly email-verification verify --email "john@example.com"
instantly email-verification status <email>           # Check verification result
```

### Account-Campaign Mappings (1)

```bash
instantly account-mappings get <email>                # See which campaigns use an account
```

### Audit Logs (1)

```bash
instantly audit-logs list                             # List workspace activity
instantly audit-logs list --start-date 2025-01-01 --end-date 2025-03-01
```

### API Keys (3)

```bash
instantly api-keys list                               # List API keys
instantly api-keys create --name "CI/CD Key" --scopes "campaigns:read,leads:read"
instantly api-keys delete <id>                        # Revoke an API key
```

### Inbox Placement (6)

Test where your emails land — inbox, spam, or promotions.

```bash
instantly inbox-placement list                        # List placement tests
instantly inbox-placement get <id>                    # Get test results
instantly inbox-placement create --name "Q2 Test" --type 0 --sending-method 0 --subject "Test" --body "Hello" --emails "seed@test.com"
instantly inbox-placement update <id> --name "Updated"
instantly inbox-placement esp-options                  # List ESP options
instantly inbox-placement delete <id>                 # Delete test
```

### Inbox Placement Analytics (5)

Deep-dive into deliverability data.

```bash
instantly inbox-placement-analytics list              # List analytics records
instantly inbox-placement-analytics get <id>          # Get analytics detail
instantly inbox-placement-analytics stats-by-test --test-ids "id1,id2"
instantly inbox-placement-analytics stats-by-date --test-id <id>
instantly inbox-placement-analytics insights --test-id <id>  # Deliverability insights
```

### Inbox Placement Reports (2)

```bash
instantly inbox-placement-reports list                # List reports
instantly inbox-placement-reports get <id>            # Get report details
```

### CRM Actions (2)

```bash
instantly crm-actions list-phone-numbers             # List phone numbers
instantly crm-actions delete-phone-number <id>       # Delete phone number
```

### DFY Orders (7)

Manage Done-For-You email account orders.

```bash
instantly dfy-orders list                             # List orders
instantly dfy-orders create --items '[...]'           # Place an order
instantly dfy-orders similar-domains --domain "example.com"  # Find similar domains
instantly dfy-orders check-domains --domains "a.com,b.com"   # Check domain availability
instantly dfy-orders pre-warmed                       # List pre-warmed domains
instantly dfy-orders list-accounts                    # List DFY accounts
instantly dfy-orders cancel --account-ids "id1,id2"   # Cancel accounts
```

### Custom Prompt Templates (5)

Manage AI prompt templates for personalized outreach.

```bash
instantly custom-prompt-templates list                # List templates
instantly custom-prompt-templates get <id>            # Get template
instantly custom-prompt-templates create --name "Opener" --prompt "Write an opener..."
instantly custom-prompt-templates update <id> --name "Updated"
instantly custom-prompt-templates delete <id>         # Delete template
```

### Sales Flow (5)

Manage automated sales workflows.

```bash
instantly sales-flow list                             # List sales flows
instantly sales-flow get <id>                         # Get flow details
instantly sales-flow create --name "Inbound Flow"     # Create flow
instantly sales-flow update <id> --name "Updated"     # Update flow
instantly sales-flow delete <id>                      # Delete flow
```

### Email Templates (5)

Manage reusable email templates.

```bash
instantly email-templates list                        # List templates
instantly email-templates get <id>                    # Get template
instantly email-templates create --name "Welcome" --subject "Hello" --body "..."
instantly email-templates update <id> --name "Updated"
instantly email-templates delete <id>                 # Delete template
```

### OAuth (connect email accounts)

Connect Google Workspace and Microsoft 365 accounts without SMTP credentials.

```bash
instantly oauth connect google                        # Opens browser for Google OAuth
instantly oauth connect microsoft                     # Opens browser for Microsoft OAuth
instantly oauth status <session-id>                   # Check connection status
```

---

## MCP Server

The CLI doubles as an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server, giving AI assistants direct access to all 274 Instantly command tools as native function calls.

```bash
instantly mcp
```

### What this means

When you configure `instantly mcp` as an MCP server in Claude, Cursor, VS Code, or Windsurf, your AI assistant can:

- Create and launch campaigns mid-conversation
- Look up lead data and analytics on demand
- Reply to emails, manage accounts, and run enrichment
- Automate multi-step outbound workflows end-to-end

Every `CommandDefinition` in the codebase powers both a CLI subcommand and an MCP tool — one source of truth, two interfaces.

### Configuration

Add to your MCP settings (Claude Desktop, Cursor, VS Code, Windsurf):

```json
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
```

Every MCP tool description says pass `profile` for agency. Mutating tools require `profile` + `workspace_id` matching the bound pair. Use `INSTANTLY_PROFILE` for a single-profile agent process. Call `status` first. There is no “run across all profiles” tool.

```json
{
  "mcpServers": {
    "instantly-acme": {
      "command": "npx",
      "args": ["instantly-cli", "mcp"],
      "env": {
        "INSTANTLY_PROFILE": "acme"
      }
    }
  }
}
```

This registers 274 command tools across 37 groups, plus `status` and `health`:

| Group | Tools | Examples |
|-------|-------|---------|
| accounts | 14 | `accounts_pause_accounts`, `accounts_move_accounts` |
| agent-items | 2 | `agent_items_list_agent_items`, `agent_items_bulk_delete_agent_items` |
| blocklist | 9 | `blocklist_deleteall_block_list_entry`, `blocklist_createbluk_block_list_entry` |
| campaigns | 17 | `campaigns_share_campaign`, `campaigns_create_from_export` |
| domains | 3 | `domains_get_domain_forwarding`, `domains_update_domain_forwarding` |
| email | 9 | `email_send_test_email`, `email_list` |
| leads | 14 | `leads_update_lead_interest_status`, `leads_list` |
| oauth | 3 | `oauth_init_google_oauth`, `oauth_init_microsoft_oauth` |
| enrichment | 13 | `enrichment_signal_keywords_facet`, `enrichment_get_integration_providers` |
| subsequences | 11 | `subsequences_get_subsequence_analytics`, `subsequences_get_campaign_subsequence` |
| workspace | 9 | `workspace_schedule_current_workspace_removal`, `workspace_cancel_current_workspace_removal` |
| ai-agents | 61 | `ai_agents_create_sales_agent`, `ai_agents_list_sales_agents` |
| company-lists | 9 | `company_lists_list_company_list_recipes`, `company_lists_list_company_list_sources` |
| saved-searches | 5 | `saved_searches_list_saved_searches`, `saved_searches_create_saved_search` |
| analytics | 6 | `analytics_campaign`, `analytics_campaign_overview` |
| webhooks | 8 | `webhooks_list`, `webhooks_get` |
| lead-lists | 6 | `lead_lists_list`, `lead_lists_get` |
| custom-tags | 6 | `custom_tags_list`, `custom_tags_get` |
| lead-labels | 6 | `lead_labels_list`, `lead_labels_get` |
| background-jobs | 2 | `background_jobs_list`, `background_jobs_get` |
| email-verification | 2 | `email_verification_verify`, `email_verification_status` |
| account-mappings | 1 | `account_mappings_get` |
| audit-logs | 1 | `audit_logs_list` |
| workspace-members | 5 | `workspace_members_list`, `workspace_members_get` |
| api-keys | 3 | `api_keys_create`, `api_keys_list` |
| inbox-placement | 6 | `inbox_placement_list`, `inbox_placement_get` |
| webhook-events | 4 | `webhook_events_list`, `webhook_events_get` |
| workspace-group-members | 5 | `workspace_group_members_list`, `workspace_group_members_get` |
| custom-tag-mappings | 1 | `custom_tag_mappings_list` |
| workspace-billing | 2 | `workspace_billing_plan-details`, `workspace_billing_subscription-details` |
| crm-actions | 2 | `crm_actions_list-phone-numbers`, `crm_actions_delete-phone-number` |
| dfy-orders | 7 | `dfy_orders_create`, `dfy_orders_list` |
| inbox-placement-analytics | 5 | `inbox_placement_analytics_list`, `inbox_placement_analytics_get` |
| inbox-placement-reports | 2 | `inbox_placement_reports_list`, `inbox_placement_reports_get` |
| custom-prompt-templates | 5 | `custom_prompt_templates_create`, `custom_prompt_templates_list` |
| sales-flow | 5 | `sales_flow_create`, `sales_flow_list` |
| email-templates | 5 | `email_templates_create`, `email_templates_list` |

---

## Example Workflows

### Launch a campaign from scratch

```bash
export INSTANTLY_API_KEY=your-key

# Create the campaign
CAMPAIGN=$(instantly campaigns create --name "Q2 SaaS Outreach" | jq -r '.id')

# Import leads
instantly leads bulk-add --campaign-id "$CAMPAIGN" \
  --leads '[
    {"email":"cto@startup.com","first_name":"Alex","company_name":"Startup Inc"},
    {"email":"vp@growth.co","first_name":"Jordan","company_name":"Growth Co"}
  ]'

# Launch
instantly campaigns activate "$CAMPAIGN"

# Check status
instantly campaigns sending-status "$CAMPAIGN"
```

### Monitor and respond to replies

```bash
# How many unread replies?
instantly email unread-count

# Fetch unread emails for a campaign
instantly email list --campaign-id "$CAMPAIGN" --is-read false

# Reply to a lead
instantly email reply \
  --reply-to-uuid "<email-uuid>" \
  --eaccount "sender@yourdomain.com" \
  --subject "Re: Quick question" \
  --body-text "Thanks for your interest! Let's schedule a call."

# Mark thread as read
instantly email mark-read "<thread-id>"
```

### Health-check your sending infrastructure

```bash
# List all accounts with their status
instantly accounts list

# Run DNS, SMTP, and IMAP diagnostics
instantly accounts test-vitals "<account-id>"

# Enable warmup on cold accounts
instantly accounts warmup-enable --account-ids "id1,id2,id3"

# Check warmup analytics
instantly analytics warmup --emails "sender1@domain.com,sender2@domain.com"
```

### Test deliverability

```bash
# Run an inbox placement test
TEST=$(instantly inbox-placement create \
  --name "March Deliverability Check" \
  --type 0 --sending-method 0 \
  --subject "Test email" \
  --body "Hello from Instantly" \
  --emails "seed@test.com" | jq -r '.id')

# Check results
instantly inbox-placement-analytics insights --test-id "$TEST"
```

### Automate with cron

```bash
# Daily campaign health report (add to crontab)
0 9 * * * INSTANTLY_API_KEY=your-key instantly analytics campaign-overview >> /var/log/instantly-daily.json

# Alert on unread replies
*/5 * * * * INSTANTLY_API_KEY=your-key instantly email unread-count | jq '.count'
```

---

## Architecture

The CLI uses a **CommandDefinition** pattern where every API endpoint is defined as a single object that powers both the CLI subcommand and the MCP tool:

```
src/
├── core/
│   ├── client.ts      # HTTP client with retry, rate limiting, pagination
│   ├── auth.ts        # API key resolution (flag → env → .env → config; opt-in --profile)
│   ├── output.ts      # JSON output formatting
│   └── types.ts       # CommandDefinition interface
├── commands/
│   ├── campaigns/     # 11 commands
│   ├── leads/         # 12 commands
│   ├── accounts/      # 12 commands
│   └── ...            # 28 more groups
└── mcp/
    └── server.ts      # MCP server (auto-registers all commands as tools)
```

Adding a new API endpoint = creating one file. The command is automatically available in both CLI and MCP.

### HTTP Client Features

- **Auto-retry** with exponential backoff on 429 (rate limit) and 5xx errors
- **Rate limit awareness** — respects `Retry-After` headers
- **Cursor-based pagination** — handles both UUID and datetime cursors
- **30-second timeout** with configurable retries (default: 3)
- **Typed errors** — `AuthError`, `NotFoundError`, `RateLimitError`, `ValidationError`, `ServerError`

---

## Development

```bash
git clone https://github.com/LeadGrowGTM/instantly-cli.git
cd instantly-cli
npm install

npm run dev -- campaigns list    # Run in dev mode (tsx)
npm run build                    # Build with tsup
npm test                         # Run tests (138 tests, vitest)
npm run typecheck                # Type-check (tsc --noEmit)
```

### Tech Stack

- **TypeScript** (ESM, Node 20+)
- **Commander.js** — CLI framework
- **Zod** — schema validation (shared between CLI and MCP)
- **@modelcontextprotocol/sdk** — MCP server
- **tsup** — bundler
- **vitest** — test runner

---

## License

MIT
