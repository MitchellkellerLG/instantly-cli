import { accounts_pause_accounts } from './accounts_pause_accounts.js';
import { accounts_move_accounts } from './accounts_move_accounts.js';
import { agent_items_list_agent_items } from './agent_items_list_agent_items.js';
import { agent_items_bulk_delete_agent_items } from './agent_items_bulk_delete_agent_items.js';
import { blocklist_deleteall_block_list_entry } from './blocklist_deleteall_block_list_entry.js';
import { blocklist_createbluk_block_list_entry } from './blocklist_createbluk_block_list_entry.js';
import { blocklist_deletebulk_block_list_entry } from './blocklist_deletebulk_block_list_entry.js';
import { blocklist_download_block_list_entry } from './blocklist_download_block_list_entry.js';
import { campaigns_share_campaign } from './campaigns_share_campaign.js';
import { campaigns_create_from_export } from './campaigns_create_from_export.js';
import { campaigns_export_campaign } from './campaigns_export_campaign.js';
import { campaigns_add_variables } from './campaigns_add_variables.js';
import { custom_tags_search_custom_tags_by_resources } from './custom_tags_search_custom_tags_by_resources.js';
import { domains_get_domain_forwarding } from './domains_get_domain_forwarding.js';
import { domains_update_domain_forwarding } from './domains_update_domain_forwarding.js';
import { domains_delete_domain_forwarding } from './domains_delete_domain_forwarding.js';
import { email_send_test_email } from './email_send_test_email.js';
import { leads_update_lead_interest_status } from './leads_update_lead_interest_status.js';
import { oauth_init_google_oauth } from './oauth_init_google_oauth.js';
import { oauth_init_microsoft_oauth } from './oauth_init_microsoft_oauth.js';
import { oauth_get_oauth_session_status } from './oauth_get_oauth_session_status.js';
import { enrichment_signal_keywords_facet } from './enrichment_signal_keywords_facet.js';
import { subsequences_get_subsequence_analytics } from './subsequences_get_subsequence_analytics.js';
import { subsequences_get_campaign_subsequence } from './subsequences_get_campaign_subsequence.js';
import { subsequences_get_subsequence_steps_analytics } from './subsequences_get_subsequence_steps_analytics.js';
import { workspace_schedule_current_workspace_removal } from './workspace_schedule_current_workspace_removal.js';
import { workspace_cancel_current_workspace_removal } from './workspace_cancel_current_workspace_removal.js';
import { ai_agents_create_sales_agent } from './ai_agents_create_sales_agent.js';
import { ai_agents_list_sales_agents } from './ai_agents_list_sales_agents.js';
import { ai_agents_get_sales_agent } from './ai_agents_get_sales_agent.js';
import { ai_agents_patch_sales_agent } from './ai_agents_patch_sales_agent.js';
import { ai_agents_delete_sales_agent } from './ai_agents_delete_sales_agent.js';
import { ai_agents_get_sales_agent_analytics } from './ai_agents_get_sales_agent_analytics.js';
import { ai_agents_get_sales_agent_opportunity_summary } from './ai_agents_get_sales_agent_opportunity_summary.js';
import { ai_agents_get_sales_agent_lead_research } from './ai_agents_get_sales_agent_lead_research.js';
import { ai_agents_get_sales_agent_lead_activity_summary } from './ai_agents_get_sales_agent_lead_activity_summary.js';
import { ai_agents_list_sales_agent_lead_activity } from './ai_agents_list_sales_agent_lead_activity.js';
import { ai_agents_list_sales_agent_activities } from './ai_agents_list_sales_agent_activities.js';
import { ai_agents_approve_sales_agent_activity } from './ai_agents_approve_sales_agent_activity.js';
import { ai_agents_reject_sales_agent_activity } from './ai_agents_reject_sales_agent_activity.js';
import { ai_agents_approve_sales_agent_activities } from './ai_agents_approve_sales_agent_activities.js';
import { ai_agents_reject_sales_agent_activities } from './ai_agents_reject_sales_agent_activities.js';
import { ai_agents_list_sales_agent_guidance_rules } from './ai_agents_list_sales_agent_guidance_rules.js';
import { ai_agents_create_sales_agent_guidance_rule } from './ai_agents_create_sales_agent_guidance_rule.js';
import { ai_agents_patch_sales_agent_guidance_rule } from './ai_agents_patch_sales_agent_guidance_rule.js';
import { ai_agents_delete_sales_agent_guidance_rule } from './ai_agents_delete_sales_agent_guidance_rule.js';
import { ai_agents_create_inbox_manager_agent } from './ai_agents_create_inbox_manager_agent.js';
import { ai_agents_list_inbox_manager_agents } from './ai_agents_list_inbox_manager_agents.js';
import { ai_agents_get_inbox_manager_agent } from './ai_agents_get_inbox_manager_agent.js';
import { ai_agents_patch_inbox_manager_agent } from './ai_agents_patch_inbox_manager_agent.js';
import { ai_agents_delete_inbox_manager_agent } from './ai_agents_delete_inbox_manager_agent.js';
import { ai_agents_list_inbox_manager_guidances } from './ai_agents_list_inbox_manager_guidances.js';
import { ai_agents_create_inbox_manager_guidance } from './ai_agents_create_inbox_manager_guidance.js';
import { ai_agents_get_inbox_manager_guidance } from './ai_agents_get_inbox_manager_guidance.js';
import { ai_agents_patch_inbox_manager_guidance } from './ai_agents_patch_inbox_manager_guidance.js';
import { ai_agents_delete_inbox_manager_guidance } from './ai_agents_delete_inbox_manager_guidance.js';
import { ai_agents_list_inbox_manager_replies } from './ai_agents_list_inbox_manager_replies.js';
import { ai_agents_get_inbox_manager_reply } from './ai_agents_get_inbox_manager_reply.js';
import { ai_agents_patch_inbox_manager_reply } from './ai_agents_patch_inbox_manager_reply.js';
import { ai_agents_get_inbox_manager_analytics_summary } from './ai_agents_get_inbox_manager_analytics_summary.js';
import { ai_agents_get_inbox_manager_analytics_summary_by_date } from './ai_agents_get_inbox_manager_analytics_summary_by_date.js';
import { ai_agents_list_inbox_manager_activity } from './ai_agents_list_inbox_manager_activity.js';
import { ai_agents_list_lead_finder_agents } from './ai_agents_list_lead_finder_agents.js';
import { ai_agents_create_lead_finder_agent } from './ai_agents_create_lead_finder_agent.js';
import { ai_agents_get_lead_finder_agent_by_id } from './ai_agents_get_lead_finder_agent_by_id.js';
import { ai_agents_update_lead_finder_agent } from './ai_agents_update_lead_finder_agent.js';
import { ai_agents_delete_lead_finder_agent_v2 } from './ai_agents_delete_lead_finder_agent_v2.js';
import { ai_agents_pause_lead_finder_agent_by_id } from './ai_agents_pause_lead_finder_agent_by_id.js';
import { ai_agents_resume_lead_finder_agent_by_id } from './ai_agents_resume_lead_finder_agent_by_id.js';
import { ai_agents_get_lead_finder_agent_stats } from './ai_agents_get_lead_finder_agent_stats.js';
import { ai_agents_list_lead_finder_agent_activities_by_id } from './ai_agents_list_lead_finder_agent_activities_by_id.js';
import { ai_agents_suggest_lead_finder_audience_v2 } from './ai_agents_suggest_lead_finder_audience_v2.js';
import { ai_agents_list_lead_finder_agent_enrichment_workflows_v2 } from './ai_agents_list_lead_finder_agent_enrichment_workflows_v2.js';
import { ai_agents_create_lead_finder_agent_enrichment_workflow_v2 } from './ai_agents_create_lead_finder_agent_enrichment_workflow_v2.js';
import { ai_agents_delete_lead_finder_agent_enrichment_workflow_v2 } from './ai_agents_delete_lead_finder_agent_enrichment_workflow_v2.js';
import { ai_agents_get_deliverability_agent } from './ai_agents_get_deliverability_agent.js';
import { ai_agents_update_deliverability_agent_settings } from './ai_agents_update_deliverability_agent_settings.js';
import { ai_agents_get_deliverability_agent_state } from './ai_agents_get_deliverability_agent_state.js';
import { ai_agents_pause_deliverability_affected_accounts } from './ai_agents_pause_deliverability_affected_accounts.js';
import { ai_agents_pause_deliverability_campaign_sending } from './ai_agents_pause_deliverability_campaign_sending.js';
import { ai_agents_complete_deliverability_feed_item } from './ai_agents_complete_deliverability_feed_item.js';
import { ai_agents_run_deliverability_agent_now } from './ai_agents_run_deliverability_agent_now.js';
import { ai_agents_deploy_deliverability_agent } from './ai_agents_deploy_deliverability_agent.js';
import { ai_agents_get_deliverability_agent_by_id } from './ai_agents_get_deliverability_agent_by_id.js';
import { ai_agents_patch_deliverability_agent } from './ai_agents_patch_deliverability_agent.js';
import { ai_agents_delete_deliverability_agent } from './ai_agents_delete_deliverability_agent.js';
import { ai_agents_get_deliverability_agent_state_by_id } from './ai_agents_get_deliverability_agent_state_by_id.js';
import { ai_agents_list_deliverability_agent_feed_items } from './ai_agents_list_deliverability_agent_feed_items.js';
import { creator_search_search_creators } from './creator_search_search_creators.js';
import { creator_search_get_creator_search_dictionaries } from './creator_search_get_creator_search_dictionaries.js';
import { creator_search_get_creator_search_locations } from './creator_search_get_creator_search_locations.js';
import { creator_search_get_creator_search_capabilities } from './creator_search_get_creator_search_capabilities.js';
import { creator_search_get_creator_search_allowance } from './creator_search_get_creator_search_allowance.js';
import { creator_search_create_creator_outreach_batch } from './creator_search_create_creator_outreach_batch.js';
import { creator_search_get_creator_outreach_batch } from './creator_search_get_creator_outreach_batch.js';
import { local_business_search_search_local_businesses } from './local_business_search_search_local_businesses.js';
import { local_business_search_generate_local_business_filters } from './local_business_search_generate_local_business_filters.js';
import { local_business_search_suggest_local_business_places } from './local_business_search_suggest_local_business_places.js';
import { local_business_search_convert_local_businesses } from './local_business_search_convert_local_businesses.js';
import { local_business_search_get_local_business_convert_job } from './local_business_search_get_local_business_convert_job.js';
import { company_lists_list_company_list_recipes } from './company_lists_list_company_list_recipes.js';
import { company_lists_list_company_list_sources } from './company_lists_list_company_list_sources.js';
import { company_lists_get_company_list_filter_options } from './company_lists_get_company_list_filter_options.js';
import { company_lists_create_company_list } from './company_lists_create_company_list.js';
import { company_lists_list_company_lists } from './company_lists_list_company_lists.js';
import { company_lists_get_company_list } from './company_lists_get_company_list.js';
import { company_lists_rename_company_list } from './company_lists_rename_company_list.js';
import { company_lists_delete_company_list } from './company_lists_delete_company_list.js';
import { company_lists_list_company_list_members } from './company_lists_list_company_list_members.js';
import { enrichment_get_integration_providers } from './enrichment_get_integration_providers.js';
import { enrichment_run_integration_action } from './enrichment_run_integration_action.js';
import { saved_searches_list_saved_searches } from './saved_searches_list_saved_searches.js';
import { saved_searches_create_saved_search } from './saved_searches_create_saved_search.js';
import { saved_searches_get_saved_search } from './saved_searches_get_saved_search.js';
import { saved_searches_update_saved_search } from './saved_searches_update_saved_search.js';
import { saved_searches_delete_saved_search } from './saved_searches_delete_saved_search.js';

