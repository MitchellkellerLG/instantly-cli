# Instantly.ai — MCP Context

## What is Instantly?

[Instantly.ai](https://instantly.ai) is a cold email automation platform for sales teams and growth marketers. It handles sending infrastructure, inbox warm-up, lead management, analytics, and unibox (unified inbox) for replies.

## Authentication

Default (one workspace): `--api-key`, or `INSTANTLY_API_KEY`, or cwd `.env` `INSTANTLY_API_KEY`, or `~/.instantly/config.json` from `instantly login`. Default login stamps `workspace_id` + `workspace_name` onto config.json. `--profile` is not required for old single-key users. `status` / `whoami` print `profile` (`default` or slug), `workspace_id`, `workspace_name`, `source`.

Agency: name every client as a profile (`login --profile <client>`), including the house org. `--profile <slug>` or `INSTANTLY_PROFILE=<slug>` loads `~/.instantly/profiles/<slug>.json`. `login --profile` does not write `config.json`. One process, one profile — no all-profiles tool. When a profile is selected, it wins over a leftover cwd `.env` key.

For MCP startup profile binding, operator permissions and required write scope, follow [README configuration](README.md#configuration). Confirm `status` first.

API keys are generated from Instantly workspace settings.

## Tool Discovery

Use MCP `tools/list` to discover the tools exposed by this server. See the [README command reference](README.md#commands) for the API command inventory and [MCP configuration](README.md#configuration) for exposure policy. The workflows below use legacy tool names; availability depends on that policy. For compact MCP, follow the [compact surface guide](README.md#compact-surface-four-tools-instead-of-289).

## Common Workflows

**Launch a new campaign:**
1. `campaigns_create` — create the campaign
2. `leads_bulk_add` — add leads to it
3. `campaigns_activate` — start sending

**Monitor reply volume:**
1. `email_unread_count` — get unread count
2. `email_list` with `is_read: false` — fetch unread emails
3. `email_reply` — respond to a lead

**Health check sending infrastructure:**
1. `accounts_list` — see all accounts
2. `accounts_test_vitals` — run DNS/SMTP/IMAP checks on flagged accounts
3. `accounts_warmup_enable` — enable warmup on cold accounts

**Analyze campaign performance:**
1. `analytics_campaign_overview` — high-level numbers
2. `analytics_campaign` — per-campaign breakdown
3. `analytics_daily_campaign` — identify day-over-day trends

## Email Body Formatting — CRITICAL

Instantly delivers HTML. **Pass readable copy with real line breaks.** The CLI converts plain-text newlines to HTML on `campaigns_create` / `campaigns_update`, `subsequences_create`, `email_reply`, `email_forward`, and `leads_bulk_add` (custom_variables whose key contains `body`). Do not send a run-on string. Do not hand-write tags unless the body is already HTML. Existing HTML is left unchanged. `text_only` skips conversion. Template variables and spin syntax pass through.

delay on step N waits before step N+1. First email does not wait. Pass delay_unit (omitted unit becomes days). Instantly uses only sequences[0]. Read `sequence_timeline` after create. `pre_delay` is subsequence-only. `email_gap` is a rate limit, not the step gap.

## Key Identifiers

- Most resources use UUID strings as IDs (e.g., campaign IDs, lead IDs, account IDs)
- Email accounts are also identified by their email address string in some contexts
- Pagination uses `skip` (offset) and `limit` parameters
