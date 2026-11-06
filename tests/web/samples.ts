/** Fixed arguments for each private route that needs any. Shared by the recorder and the replay tests. */
export const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  web_crm_opportunities_list: { limit: 5 },
  web_crm_tasks_list: { limit: 5 },
  web_visitors_integrations_list: { limit: 5 },
  web_voice_suppressions_list: { limit: 5 },
  web_voice_available_numbers_list: { country: 'US' },
  web_analytics_sales_agent: { start_date: '2026-10-01T00:00:00.000Z', end_date: '2026-11-05T23:59:59.999Z' },
  web_analytics_inbox_manager: { from: '2026-10-01', to: '2026-11-05' },
  web_analytics_inbox_manager_by_date: { from: '2026-10-01', to: '2026-11-05' },
  web_analytics_email_marketing: { time_range: '30d' },
  web_supersearch_proposals_list: { surface: 'todays_focus' },
  web_crm_stats: { include: 'opportunities' },
};