export const generatedCommands = [
  accounts_pause_accounts,
  accounts_move_accounts,
  agent_items_list_agent_items,
  agent_items_bulk_delete_agent_items,
  blocklist_deleteall_block_list_entry,
  blocklist_createbluk_block_list_entry,
  blocklist_deletebulk_block_list_entry,
  blocklist_download_block_list_entry,
  campaigns_share_campaign,
  campaigns_create_from_export,
  campaigns_export_campaign,
  campaigns_add_variables,
  custom_tags_search_custom_tags_by_resources,
  domains_get_domain_forwarding,
  domains_update_domain_forwarding,
  domains_delete_domain_forwarding,
  email_send_test_email,
  leads_update_lead_interest_status,
  oauth_init_google_oauth,
  oauth_init_microsoft_oauth,
  oauth_get_oauth_session_status,
  enrichment_signal_keywords_facet,
  subsequences_get_subsequence_analytics,
  subsequences_get_campaign_subsequence,
  subsequences_get_subsequence_steps_analytics,
  workspace_schedule_current_workspace_removal,
  workspace_cancel_current_workspace_removal,
  ai_agents_create_sales_agent,
  ai_agents_list_sales_agents,
  ai_agents_get_sales_agent,
  ai_agents_patch_sales_agent,
  ai_agents_delete_sales_agent,
  ai_agents_get_sales_agent_analytics,
  ai_agents_get_sales_agent_opportunity_summary,
  ai_agents_get_sales_agent_lead_research,
  ai_agents_get_sales_agent_lead_activity_summary,
  ai_agents_list_sales_agent_lead_activity,
  ai_agents_list_sales_agent_activities,
  ai_agents_approve_sales_agent_activity,
  ai_agents_reject_sales_agent_activity,
  ai_agents_approve_sales_agent_activities,
  ai_agents_reject_sales_agent_activities,
  ai_agents_list_sales_agent_guidance_rules,
  ai_agents_create_sales_agent_guidance_rule,
  ai_agents_patch_sales_agent_guidance_rule,
  ai_agents_delete_sales_agent_guidance_rule,
  ai_agents_create_inbox_manager_agent,
  ai_agents_list_inbox_manager_agents,
  ai_agents_get_inbox_manager_agent,
  ai_agents_patch_inbox_manager_agent,
  ai_agents_delete_inbox_manager_agent,
  ai_agents_list_inbox_manager_guidances,
  ai_agents_create_inbox_manager_guidance,
  ai_agents_get_inbox_manager_guidance,
  ai_agents_patch_inbox_manager_guidance,
  ai_agents_delete_inbox_manager_guidance,
  ai_agents_list_inbox_manager_replies,
  ai_agents_get_inbox_manager_reply,
  ai_agents_patch_inbox_manager_reply,
  ai_agents_get_inbox_manager_analytics_summary,
  ai_agents_get_inbox_manager_analytics_summary_by_date,
  ai_agents_list_inbox_manager_activity,
  ai_agents_list_lead_finder_agents,
  ai_agents_create_lead_finder_agent,
  ai_agents_get_lead_finder_agent_by_id,
  ai_agents_update_lead_finder_agent,
  ai_agents_delete_lead_finder_agent_v2,
  ai_agents_pause_lead_finder_agent_by_id,
  ai_agents_resume_lead_finder_agent_by_id,
  ai_agents_get_lead_finder_agent_stats,
  ai_agents_list_lead_finder_agent_activities_by_id,
  ai_agents_suggest_lead_finder_audience_v2,
  ai_agents_list_lead_finder_agent_enrichment_workflows_v2,
  ai_agents_create_lead_finder_agent_enrichment_workflow_v2,
  ai_agents_delete_lead_finder_agent_enrichment_workflow_v2,
  ai_agents_get_deliverability_agent,
  ai_agents_update_deliverability_agent_settings,
  ai_agents_get_deliverability_agent_state,
  ai_agents_pause_deliverability_affected_accounts,
  ai_agents_pause_deliverability_campaign_sending,
  ai_agents_complete_deliverability_feed_item,
  ai_agents_run_deliverability_agent_now,
  ai_agents_deploy_deliverability_agent,
  ai_agents_get_deliverability_agent_by_id,
  ai_agents_patch_deliverability_agent,
  ai_agents_delete_deliverability_agent,
  ai_agents_get_deliverability_agent_state_by_id,
  ai_agents_list_deliverability_agent_feed_items,
  creator_search_search_creators,
  creator_search_get_creator_search_dictionaries,
  creator_search_get_creator_search_locations,
  creator_search_get_creator_search_capabilities,
  creator_search_get_creator_search_allowance,
  creator_search_create_creator_outreach_batch,
  creator_search_get_creator_outreach_batch,
  local_business_search_search_local_businesses,
  local_business_search_generate_local_business_filters,
  local_business_search_suggest_local_business_places,
  local_business_search_convert_local_businesses,
  local_business_search_get_local_business_convert_job,
  company_lists_list_company_list_recipes,
  company_lists_list_company_list_sources,
  company_lists_get_company_list_filter_options,
  company_lists_create_company_list,
  company_lists_list_company_lists,
  company_lists_get_company_list,
  company_lists_rename_company_list,
  company_lists_delete_company_list,
  company_lists_list_company_list_members,
  enrichment_get_integration_providers,
  enrichment_run_integration_action,
  saved_searches_list_saved_searches,
  saved_searches_create_saved_search,
  saved_searches_get_saved_search,
  saved_searches_update_saved_search,
  saved_searches_delete_saved_search,
];
