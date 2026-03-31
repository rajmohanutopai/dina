# All Tests -- Complete Inventory

Generated: 2026-03-31

Naming spec: see docs/TEST_SPEC.md — TRACE comment on line above test function

Status: TAGGED (has plan ID), PENDING (needs migration)

## Summary

| Suite | Total | Tagged | Pending | Coverage |
|-------|-------|--------|---------|----------|
| BRAIN | 857 | 587 | 270 | 68% |
| CLI | 111 | 66 | 45 | 59% |
| ADMIN | 81 | 0 | 81 | 0% |
| INT | 1019 | 765 | 254 | 75% |
| E2E | 132 | 120 | 12 | 90% |
| INST | 102 | 0 | 102 | 0% |
| REL | 141 | 135 | 6 | 95% |
| SYSTEM | 151 | 0 | 151 | 0% |
| CORE | 2163 | 1166 | 997 | 53% |
| APPVIEW | 618 | 0 | 618 | 0% |
| LEGACY | 220 | 0 | 220 | 0% |
| **TOTAL** | **5595** | **2839** | **2756** | **50%** |

## BRAIN (587/857 tagged -- 68%)

| # | Status | Current Tag | Name Status | Test Function | File |
|---|--------|------------|-------------|---------------|------|
| 1 | TAGGED | TST-BRAIN-270 | PENDING | test_admin_8_1_1_dashboard_loads | brain/tests/test_admin.py |
| 2 | TAGGED | TST-BRAIN-271 | PENDING | test_admin_8_1_2_system_status | brain/tests/test_admin.py |
| 3 | TAGGED | TST-BRAIN-272 | PENDING | test_admin_8_1_3_degraded_status | brain/tests/test_admin.py |
| 4 | TAGGED | TST-BRAIN-273 | PENDING | test_admin_8_1_4_recent_activity | brain/tests/test_admin.py |
| 5 | TAGGED | TST-BRAIN-274 | PENDING | test_admin_8_2_1_list_contacts | brain/tests/test_admin.py |
| 6 | TAGGED | TST-BRAIN-275 | PENDING | test_admin_8_2_2_add_contact | brain/tests/test_admin.py |
| 7 | TAGGED | TST-BRAIN-276 | PENDING | test_admin_8_2_3_edit_sharing_policy | brain/tests/test_admin.py |
| 8 | TAGGED | TST-BRAIN-277 | PENDING | test_admin_8_2_4_remove_contact | brain/tests/test_admin.py |
| 9 | TAGGED | TST-BRAIN-278 | PENDING | test_admin_8_3_1_list_devices | brain/tests/test_admin.py |
| 10 | TAGGED | TST-BRAIN-279 | PENDING | test_admin_8_3_2_initiate_pairing | brain/tests/test_admin.py |
| 11 | TAGGED | TST-BRAIN-280 | PENDING | test_admin_8_3_3_revoke_device | brain/tests/test_admin.py |
| 12 | TAGGED | TST-BRAIN-281 | PENDING | test_admin_8_4_1_list_personas | brain/tests/test_admin.py |
| 13 | TAGGED | TST-BRAIN-282 | PENDING | test_admin_8_4_2_create_persona | brain/tests/test_admin.py |
| 14 | TAGGED | TST-BRAIN-283 | PENDING | test_admin_8_4_3_change_persona_tier | brain/tests/test_admin.py |
| 15 | TAGGED | TST-BRAIN-284 | PENDING | test_admin_8_4_4_delete_persona | brain/tests/test_admin.py |
| 16 | TAGGED | TST-BRAIN-285 | PENDING | test_admin_8_5_1_xss_contact_name | brain/tests/test_admin.py |
| 17 | TAGGED | TST-BRAIN-286 | PENDING | test_admin_8_5_2_csrf_protection | brain/tests/test_admin.py |
| 18 | TAGGED | TST-BRAIN-287 | PENDING | test_admin_8_5_3_sql_injection_search | brain/tests/test_admin.py |
| 19 | TAGGED | TST-BRAIN-288 | PENDING | test_admin_8_5_4_template_injection | brain/tests/test_admin.py |
| 20 | TAGGED | TST-BRAIN-456 | PENDING | test_admin_8_6_1_auth_wrong_token | brain/tests/test_admin.py |
| 21 | TAGGED | TST-BRAIN-457 | PENDING | test_admin_8_6_2_auth_no_token | brain/tests/test_admin.py |
| 22 | PENDING | -- | PENDING | test_admin_trust_page_loads | brain/tests/test_admin.py |
| 23 | PENDING | -- | PENDING | test_admin_trust_cache_api | brain/tests/test_admin.py |
| 24 | PENDING | -- | PENDING | test_admin_trust_stats_api | brain/tests/test_admin.py |
| 25 | PENDING | -- | PENDING | test_admin_trust_sync_api | brain/tests/test_admin.py |
| 26 | PENDING | -- | PENDING | test_login_page_renders | brain/tests/test_admin_html.py |
| 27 | TAGGED | TST-BRAIN-482 | PENDING | test_login_valid_token_sets_cookie | brain/tests/test_admin_html.py |
| 28 | PENDING | -- | PENDING | test_login_invalid_token_rejected | brain/tests/test_admin_html.py |
| 29 | PENDING | -- | PENDING | test_login_empty_token_rejected | brain/tests/test_admin_html.py |
| 30 | PENDING | -- | PENDING | test_dashboard_with_cookie | brain/tests/test_admin_html.py |
| 31 | PENDING | -- | PENDING | test_dashboard_with_bearer | brain/tests/test_admin_html.py |
| 32 | PENDING | -- | PENDING | test_dashboard_no_auth_returns_401 | brain/tests/test_admin_html.py |
| 33 | PENDING | -- | PENDING | test_history_page_renders | brain/tests/test_admin_html.py |
| 34 | PENDING | -- | PENDING | test_contacts_page_renders | brain/tests/test_admin_html.py |
| 35 | PENDING | -- | PENDING | test_settings_page_renders | brain/tests/test_admin_html.py |
| 36 | PENDING | -- | PENDING | test_history_api_returns_paginated | brain/tests/test_admin_html.py |
| 37 | PENDING | -- | PENDING | test_chat_api_forwards_to_brain | brain/tests/test_admin_html.py |
| 38 | PENDING | -- | PENDING | test_architecture_without_file_returns_404 | brain/tests/test_admin_html.py |
| 39 | PENDING | -- | PENDING | test_html_pages_require_auth | brain/tests/test_admin_html.py |
| 40 | PENDING | -- | PENDING | test_api_routes_require_auth | brain/tests/test_admin_html.py |
| 41 | TAGGED | TST-BRAIN-295 | PENDING | test_api_10_1_1_healthz_returns_200 | brain/tests/test_api.py |
| 42 | TAGGED | TST-BRAIN-381 | PENDING | test_api_10_1_2_healthz_includes_components | brain/tests/test_api.py |
| 43 | TAGGED | TST-BRAIN-382 | PENDING | test_api_10_2_1_process_valid_event | brain/tests/test_api.py |
| 44 | TAGGED | TST-BRAIN-383 | PENDING | test_api_10_2_2_process_missing_auth | brain/tests/test_api.py |
| 45 | TAGGED | TST-BRAIN-384 | PENDING | test_api_10_2_3_process_wrong_signature | brain/tests/test_api.py |
| 46 | TAGGED | TST-BRAIN-385 | PENDING | test_api_10_2_4_process_invalid_json | brain/tests/test_api.py |
| 47 | TAGGED | TST-BRAIN-301 | PENDING | test_api_10_2_5_process_missing_required_fields | brain/tests/test_api.py |
| 48 | TAGGED | TST-BRAIN-386 | PENDING | test_api_10_3_1_reason_valid_request | brain/tests/test_api.py |
| 49 | TAGGED | TST-BRAIN-387 | PENDING | test_api_10_3_2_reason_missing_prompt | brain/tests/test_api.py |
| 50 | TAGGED | TST-BRAIN-388 | PENDING | test_api_10_3_3_reason_no_auth | brain/tests/test_api.py |
| 51 | TAGGED | TST-BRAIN-389 | PENDING | test_api_10_4_1_response_content_type_json | brain/tests/test_api.py |
| 52 | TAGGED | TST-BRAIN-390 | PENDING | test_api_10_4_2_error_response_format | brain/tests/test_api.py |
| 53 | TAGGED | TST-BRAIN-391 | PENDING | test_api_10_4_3_unknown_route_returns_404 | brain/tests/test_api.py |
| 54 | TAGGED | TST-BRAIN-296 | PENDING | test_api_10_1_health_with_llm_down | brain/tests/test_api.py |
| 55 | TAGGED | TST-BRAIN-297 | PENDING | test_api_10_2_process_text_query | brain/tests/test_api.py |
| 56 | TAGGED | TST-BRAIN-298 | PENDING | test_api_10_2_process_agent_intent | brain/tests/test_api.py |
| 57 | TAGGED | TST-BRAIN-299 | PENDING | test_api_10_2_process_incoming_message | brain/tests/test_api.py |
| 58 | TAGGED | TST-BRAIN-300 | PENDING | test_api_10_2_invalid_event_type | brain/tests/test_api.py |
| 59 | TAGGED | TST-BRAIN-419 | PENDING | test_api_10_5_1_language_agnostic_contract | brain/tests/test_api.py |
| 60 | TAGGED | TST-BRAIN-814 | PENDING | test_br1_pii_scrub_strips_original_values | brain/tests/test_api.py |
| 61 | TAGGED | TST-BRAIN-819 | PENDING | test_br5_process_rate_limited | brain/tests/test_api.py |
| 62 | TAGGED | TST-BRAIN-001 | PENDING | test_auth_1_1_1_valid_service_key | brain/tests/test_auth.py |
| 63 | TAGGED | TST-BRAIN-002 | PENDING | test_auth_1_1_2_missing_auth | brain/tests/test_auth.py |
| 64 | TAGGED | TST-BRAIN-003 | PENDING | test_auth_1_1_3_wrong_signature | brain/tests/test_auth.py |
| 65 | TAGGED | TST-BRAIN-004 | PENDING | test_auth_1_1_4_service_key_dir_config | brain/tests/test_auth.py |
| 66 | TAGGED | TST-BRAIN-005 | PENDING | test_auth_1_1_5_service_key_dir_default | brain/tests/test_auth.py |
| 67 | TAGGED | TST-BRAIN-006 | PENDING | test_auth_1_1_6_constant_time_comparison | brain/tests/test_auth.py |
| 68 | TAGGED | TST-BRAIN-007 | PENDING | test_auth_1_2_1_api_requires_service_key | brain/tests/test_auth.py |
| 69 | TAGGED | TST-BRAIN-008 | PENDING | test_auth_1_2_2_api_rejects_client_token | brain/tests/test_auth.py |
| 70 | TAGGED | TST-BRAIN-009 | PENDING | test_auth_1_2_3_admin_requires_client_token | brain/tests/test_auth.py |
| 71 | TAGGED | TST-BRAIN-010 | PENDING | test_auth_1_2_4_admin_rejects_brain_token | brain/tests/test_auth.py |
| 72 | TAGGED | TST-BRAIN-011 | PENDING | test_auth_1_2_5_healthz_unauthenticated | brain/tests/test_auth.py |
| 73 | TAGGED | TST-BRAIN-012 | PENDING | test_auth_1_2_6_single_uvicorn_process | brain/tests/test_auth.py |
| 74 | TAGGED | TST-BRAIN-013 | PENDING | test_auth_1_2_7_subapp_brain_cannot_import_admin | brain/tests/test_auth.py |
| 75 | TAGGED | TST-BRAIN-014 | PENDING | test_auth_1_2_8_subapp_admin_cannot_import_brain | brain/tests/test_auth.py |
| 76 | TAGGED | TST-BRAIN-015 | PENDING | test_auth_1_2_9_admin_uses_client_token_to_core | brain/tests/test_auth.py |
| 77 | TAGGED | TST-BRAIN-016 | PENDING | test_auth_1_2_10_brain_never_sees_cookies | brain/tests/test_auth.py |
| 78 | TAGGED | TST-BRAIN-017 | PENDING | test_auth_1_2_11_brain_exposes_process | brain/tests/test_auth.py |
| 79 | TAGGED | TST-BRAIN-018 | PENDING | test_auth_1_2_12_brain_exposes_reason | brain/tests/test_auth.py |
| 80 | TAGGED | TST-BRAIN-416 | PENDING | test_auth_1_2_13_zero_sqlite_calls | brain/tests/test_auth.py |
| 81 | TAGGED | TST-BRAIN-289 | PENDING | test_config_9_1_1_core_url_from_env | brain/tests/test_config.py |
| 82 | TAGGED | TST-BRAIN-376 | PENDING | test_config_9_1_2_core_url_default | brain/tests/test_config.py |
| 83 | TAGGED | TST-BRAIN-377 | PENDING | test_config_9_2_1_service_key_dir_from_env | brain/tests/test_config.py |
| 84 | TAGGED | TST-BRAIN-293 | PENDING | test_config_9_2_2_service_key_dir_default | brain/tests/test_config.py |
| 85 | TAGGED | TST-BRAIN-378 | PENDING | test_config_9_3_1_listen_port_default | brain/tests/test_config.py |
| 86 | TAGGED | TST-BRAIN-379 | PENDING | test_config_9_3_2_log_level_default | brain/tests/test_config.py |
| 87 | TAGGED | TST-BRAIN-380 | PENDING | test_config_9_4_1_client_token_from_env | brain/tests/test_config.py |
| 88 | TAGGED | TST-BRAIN-294 | PENDING | test_config_9_4_2_invalid_core_url_raises | brain/tests/test_config.py |
| 89 | TAGGED | TST-BRAIN-290 | PENDING | test_config_9_llm_url_from_env | brain/tests/test_config.py |
| 90 | TAGGED | TST-BRAIN-291 | PENDING | test_config_9_missing_core_url_uses_default | brain/tests/test_config.py |
| 91 | TAGGED | TST-BRAIN-292 | PENDING | test_config_9_missing_llm_url_graceful | brain/tests/test_config.py |
| 92 | TAGGED | TST-BRAIN-259 | PENDING | test_core_client_7_1_1_read_vault_item | brain/tests/test_core_client.py |
| 93 | TAGGED | TST-BRAIN-260 | PENDING | test_core_client_7_1_2_write_vault_item | brain/tests/test_core_client.py |
| 94 | TAGGED | TST-BRAIN-261 | PENDING | test_core_client_7_1_3_search_vault | brain/tests/test_core_client.py |
| 95 | TAGGED | TST-BRAIN-262 | PENDING | test_core_client_7_1_4_write_scratchpad | brain/tests/test_core_client.py |
| 96 | TAGGED | TST-BRAIN-263 | PENDING | test_core_client_7_1_5_read_scratchpad | brain/tests/test_core_client.py |
| 97 | TAGGED | TST-BRAIN-264 | PENDING | test_core_client_7_1_6_send_message | brain/tests/test_core_client.py |
| 98 | TAGGED | TST-BRAIN-265 | PENDING | test_core_client_7_2_1_core_unreachable_retry | brain/tests/test_core_client.py |
| 99 | TAGGED | TST-BRAIN-266 | PENDING | test_core_client_7_2_2_core_returns_500 | brain/tests/test_core_client.py |
| 100 | TAGGED | TST-BRAIN-267 | PENDING | test_core_client_7_2_3_core_returns_401_fatal | brain/tests/test_core_client.py |
| 101 | TAGGED | TST-BRAIN-268 | PENDING | test_core_client_7_2_4_timeout_30s | brain/tests/test_core_client.py |
| 102 | TAGGED | TST-BRAIN-269 | PENDING | test_core_client_7_2_5_invalid_response_json | brain/tests/test_core_client.py |
| 103 | TAGGED | TST-BRAIN-407 | PENDING | test_core_client_7_2_6_dead_letter_notification | brain/tests/test_core_client.py |
| 104 | TAGGED | TST-BRAIN-458 | PENDING | test_core_client_7_3_1_rejects_empty_url | brain/tests/test_core_client.py |
| 105 | TAGGED | TST-BRAIN-459 | PENDING | test_core_client_7_3_2_rejects_no_auth | brain/tests/test_core_client.py |
| 106 | TAGGED | TST-BRAIN-460 | PENDING | test_core_client_7_3_3_context_manager | brain/tests/test_core_client.py |
| 107 | TAGGED | TST-BRAIN-461 | PENDING | test_core_client_7_3_4_pii_scrub | brain/tests/test_core_client.py |
| 108 | TAGGED | TST-BRAIN-320 | PENDING | test_crash_13_1_catchall_wraps_guardian | brain/tests/test_crash.py |
| 109 | TAGGED | TST-BRAIN-321 | PENDING | test_crash_13_2_stdout_sanitized_oneliner | brain/tests/test_crash.py |
| 110 | TAGGED | TST-BRAIN-322 | PENDING | test_crash_13_3_vault_full_traceback | brain/tests/test_crash.py |
| 111 | TAGGED | TST-BRAIN-323 | PENDING | test_crash_13_4_traceback_never_written_to_file | brain/tests/test_crash.py |
| 112 | TAGGED | TST-BRAIN-324 | PENDING | test_crash_13_5_task_id_correlated | brain/tests/test_crash.py |
| 113 | TAGGED | TST-BRAIN-325 | PENDING | test_crash_13_6_crash_handler_reraises | brain/tests/test_crash.py |
| 114 | TAGGED | TST-BRAIN-326 | PENDING | test_crash_13_7_core_unreachable | brain/tests/test_crash.py |
| 115 | TAGGED | TST-BRAIN-418 | PENDING | test_crash_13_8_logging_audit_no_pii | brain/tests/test_crash.py |
| 116 | TAGGED | TST-BRAIN-345 | PENDING | test_deferred_17_1_1_impulsive_spending_detection | brain/tests/test_deferred.py |
| 117 | TAGGED | TST-BRAIN-346 | PENDING | test_deferred_17_1_2_emotional_email_detection | brain/tests/test_deferred.py |
| 118 | TAGGED | TST-BRAIN-347 | PENDING | test_deferred_17_1_3_time_of_day_no_flag | brain/tests/test_deferred.py |
| 119 | TAGGED | TST-BRAIN-348 | PENDING | test_deferred_17_2a_1_offline_on_device_llm | brain/tests/test_deferred.py |
| 120 | TAGGED | TST-BRAIN-349 | PENDING | test_deferred_17_2a_2_fallback_to_home_node | brain/tests/test_deferred.py |
| 121 | TAGGED | TST-BRAIN-350 | PENDING | test_deferred_17_2a_3_model_version_mismatch | brain/tests/test_deferred.py |
| 122 | TAGGED | TST-BRAIN-351 | PENDING | test_deferred_17_2b_1_indirect_person_reference | brain/tests/test_deferred.py |
| 123 | TAGGED | TST-BRAIN-352 | PENDING | test_deferred_17_2b_2_coded_language | brain/tests/test_deferred.py |
| 124 | TAGGED | TST-BRAIN-353 | PENDING | test_deferred_17_2b_3_paraphrased_pii | brain/tests/test_deferred.py |
| 125 | TAGGED | TST-BRAIN-354 | PENDING | test_deferred_17_2b_4_tier3_latency | brain/tests/test_deferred.py |
| 126 | TAGGED | TST-BRAIN-355 | PENDING | test_deferred_17_2b_5_tier3_absent_no_llama | brain/tests/test_deferred.py |
| 127 | TAGGED | TST-BRAIN-356 | PENDING | test_deferred_17_2b_6_gemma_3n_e2b | brain/tests/test_deferred.py |
| 128 | TAGGED | TST-BRAIN-357 | PENDING | test_deferred_17_2b_7_functiongemma_270m | brain/tests/test_deferred.py |
| 129 | TAGGED | TST-BRAIN-358 | PENDING | test_deferred_17_3_1_enclave_attestation | brain/tests/test_deferred.py |
| 130 | TAGGED | TST-BRAIN-359 | PENDING | test_deferred_17_3_2_ram_inspection_impossible | brain/tests/test_deferred.py |
| 131 | TAGGED | TST-BRAIN-360 | PENDING | test_deferred_17_3_3_enclave_sealed_keys | brain/tests/test_deferred.py |
| 132 | TAGGED | TST-BRAIN-420 | PENDING | test_deferred_17_4_1_estate_recovery_queue_tasks | brain/tests/test_deferred.py |
| 133 | TAGGED | TST-BRAIN-421 | PENDING | test_deferred_17_4_2_zkp_credential_verification | brain/tests/test_deferred.py |
| 134 | TAGGED | TST-BRAIN-422 | PENDING | test_deferred_17_4_3_sss_recovery_coordination | brain/tests/test_deferred.py |
| 135 | TAGGED | TST-BRAIN-327 | PENDING | test_embedding_14_1_via_local_llama | brain/tests/test_embedding.py |
| 136 | TAGGED | TST-BRAIN-328 | PENDING | test_embedding_14_2_via_cloud_api | brain/tests/test_embedding.py |
| 137 | TAGGED | TST-BRAIN-329 | PENDING | test_embedding_14_3_stored_in_core | brain/tests/test_embedding.py |
| 138 | TAGGED | TST-BRAIN-330 | PENDING | test_embedding_14_4_core_stores_sqlite_vec | brain/tests/test_embedding.py |
| 139 | TAGGED | TST-BRAIN-331 | PENDING | test_embedding_14_5_fallback_llama_to_cloud | brain/tests/test_embedding.py |
| 140 | TAGGED | TST-BRAIN-332 | PENDING | test_embedding_14_6_no_embedding_available | brain/tests/test_embedding.py |
| 141 | TAGGED | TST-BRAIN-333 | PENDING | test_embedding_14_7_dimension_consistent | brain/tests/test_embedding.py |
| 142 | PENDING | -- | PENDING | test_l0_deterministic_from_metadata | brain/tests/test_enrichment.py |
| 143 | PENDING | -- | PENDING | test_l0_deterministic_from_summary_only | brain/tests/test_enrichment.py |
| 144 | PENDING | -- | PENDING | test_l0_deterministic_low_trust_includes_caveat | brain/tests/test_enrichment.py |
| 145 | PENDING | -- | PENDING | test_l0_deterministic_marketing_caveat | brain/tests/test_enrichment.py |
| 146 | PENDING | -- | PENDING | test_l0_deterministic_empty_returns_empty | brain/tests/test_enrichment.py |
| 147 | PENDING | -- | PENDING | test_enrich_raw_returns_all_fields | brain/tests/test_enrichment.py |
| 148 | PENDING | -- | PENDING | test_enrich_raw_low_trust_caveat | brain/tests/test_enrichment.py |
| 149 | PENDING | -- | PENDING | test_enrich_raw_high_trust_no_caveat | brain/tests/test_enrichment.py |
| 150 | PENDING | -- | PENDING | test_enrich_raw_embedding_from_l1 | brain/tests/test_enrichment.py |
| 151 | PENDING | -- | PENDING | test_enrich_raw_llm_failure_raises | brain/tests/test_enrichment.py |
| 152 | PENDING | -- | PENDING | test_enrich_raw_no_llm_raises | brain/tests/test_enrichment.py |
| 153 | PENDING | -- | PENDING | test_enrich_raw_embed_failure_raises | brain/tests/test_enrichment.py |
| 154 | PENDING | -- | PENDING | test_enrich_raw_summary_only_item | brain/tests/test_enrichment.py |
| 155 | PENDING | -- | PENDING | test_enrich_raw_no_body_no_summary_raises | brain/tests/test_enrichment.py |
| 156 | PENDING | -- | PENDING | test_enrich_item_single_llm_call | brain/tests/test_enrichment.py |
| 157 | PENDING | -- | PENDING | test_enrich_item_llm_failure_sets_failed | brain/tests/test_enrichment.py |
| 158 | PENDING | -- | PENDING | test_enrich_item_core_failure_sets_failed | brain/tests/test_enrichment.py |
| 159 | PENDING | -- | PENDING | test_enrich_item_low_trust_l0_caveat | brain/tests/test_enrichment.py |
| 160 | PENDING | -- | PENDING | test_enrich_pending_finds_and_enriches | brain/tests/test_enrichment.py |
| 161 | PENDING | -- | PENDING | test_enrich_pending_handles_search_failure | brain/tests/test_enrichment.py |
| 162 | PENDING | -- | PENDING | test_enrich_pending_empty_results | brain/tests/test_enrichment.py |
| 163 | TAGGED | TST-BRAIN-815 | PENDING | test_fc2_enrichment_scrubs_pii_before_cloud_llm | brain/tests/test_enrichment.py |
| 164 | TAGGED | TST-BRAIN-816 | PENDING | test_fc2_enrichment_fails_if_scrub_fails | brain/tests/test_enrichment.py |
| 165 | TAGGED | TST-BRAIN-817 | PENDING | test_fc2_enrichment_no_scrub_when_no_entity_vault | brain/tests/test_enrichment.py |
| 166 | TAGGED | TST-BRAIN-820 | PENDING | test_enrich_raw_rehydrates_l0_l1 | brain/tests/test_enrichment.py |
| 167 | TAGGED | TST-BRAIN-821 | PENDING | test_enrich_raw_without_entity_vault_no_rehydrate | brain/tests/test_enrichment.py |
| 168 | TAGGED | TST-BRAIN-822 | PENDING | test_enrich_raw_body_and_summary_not_scrubbed_in_item | brain/tests/test_enrichment.py |
| 169 | PENDING | -- | PENDING | test_invoice_date_creates_payment_reminder | brain/tests/test_event_extractor.py |
| 170 | PENDING | -- | PENDING | test_appointment_creates_reminder | brain/tests/test_event_extractor.py |
| 171 | PENDING | -- | PENDING | test_no_dates_no_reminders | brain/tests/test_event_extractor.py |
| 172 | PENDING | -- | PENDING | test_birthday_with_date_creates_reminder | brain/tests/test_event_extractor.py |
| 173 | PENDING | -- | PENDING | test_source_lineage_present | brain/tests/test_event_extractor.py |
| 174 | PENDING | -- | PENDING | test_birthday_without_date_skipped | brain/tests/test_event_extractor.py |
| 175 | PENDING | -- | PENDING | test_reminder_payload_valid_for_core | brain/tests/test_event_extractor.py |
| 176 | TAGGED | TST-BRAIN-467 | PENDING | test_fix_19_1_1_send_d2d_base64_json | brain/tests/test_fix_verification.py |
| 177 | TAGGED | TST-BRAIN-468 | PENDING | test_fix_19_1_2_send_d2d_valid_wire_json | brain/tests/test_fix_verification.py |
| 178 | TAGGED | TST-BRAIN-470 | PENDING | test_fix_19_2_2_sensitive_persona_scrubbed | brain/tests/test_fix_verification.py |
| 179 | TAGGED | TST-BRAIN-471 | PENDING | test_fix_19_2_3_open_persona_scrubbed_when_cloud_exists | brain/tests/test_fix_verification.py |
| 180 | TAGGED | TST-BRAIN-681 | PENDING | test_rehydrate_bare_faker_name | brain/tests/test_fix_verification.py |
| 181 | TAGGED | TST-BRAIN-682 | PENDING | test_pii_preserve_instruction_prepended_when_vault_exists | brain/tests/test_fix_verification.py |
| 182 | TAGGED | TST-BRAIN-472 | PENDING | test_fix_19_3_1_llm_router_config_keys | brain/tests/test_fix_verification.py |
| 183 | TAGGED | TST-BRAIN-473 | PENDING | test_fix_19_3_2_reconfigure_correct_keys | brain/tests/test_fix_verification.py |
| 184 | TAGGED | TST-BRAIN-476 | PENDING | test_fix_19_5_1_fiduciary_notify_failure_no_ack | brain/tests/test_fix_verification.py |
| 185 | TAGGED | TST-BRAIN-477 | PENDING | test_fix_19_5_2_solicited_notify_failure_still_acked | brain/tests/test_fix_verification.py |
| 186 | TAGGED | TST-BRAIN-478 | PENDING | test_fix_19_5_3_engagement_notify_failure_still_acked | brain/tests/test_fix_verification.py |
| 187 | TAGGED | TST-BRAIN-479 | PENDING | test_fix_19_6_1_concurrent_mcp_no_crosswire | brain/tests/test_fix_verification.py |
| 188 | TAGGED | TST-BRAIN-480 | PENDING | test_fix_19_6_2_mcp_id_mismatch_raises | brain/tests/test_fix_verification.py |
| 189 | TAGGED | TST-BRAIN-481 | PENDING | test_fix_19_6_3_mcp_session_has_lock | brain/tests/test_fix_verification.py |
| 190 | TAGGED | TST-BRAIN-483 | PENDING | test_fix_19_7_2_secure_flag_https | brain/tests/test_fix_verification.py |
| 191 | TAGGED | TST-BRAIN-484 | PENDING | test_fix_19_7_3_secure_flag_unset_http | brain/tests/test_fix_verification.py |
| 192 | TAGGED | TST-BRAIN-485 | PENDING | test_fix_19_7_4_logout_clears_cookie | brain/tests/test_fix_verification.py |
| 193 | TAGGED | TST-BRAIN-486 | PENDING | test_fix_19_7_5_logout_form_post | brain/tests/test_fix_verification.py |
| 194 | TAGGED | TST-BRAIN-488 | PENDING | test_fix_19_8_2_tldextract_cache_set | brain/tests/test_fix_verification.py |
| 195 | TAGGED | TST-BRAIN-489 | PENDING | test_fix_19_8_3_mcp_commands_from_env | brain/tests/test_fix_verification.py |
| 196 | TAGGED | TST-BRAIN-490 | PENDING | test_fix_19_8_4_empty_mcp_config_inert | brain/tests/test_fix_verification.py |
| 197 | TAGGED | TST-BRAIN-491 | PENDING | test_fix_19_8_5_presidio_primary | brain/tests/test_fix_verification.py |
| 198 | TAGGED | TST-BRAIN-492 | PENDING | test_fix_19_8_6_spacy_fallback | brain/tests/test_fix_verification.py |
| 199 | TAGGED | TST-BRAIN-493 | PENDING | test_fix_19_8_7_none_fallback | brain/tests/test_fix_verification.py |
| 200 | TAGGED | TST-BRAIN-494 | PENDING | test_fix_19_9_1_handle_reason_exception_500 | brain/tests/test_fix_verification.py |
| 201 | TAGGED | TST-BRAIN-495 | PENDING | test_fix_19_9_2_process_crash_status_error | brain/tests/test_fix_verification.py |
| 202 | TAGGED | TST-BRAIN-496 | PENDING | test_fix_19_9_3_reason_no_empty_result | brain/tests/test_fix_verification.py |
| 203 | TAGGED | TST-BRAIN-498 | PENDING | test_fix_19_10_2_contacts_escapes_did_attribute | brain/tests/test_fix_verification.py |
| 204 | TAGGED | TST-BRAIN-500 | PENDING | test_fix_19_11_1_lifespan_starts_sync | brain/tests/test_fix_verification.py |
| 205 | TAGGED | TST-BRAIN-501 | PENDING | test_fix_19_11_2_sync_failure_no_crash | brain/tests/test_fix_verification.py |
| 206 | TAGGED | TST-BRAIN-502 | PENDING | test_fix_19_11_3_lifespan_shutdown_cancels | brain/tests/test_fix_verification.py |
| 207 | TAGGED | TST-BRAIN-019 | PENDING | test_guardian_2_1_1_fiduciary_flight_cancelled | brain/tests/test_guardian.py |
| 208 | TAGGED | TST-BRAIN-020 | PENDING | test_guardian_2_1_2_fiduciary_security_threat | brain/tests/test_guardian.py |
| 209 | TAGGED | TST-BRAIN-029 | PENDING | test_guardian_2_1_3_fiduciary_health_critical | brain/tests/test_guardian.py |
| 210 | TAGGED | TST-BRAIN-021 | PENDING | test_guardian_2_1_4_fiduciary_financial_overdraft | brain/tests/test_guardian.py |
| 211 | TAGGED | TST-BRAIN-022 | PENDING | test_guardian_2_1_5_solicited_meeting_reminder | brain/tests/test_guardian.py |
| 212 | TAGGED | TST-BRAIN-023 | PENDING | test_guardian_2_1_6_solicited_search_result | brain/tests/test_guardian.py |
| 213 | TAGGED | TST-BRAIN-024 | PENDING | test_guardian_2_1_7_engagement_podcast_released | brain/tests/test_guardian.py |
| 214 | TAGGED | TST-BRAIN-025 | PENDING | test_guardian_2_1_8_engagement_promo_offer | brain/tests/test_guardian.py |
| 215 | TAGGED | TST-BRAIN-361 | PENDING | test_guardian_2_1_9_fiduciary_overrides_dnd | brain/tests/test_guardian.py |
| 216 | TAGGED | TST-BRAIN-362 | PENDING | test_guardian_2_1_10_solicited_deferred_during_dnd | brain/tests/test_guardian.py |
| 217 | TAGGED | TST-BRAIN-363 | PENDING | test_guardian_2_1_11_engagement_never_interrupts | brain/tests/test_guardian.py |
| 218 | TAGGED | TST-BRAIN-027 | PENDING | test_guardian_2_1_12_ambiguous_defaults_to_engagement | brain/tests/test_guardian.py |
| 219 | TAGGED | TST-BRAIN-026 | PENDING | test_guardian_2_1_13_engagement_social_media_update | brain/tests/test_guardian.py |
| 220 | TAGGED | TST-BRAIN-028 | PENDING | test_guardian_2_1_14_no_notification_routine_sync | brain/tests/test_guardian.py |
| 221 | TAGGED | TST-BRAIN-030 | PENDING | test_guardian_2_1_15_fiduciary_composite_heuristic | brain/tests/test_guardian.py |
| 222 | TAGGED | TST-BRAIN-672 | PENDING | test_guardian_2_1_16_llm_detects_casual_emergency | brain/tests/test_guardian.py |
| 223 | TAGGED | TST-BRAIN-673 | PENDING | test_guardian_2_1_17_llm_failure_defaults_to_engagement | brain/tests/test_guardian.py |
| 224 | TAGGED | TST-BRAIN-674 | PENDING | test_guardian_2_1_18_llm_low_confidence_defaults_to_engagement | brain/tests/test_guardian.py |
| 225 | TAGGED | TST-BRAIN-675 | PENDING | test_guardian_2_1_19_llm_not_called_for_hard_rails | brain/tests/test_guardian.py |
| 226 | TAGGED | TST-BRAIN-676 | PENDING | test_guardian_2_1_20_llm_malformed_json_falls_back | brain/tests/test_guardian.py |
| 227 | TAGGED | TST-BRAIN-677 | PENDING | test_guardian_2_1_21_llm_invalid_decision_falls_back | brain/tests/test_guardian.py |
| 228 | TAGGED | TST-BRAIN-678 | PENDING | test_guardian_2_1_22_llm_solicited_classification | brain/tests/test_guardian.py |
| 229 | TAGGED | TST-BRAIN-679 | PENDING | test_guardian_2_1_23_llm_spam_urgency_stays_engagement | brain/tests/test_guardian.py |
| 230 | TAGGED | TST-BRAIN-680 | PENDING | test_guardian_2_1_24_scrub_failure_falls_back_to_engagement | brain/tests/test_guardian.py |
| 231 | TAGGED | TST-BRAIN-031 | PENDING | test_guardian_2_2_1_vault_unlocked | brain/tests/test_guardian.py |
| 232 | TAGGED | TST-BRAIN-033 | PENDING | test_guardian_2_2_2_vault_locked | brain/tests/test_guardian.py |
| 233 | TAGGED | TST-BRAIN-032 | PENDING | test_guardian_2_2_3_degraded_mode_when_vault_unreachable | brain/tests/test_guardian.py |
| 234 | TAGGED | TST-BRAIN-034 | PENDING | test_guardian_2_2_4_vault_unlocked_idempotent | brain/tests/test_guardian.py |
| 235 | TAGGED | TST-BRAIN-035 | PENDING | test_guardian_2_3_1_process_event_returns_action | brain/tests/test_guardian.py |
| 236 | TAGGED | TST-BRAIN-036 | PENDING | test_guardian_2_3_2_multi_step_reasoning_with_scratchpad | brain/tests/test_guardian.py |
| 237 | TAGGED | TST-BRAIN-037 | PENDING | test_guardian_2_3_11_agent_intent_review_general | brain/tests/test_guardian.py |
| 238 | TAGGED | TST-BRAIN-038 | PENDING | test_guardian_2_3_3_agent_intent_review_safe | brain/tests/test_guardian.py |
| 239 | TAGGED | TST-BRAIN-039 | PENDING | test_guardian_2_3_4_agent_intent_review_risky | brain/tests/test_guardian.py |
| 240 | TAGGED | TST-BRAIN-040 | PENDING | test_guardian_2_3_5_agent_intent_review_blocked | brain/tests/test_guardian.py |
| 241 | TAGGED | TST-BRAIN-364 | PENDING | test_guardian_2_3_6_risky_intent_logs_audit_trail | brain/tests/test_guardian.py |
| 242 | TAGGED | TST-BRAIN-365 | PENDING | test_guardian_2_3_7_blocked_intent_logs_audit_trail | brain/tests/test_guardian.py |
| 243 | TAGGED | TST-BRAIN-041 | PENDING | test_guardian_2_3_8_processing_timeout | brain/tests/test_guardian.py |
| 244 | TAGGED | TST-BRAIN-042 | PENDING | test_guardian_2_3_9_error_recovery_continues_loop | brain/tests/test_guardian.py |
| 245 | TAGGED | TST-BRAIN-043 | PENDING | test_guardian_2_3_12_crash_handler_sanitized_stdout | brain/tests/test_guardian.py |
| 246 | TAGGED | TST-BRAIN-044 | PENDING | test_guardian_2_3_10_crash_handler_writes_report | brain/tests/test_guardian.py |
| 247 | TAGGED | TST-BRAIN-045 | PENDING | test_guardian_2_3_1_1_never_calls_messages_send | brain/tests/test_guardian.py |
| 248 | TAGGED | TST-BRAIN-046 | PENDING | test_guardian_2_3_1_2_draft_via_gmail_api | brain/tests/test_guardian.py |
| 249 | TAGGED | TST-BRAIN-047 | PENDING | test_guardian_2_3_1_3_draft_includes_confidence_score | brain/tests/test_guardian.py |
| 250 | TAGGED | TST-BRAIN-048 | PENDING | test_guardian_2_3_1_9_below_threshold_flagged | brain/tests/test_guardian.py |
| 251 | TAGGED | TST-BRAIN-049 | PENDING | test_guardian_2_3_1_10_high_risk_legal | brain/tests/test_guardian.py |
| 252 | TAGGED | TST-BRAIN-050 | PENDING | test_guardian_2_3_1_11_high_risk_financial | brain/tests/test_guardian.py |
| 253 | TAGGED | TST-BRAIN-051 | PENDING | test_guardian_2_3_1_12_high_risk_emotional | brain/tests/test_guardian.py |
| 254 | TAGGED | TST-BRAIN-366 | PENDING | test_guardian_2_3_1_4_high_risk_classified_correctly | brain/tests/test_guardian.py |
| 255 | TAGGED | TST-BRAIN-367 | PENDING | test_guardian_2_3_1_5_draft_preserves_original_intent | brain/tests/test_guardian.py |
| 256 | TAGGED | TST-BRAIN-368 | PENDING | test_guardian_2_3_1_6_no_send_even_if_agent_requests | brain/tests/test_guardian.py |
| 257 | TAGGED | TST-BRAIN-052 | PENDING | test_guardian_2_3_1_7_draft_notification_to_user | brain/tests/test_guardian.py |
| 258 | TAGGED | TST-BRAIN-369 | PENDING | test_guardian_2_3_1_8_bulk_draft_rate_limited | brain/tests/test_guardian.py |
| 259 | TAGGED | TST-BRAIN-053 | PENDING | test_guardian_2_3_2_1_upi_payment_intent_handover | brain/tests/test_guardian.py |
| 260 | TAGGED | TST-BRAIN-054 | PENDING | test_guardian_2_3_2_2_crypto_payment_intent_handover | brain/tests/test_guardian.py |
| 261 | TAGGED | TST-BRAIN-055 | PENDING | test_guardian_2_3_2_3_web_payment_intent_handover | brain/tests/test_guardian.py |
| 262 | TAGGED | TST-BRAIN-056 | PENDING | test_guardian_2_3_2_4_never_sees_credentials | brain/tests/test_guardian.py |
| 263 | TAGGED | TST-BRAIN-370 | PENDING | test_guardian_2_3_2_5_agent_never_holds_keys | brain/tests/test_guardian.py |
| 264 | TAGGED | TST-BRAIN-057 | PENDING | test_guardian_2_3_2_6_outcome_recorded_after_handover | brain/tests/test_guardian.py |
| 265 | TAGGED | TST-BRAIN-058 | PENDING | test_guardian_2_3_2_7_cart_handover_expiry | brain/tests/test_guardian.py |
| 266 | TAGGED | TST-BRAIN-059 | PENDING | test_guardian_2_3_2_10_outcome_followup_timing | brain/tests/test_guardian.py |
| 267 | TAGGED | TST-BRAIN-060 | PENDING | test_guardian_2_3_2_11_outcome_inference_no_explicit_response | brain/tests/test_guardian.py |
| 268 | TAGGED | TST-BRAIN-061 | PENDING | test_guardian_2_3_2_12_outcome_anonymization | brain/tests/test_guardian.py |
| 269 | TAGGED | TST-BRAIN-062 | PENDING | test_guardian_2_5_briefing_works_without_scrubber | brain/tests/test_guardian.py |
| 270 | TAGGED | TST-BRAIN-371 | PENDING | test_guardian_2_3_2_8_handover_includes_summary | brain/tests/test_guardian.py |
| 271 | TAGGED | TST-BRAIN-372 | PENDING | test_guardian_2_3_2_9_duplicate_handover_idempotent | brain/tests/test_guardian.py |
| 272 | TAGGED | TST-BRAIN-062 | PENDING | test_guardian_2_4_1_non_streaming_whisper | brain/tests/test_guardian.py |
| 273 | TAGGED | TST-BRAIN-063 | PENDING | test_guardian_2_4_2_streaming_whisper | brain/tests/test_guardian.py |
| 274 | TAGGED | TST-BRAIN-064 | PENDING | test_guardian_2_4_3_disconnected_client_queues | brain/tests/test_guardian.py |
| 275 | TAGGED | TST-BRAIN-065 | PENDING | test_guardian_2_4_4_whisper_includes_vault_references | brain/tests/test_guardian.py |
| 276 | TAGGED | TST-BRAIN-066 | PENDING | test_guardian_2_5_1_morning_briefing_generated | brain/tests/test_guardian.py |
| 277 | TAGGED | TST-BRAIN-067 | PENDING | test_guardian_2_5_2_empty_briefing_no_items | brain/tests/test_guardian.py |
| 278 | TAGGED | TST-BRAIN-068 | PENDING | test_guardian_2_5_3_briefing_items_ordered_by_relevance | brain/tests/test_guardian.py |
| 279 | TAGGED | TST-BRAIN-069 | PENDING | test_guardian_2_5_4_dnd_defers_briefing | brain/tests/test_guardian.py |
| 280 | TAGGED | TST-BRAIN-070 | PENDING | test_guardian_2_5_5_briefing_dedup | brain/tests/test_guardian.py |
| 281 | TAGGED | TST-BRAIN-071 | PENDING | test_guardian_2_5_6_restricted_persona_summary | brain/tests/test_guardian.py |
| 282 | TAGGED | TST-BRAIN-072 | PENDING | test_guardian_2_5_10_zero_restricted_accesses_omitted | brain/tests/test_guardian.py |
| 283 | TAGGED | TST-BRAIN-073 | PENDING | test_guardian_2_5_11_restricted_summary_queries_audit_log | brain/tests/test_guardian.py |
| 284 | TAGGED | TST-BRAIN-074 | PENDING | test_guardian_2_5_12_briefing_permanently_disabled | brain/tests/test_guardian.py |
| 285 | TAGGED | TST-BRAIN-373 | PENDING | test_guardian_2_5_7_briefing_includes_fiduciary_recap | brain/tests/test_guardian.py |
| 286 | TAGGED | TST-BRAIN-374 | PENDING | test_guardian_2_5_8_briefing_multi_persona | brain/tests/test_guardian.py |
| 287 | TAGGED | TST-BRAIN-375 | PENDING | test_guardian_2_5_9_briefing_respects_user_preferences | brain/tests/test_guardian.py |
| 288 | TAGGED | TST-BRAIN-075 | PENDING | test_guardian_2_6_1_nudge_on_conversation_open | brain/tests/test_guardian.py |
| 289 | TAGGED | TST-BRAIN-076 | PENDING | test_guardian_2_6_2_nudge_context_assembly | brain/tests/test_guardian.py |
| 290 | TAGGED | TST-BRAIN-077 | PENDING | test_guardian_2_6_3_nudge_delivery_via_ws | brain/tests/test_guardian.py |
| 291 | TAGGED | TST-BRAIN-078 | PENDING | test_guardian_2_6_4_nudge_no_context_no_interrupt | brain/tests/test_guardian.py |
| 292 | TAGGED | TST-BRAIN-079 | PENDING | test_guardian_2_6_5_nudge_respects_persona_boundaries | brain/tests/test_guardian.py |
| 293 | TAGGED | TST-BRAIN-080 | PENDING | test_guardian_2_6_6_pending_promise_detection | brain/tests/test_guardian.py |
| 294 | TAGGED | TST-BRAIN-081 | PENDING | test_guardian_2_6_7_calendar_context_included | brain/tests/test_guardian.py |
| 295 | TAGGED | TST-BRAIN-082 | PENDING | test_guardian_2_7_1_grant_specific_sharing | brain/tests/test_guardian.py |
| 296 | TAGGED | TST-BRAIN-083 | PENDING | test_guardian_2_7_2_revoke_sharing_bulk | brain/tests/test_guardian.py |
| 297 | TAGGED | TST-BRAIN-084 | PENDING | test_guardian_2_7_3_query_current_sharing | brain/tests/test_guardian.py |
| 298 | TAGGED | TST-BRAIN-085 | PENDING | test_guardian_2_7_4_grant_full_sharing_specific_category | brain/tests/test_guardian.py |
| 299 | TAGGED | TST-BRAIN-086 | PENDING | test_guardian_2_7_5_ambiguous_request_asks_clarification | brain/tests/test_guardian.py |
| 300 | TAGGED | TST-BRAIN-087 | PENDING | test_guardian_2_8_1_brain_prepares_tiered_payload | brain/tests/test_guardian.py |
| 301 | TAGGED | TST-BRAIN-088 | PENDING | test_guardian_2_8_2_brain_sends_max_detail | brain/tests/test_guardian.py |
| 302 | TAGGED | TST-BRAIN-089 | PENDING | test_guardian_2_8_3_brain_never_prefilters_by_policy | brain/tests/test_guardian.py |
| 303 | TAGGED | TST-BRAIN-090 | PENDING | test_guardian_2_8_4_brain_calls_post_dina_send | brain/tests/test_guardian.py |
| 304 | TAGGED | TST-BRAIN-392 | PENDING | test_guardian_2_3_13_task_ack_after_success | brain/tests/test_guardian.py |
| 305 | TAGGED | TST-BRAIN-393 | PENDING | test_guardian_2_3_14_task_not_acked_on_failure | brain/tests/test_guardian.py |
| 306 | TAGGED | TST-BRAIN-394 | PENDING | test_guardian_2_3_15_retried_task_after_crash | brain/tests/test_guardian.py |
| 307 | TAGGED | TST-BRAIN-398 | PENDING | test_guardian_2_2_5_persona_locked_whisper | brain/tests/test_guardian.py |
| 308 | TAGGED | TST-BRAIN-399 | PENDING | test_guardian_2_2_6_persona_unlock_retry | brain/tests/test_guardian.py |
| 309 | TAGGED | TST-BRAIN-411 | PENDING | test_guardian_2_6_8_disconnection_pattern | brain/tests/test_guardian.py |
| 310 | TAGGED | TST-BRAIN-412 | PENDING | test_guardian_2_8_5_didcomm_message_type_parsing | brain/tests/test_guardian.py |
| 311 | PENDING | -- | PENDING | test_guardian_2_10_1_disclosure_approved_unknown_id | brain/tests/test_guardian.py |
| 312 | PENDING | -- | PENDING | test_guardian_2_10_2_disclosure_approved_text_mismatch | brain/tests/test_guardian.py |
| 313 | PENDING | -- | PENDING | test_guardian_2_10_3_disclosure_approved_binding_correct | brain/tests/test_guardian.py |
| 314 | PENDING | -- | PENDING | test_guardian_2_10_4_vault_query_error_returns_disclosure_error | brain/tests/test_guardian.py |
| 315 | TAGGED | TST-BRAIN-545 | PENDING | test_guardian_19_1_no_hallucinated_trust_scores | brain/tests/test_guardian.py |
| 316 | TAGGED | TST-BRAIN-559 | PENDING | test_guardian_20_1_draft_expires_after_72_hours | brain/tests/test_guardian.py |
| 317 | TAGGED | TST-BRAIN-538 | PENDING | test_guardian_18_3_briefing_pii_scrubbed | brain/tests/test_guardian.py |
| 318 | TAGGED | TST-BRAIN-569 | PENDING | test_guardian_20_1_approval_invalidated_on_payload_mutation | brain/tests/test_guardian.py |
| 319 | PENDING | -- | PENDING | test_guardian_19_2_reviews_exist_no_outcome_data | brain/tests/test_guardian.py |
| 320 | TAGGED | TST-BRAIN-563 | PENDING | test_guardian_20_1_messages_send_always_downgraded | brain/tests/test_guardian.py |
| 321 | PENDING | -- | PENDING | test_guardian_20_1_escalation_unreviewed_high_risk_draft | brain/tests/test_guardian.py |
| 322 | PENDING | -- | PENDING | test_guardian_19_3_bot_trust_penalty_stripped_attribution | brain/tests/test_guardian.py |
| 323 | PENDING | -- | PENDING | test_approval_20_1_cart_handover_expires_after_12_hours | brain/tests/test_guardian.py |
| 324 | PENDING | -- | PENDING | test_guardian_20_1_multiple_pending_drafts_no_silent_batch | brain/tests/test_guardian.py |
| 325 | TAGGED | TST-BRAIN-539 | PENDING | test_guardian_18_3_briefing_cross_persona_safety | brain/tests/test_guardian.py |
| 326 | PENDING | -- | PENDING | test_tst_brain_541_briefing_timing_respects_timezone | brain/tests/test_guardian.py |
| 327 | PENDING | -- | PENDING | test_guardian_20_1_concurrent_draft_cart_same_product | brain/tests/test_guardian.py |
| 328 | TAGGED | TST-BRAIN-542 | PENDING | test_guardian_19_1_attribution_mandatory_in_recommendations | brain/tests/test_guardian.py |
| 329 | TAGGED | TST-BRAIN-564 | PENDING | test_guardian_20_1_approval_state_survives_brain_restart | brain/tests/test_guardian.py |
| 330 | TAGGED | TST-BRAIN-543 | PENDING | test_guardian_19_1_deep_link_creators_get_traffic | brain/tests/test_guardian.py |
| 331 | TAGGED | TST-BRAIN-549 | PENDING | test_guardian_19_2_single_review_limited_data | brain/tests/test_guardian.py |
| 332 | PENDING | -- | PENDING | test_tst_brain_544_sponsored_content_disclosed | brain/tests/test_guardian.py |
| 333 | PENDING | -- | PENDING | test_tst_brain_554_stale_reviews_all_over_one_year | brain/tests/test_guardian.py |
| 334 | PENDING | -- | PENDING | test_tst_brain_571_sponsorship_cannot_distort_ranking | brain/tests/test_guardian.py |
| 335 | PENDING | -- | PENDING | test_tst_brain_550_sparse_but_conflicting_reviews | brain/tests/test_guardian.py |
| 336 | PENDING | -- | PENDING | test_tst_brain_548_zero_reviews_zero_attestations | brain/tests/test_guardian.py |
| 337 | PENDING | -- | PENDING | test_tst_brain_556_expert_review_deep_linked_not_extracted | brain/tests/test_guardian.py |
| 338 | PENDING | -- | PENDING | test_tst_brain_567_no_unsolicited_discovery | brain/tests/test_guardian.py |
| 339 | PENDING | -- | PENDING | test_tst_brain_552_dense_with_strong_consensus | brain/tests/test_guardian.py |
| 340 | PENDING | -- | PENDING | test_tst_brain_551_sparse_but_unanimous | brain/tests/test_guardian.py |
| 341 | PENDING | -- | PENDING | test_tst_brain_557_multiple_sources_attributed_individually | brain/tests/test_guardian.py |
| 342 | PENDING | -- | PENDING | test_tst_brain_546_sparse_trust_data_honest_uncertainty | brain/tests/test_guardian.py |
| 343 | PENDING | -- | PENDING | test_tst_brain_566_ranking_explainability | brain/tests/test_guardian.py |
| 344 | PENDING | -- | PENDING | test_tst_brain_547_dense_trust_confidence_proportional | brain/tests/test_guardian.py |
| 345 | PENDING | -- | PENDING | test_tst_brain_555_trust_ring_weighting_visible | brain/tests/test_guardian.py |
| 346 | TAGGED | TST-BRAIN-561 | PENDING | test_analyze_trust_density_zero_when_unscoped | brain/tests/test_guardian.py |
| 347 | TAGGED | TST-BRAIN-562 | PENDING | test_apply_density_enforcement_zero_injects_disclosure | brain/tests/test_guardian.py |
| 348 | PENDING | -- | PENDING | test_density_enforcement_strips_fabricated_scores_zero_tier | brain/tests/test_guardian.py |
| 349 | PENDING | -- | PENDING | test_guard_scan_failure_falls_back_to_regex | brain/tests/test_guardian.py |
| 350 | TAGGED | TST-BRAIN-563 | PENDING | test_guardian_density_miss_path_vague_prompt_trust_rich_vault | brain/tests/test_guardian.py |
| 351 | TAGGED | TST-BRAIN-564 | PENDING | test_guardian_density_miss_path_lowercase_entity | brain/tests/test_guardian.py |
| 352 | PENDING | -- | PENDING | test_guardian_approval_needed_returns_notification | brain/tests/test_guardian.py |
| 353 | PENDING | -- | PENDING | test_guardian_approval_needed_calls_telegram | brain/tests/test_guardian.py |
| 354 | PENDING | -- | PENDING | test_guardian_approval_needed_telegram_failure_graceful | brain/tests/test_guardian.py |
| 355 | PENDING | -- | PENDING | test_guardian_reminder_fired_reads_direct_lineage_fields | brain/tests/test_guardian.py |
| 356 | PENDING | -- | PENDING | test_post_publish_extracts_events | brain/tests/test_guardian.py |
| 357 | PENDING | -- | PENDING | test_post_publish_updates_contact_by_did | brain/tests/test_guardian.py |
| 358 | PENDING | -- | PENDING | test_post_publish_no_contact_did_skips_update | brain/tests/test_guardian.py |
| 359 | TAGGED | TST-BRAIN-807 | PENDING | test_document_ingest_uses_direct_vault_write | brain/tests/test_guardian.py |
| 360 | TAGGED | TST-BRAIN-800 | PENDING | test_d2d_memory_note_staged | brain/tests/test_guardian.py |
| 361 | TAGGED | TST-BRAIN-801 | PENDING | test_d2d_trust_attestation_staged | brain/tests/test_guardian.py |
| 362 | TAGGED | TST-BRAIN-802 | PENDING | test_d2d_arrival_not_staged | brain/tests/test_guardian.py |
| 363 | TAGGED | TST-BRAIN-803 | PENDING | test_d2d_commerce_review_staged | brain/tests/test_guardian.py |
| 364 | TAGGED | TST-BRAIN-804 | PENDING | test_d2d_context_share_staged | brain/tests/test_guardian.py |
| 365 | TAGGED | TST-BRAIN-805 | PENDING | test_d2d_unknown_type_not_staged | brain/tests/test_guardian.py |
| 366 | TAGGED | TST-BRAIN-806 | PENDING | test_d2d_realtime_signals_not_staged | brain/tests/test_guardian.py |
| 367 | TAGGED | TST-BRAIN-121 | PENDING | test_llm_4_1_1_simple_lookup_no_llm | brain/tests/test_llm.py |
| 368 | TAGGED | TST-BRAIN-122 | PENDING | test_llm_4_1_2_basic_summarization_local | brain/tests/test_llm.py |
| 369 | TAGGED | TST-BRAIN-123 | PENDING | test_llm_4_1_3_basic_summarization_cloud_fallback | brain/tests/test_llm.py |
| 370 | TAGGED | TST-BRAIN-124 | PENDING | test_llm_4_1_4_complex_reasoning_prefers_local | brain/tests/test_llm.py |
| 371 | TAGGED | TST-BRAIN-125 | PENDING | test_llm_4_1_5_sensitive_persona_local | brain/tests/test_llm.py |
| 372 | TAGGED | TST-BRAIN-126 | PENDING | test_llm_4_1_6_sensitive_persona_entity_vault_cloud | brain/tests/test_llm.py |
| 373 | TAGGED | TST-BRAIN-127 | PENDING | test_llm_4_1_7_fallback_local_to_cloud | brain/tests/test_llm.py |
| 374 | TAGGED | TST-BRAIN-128 | PENDING | test_llm_4_1_8_fallback_cloud_to_local | brain/tests/test_llm.py |
| 375 | TAGGED | TST-BRAIN-129 | PENDING | test_llm_4_1_9_no_llm_available | brain/tests/test_llm.py |
| 376 | TAGGED | TST-BRAIN-130 | PENDING | test_llm_4_1_10_model_selection_by_task_type | brain/tests/test_llm.py |
| 377 | TAGGED | TST-BRAIN-131 | PENDING | test_llm_4_1_11_user_configures_preferred_cloud | brain/tests/test_llm.py |
| 378 | TAGGED | TST-BRAIN-132 | PENDING | test_llm_4_1_12_pii_scrub_failure_blocks_cloud_send | brain/tests/test_llm.py |
| 379 | TAGGED | TST-BRAIN-133 | PENDING | test_llm_4_2_1_successful_completion | brain/tests/test_llm.py |
| 380 | TAGGED | TST-BRAIN-134 | PENDING | test_llm_4_2_2_streaming_response | brain/tests/test_llm.py |
| 381 | TAGGED | TST-BRAIN-135 | PENDING | test_llm_4_2_3_timeout | brain/tests/test_llm.py |
| 382 | TAGGED | TST-BRAIN-136 | PENDING | test_llm_4_2_4_token_limit_exceeded | brain/tests/test_llm.py |
| 383 | TAGGED | TST-BRAIN-137 | PENDING | test_llm_4_2_5_malformed_llm_response | brain/tests/test_llm.py |
| 384 | TAGGED | TST-BRAIN-138 | PENDING | test_llm_4_2_6_rate_limiting | brain/tests/test_llm.py |
| 385 | TAGGED | TST-BRAIN-139 | PENDING | test_llm_4_2_7_cost_tracking | brain/tests/test_llm.py |
| 386 | TAGGED | TST-BRAIN-396 | PENDING | test_llm_4_1_13_cloud_consent_not_given_rejects | brain/tests/test_llm.py |
| 387 | TAGGED | TST-BRAIN-397 | PENDING | test_llm_4_1_14_cloud_consent_given_processes | brain/tests/test_llm.py |
| 388 | TAGGED | TST-BRAIN-403 | PENDING | test_llm_4_1_15_hybrid_search_merging_formula | brain/tests/test_llm.py |
| 389 | TAGGED | TST-BRAIN-404 | PENDING | test_llm_4_1_16_hybrid_search_dedup | brain/tests/test_llm.py |
| 390 | TAGGED | TST-BRAIN-462 | PENDING | test_llm_4_3_1_available_models | brain/tests/test_llm.py |
| 391 | TAGGED | TST-BRAIN-463 | PENDING | test_llm_4_3_2_no_providers_error | brain/tests/test_llm.py |
| 392 | TAGGED | TST-BRAIN-226 | PENDING | test_mcp_6_1_1_route_to_specialist_agent | brain/tests/test_mcp.py |
| 393 | TAGGED | TST-BRAIN-227 | PENDING | test_mcp_6_1_2_route_by_capability | brain/tests/test_mcp.py |
| 394 | TAGGED | TST-BRAIN-228 | PENDING | test_mcp_6_1_3_route_by_trust_scores | brain/tests/test_mcp.py |
| 395 | TAGGED | TST-BRAIN-229 | PENDING | test_mcp_6_1_4_no_suitable_agent_fallback | brain/tests/test_mcp.py |
| 396 | TAGGED | TST-BRAIN-230 | PENDING | test_mcp_6_1_5_agent_timeout | brain/tests/test_mcp.py |
| 397 | TAGGED | TST-BRAIN-231 | PENDING | test_mcp_6_2_1_safe_intent_auto_approved | brain/tests/test_mcp.py |
| 398 | TAGGED | TST-BRAIN-232 | PENDING | test_mcp_6_2_2_risky_intent_flagged | brain/tests/test_mcp.py |
| 399 | TAGGED | TST-BRAIN-233 | PENDING | test_mcp_6_2_3_blocked_intent_denied | brain/tests/test_mcp.py |
| 400 | TAGGED | TST-BRAIN-234 | PENDING | test_mcp_6_2_4_agent_raw_vault_access_blocked | brain/tests/test_mcp.py |
| 401 | TAGGED | TST-BRAIN-235 | PENDING | test_mcp_6_2_5_untrusted_source_higher_scrutiny | brain/tests/test_mcp.py |
| 402 | TAGGED | TST-BRAIN-236 | PENDING | test_mcp_6_2_6_agent_response_pii_leakage_check | brain/tests/test_mcp.py |
| 403 | TAGGED | TST-BRAIN-237 | PENDING | test_mcp_6_2_7_agent_cannot_access_encryption_keys | brain/tests/test_mcp.py |
| 404 | TAGGED | TST-BRAIN-238 | PENDING | test_mcp_6_2_8_agent_cannot_access_persona_metadata | brain/tests/test_mcp.py |
| 405 | TAGGED | TST-BRAIN-239 | PENDING | test_mcp_6_2_9_agent_cannot_initiate_calls_to_dina | brain/tests/test_mcp.py |
| 406 | TAGGED | TST-BRAIN-240 | PENDING | test_mcp_6_2_10_disconnect_compromised_agent | brain/tests/test_mcp.py |
| 407 | TAGGED | TST-BRAIN-241 | PENDING | test_mcp_6_2_11_agent_cannot_enumerate_other_agents | brain/tests/test_mcp.py |
| 408 | TAGGED | TST-BRAIN-242 | PENDING | test_mcp_6_2_12_constraint_draft_only_enforced | brain/tests/test_mcp.py |
| 409 | TAGGED | TST-BRAIN-243 | PENDING | test_mcp_6_2_13_constraint_no_payment_enforced | brain/tests/test_mcp.py |
| 410 | TAGGED | TST-BRAIN-244 | PENDING | test_mcp_6_2_14_silence_protocol_checked_before_delegation | brain/tests/test_mcp.py |
| 411 | TAGGED | TST-BRAIN-245 | PENDING | test_mcp_6_2_15_agent_outcome_recorded_in_tier3 | brain/tests/test_mcp.py |
| 412 | TAGGED | TST-BRAIN-246 | PENDING | test_mcp_6_2_16_no_raw_vault_data_to_agents | brain/tests/test_mcp.py |
| 413 | TAGGED | TST-BRAIN-247 | PENDING | test_mcp_6_3_1_initialize_session | brain/tests/test_mcp.py |
| 414 | TAGGED | TST-BRAIN-248 | PENDING | test_mcp_6_3_2_tool_invocation | brain/tests/test_mcp.py |
| 415 | TAGGED | TST-BRAIN-249 | PENDING | test_mcp_6_3_3_session_cleanup | brain/tests/test_mcp.py |
| 416 | TAGGED | TST-BRAIN-250 | PENDING | test_mcp_6_3_4_server_unreachable | brain/tests/test_mcp.py |
| 417 | TAGGED | TST-BRAIN-251 | PENDING | test_mcp_6_4_1_query_includes_context_not_identity | brain/tests/test_mcp.py |
| 418 | TAGGED | TST-BRAIN-252 | PENDING | test_mcp_6_4_2_budget_from_financial_persona_stripped | brain/tests/test_mcp.py |
| 419 | TAGGED | TST-BRAIN-253 | PENDING | test_mcp_6_4_3_medical_details_generalized | brain/tests/test_mcp.py |
| 420 | TAGGED | TST-BRAIN-254 | PENDING | test_mcp_6_4_4_no_persona_data_in_query | brain/tests/test_mcp.py |
| 421 | TAGGED | TST-BRAIN-255 | PENDING | test_mcp_6_4_5_past_purchase_context_included | brain/tests/test_mcp.py |
| 422 | TAGGED | TST-BRAIN-256 | PENDING | test_mcp_6_4_6_no_pii_even_if_user_types_pii | brain/tests/test_mcp.py |
| 423 | TAGGED | TST-BRAIN-257 | PENDING | test_mcp_6_4_7_attribution_preserved_in_response | brain/tests/test_mcp.py |
| 424 | TAGGED | TST-BRAIN-258 | PENDING | test_mcp_6_4_8_bot_response_without_attribution | brain/tests/test_mcp.py |
| 425 | TAGGED | TST-BRAIN-408 | PENDING | test_mcp_6_1_6_trust_scores_appview_query | brain/tests/test_mcp.py |
| 426 | TAGGED | TST-BRAIN-409 | PENDING | test_mcp_6_1_7_trust_scores_appview_fallback | brain/tests/test_mcp.py |
| 427 | TAGGED | TST-BRAIN-410 | PENDING | test_mcp_6_1_8_bot_trust_scores_tracking | brain/tests/test_mcp.py |
| 428 | TAGGED | TST-BRAIN-395 | PENDING | test_mcp_6_2_17_bot_response_pii_validation | brain/tests/test_mcp.py |
| 429 | PENDING | -- | PENDING | test_normalize_strips_prefix | brain/tests/test_persona_registry.py |
| 430 | PENDING | -- | PENDING | test_load_from_core | brain/tests/test_persona_registry.py |
| 431 | PENDING | -- | PENDING | test_fallback_on_core_unreachable | brain/tests/test_persona_registry.py |
| 432 | PENDING | -- | PENDING | test_refresh_failure_keeps_cache | brain/tests/test_persona_registry.py |
| 433 | PENDING | -- | PENDING | test_all_names | brain/tests/test_persona_registry.py |
| 434 | PENDING | -- | PENDING | test_update_locked | brain/tests/test_persona_registry.py |
| 435 | PENDING | -- | PENDING | test_refresh | brain/tests/test_persona_registry.py |
| 436 | PENDING | -- | PENDING | test_explicit_hint_used | brain/tests/test_persona_registry.py |
| 437 | PENDING | -- | PENDING | test_invalid_hint_returns_none | brain/tests/test_persona_registry.py |
| 438 | PENDING | -- | PENDING | test_llm_selects_from_installed | brain/tests/test_persona_registry.py |
| 439 | PENDING | -- | PENDING | test_llm_invalid_persona_rejected | brain/tests/test_persona_registry.py |
| 440 | PENDING | -- | PENDING | test_returns_none_when_no_llm | brain/tests/test_persona_registry.py |
| 441 | PENDING | -- | PENDING | test_secondary_validated | brain/tests/test_persona_registry.py |
| 442 | PENDING | -- | PENDING | test_llm_failure_returns_none | brain/tests/test_persona_registry.py |
| 443 | TAGGED | TST-BRAIN-091 | PENDING | test_pii_3_1_1_person_name_detection | brain/tests/test_pii.py |
| 444 | TAGGED | TST-BRAIN-092 | PENDING | test_pii_3_1_2_organization_detection | brain/tests/test_pii.py |
| 445 | TAGGED | TST-BRAIN-093 | PENDING | test_pii_3_1_3_location_detection | brain/tests/test_pii.py |
| 446 | TAGGED | TST-BRAIN-094 | PENDING | test_pii_3_1_4_date_with_context | brain/tests/test_pii.py |
| 447 | TAGGED | TST-BRAIN-095 | PENDING | test_pii_3_1_5_multiple_entities | brain/tests/test_pii.py |
| 448 | TAGGED | TST-BRAIN-096 | PENDING | test_pii_3_1_6_no_entities | brain/tests/test_pii.py |
| 449 | TAGGED | TST-BRAIN-097 | PENDING | test_pii_3_1_7_ambiguous_entity | brain/tests/test_pii.py |
| 450 | TAGGED | TST-BRAIN-098 | PENDING | test_pii_3_1_8_entity_in_url | brain/tests/test_pii.py |
| 451 | TAGGED | TST-BRAIN-099 | PENDING | test_pii_3_1_9_non_english_text | brain/tests/test_pii.py |
| 452 | TAGGED | TST-BRAIN-100 | PENDING | test_pii_3_1_10_medical_terms | brain/tests/test_pii.py |
| 453 | TAGGED | TST-BRAIN-101 | PENDING | test_pii_3_1_11_multiple_same_type | brain/tests/test_pii.py |
| 454 | TAGGED | TST-BRAIN-102 | PENDING | test_pii_3_1_12_replacement_map_accumulates | brain/tests/test_pii.py |
| 455 | TAGGED | TST-BRAIN-103 | PENDING | test_pii_3_1_13_address_detection | brain/tests/test_pii.py |
| 456 | PENDING | -- | PENDING | test_pii_3_1_14_gliner_medical_condition | brain/tests/test_pii.py |
| 457 | PENDING | -- | PENDING | test_pii_3_1_15_gliner_medication | brain/tests/test_pii.py |
| 458 | PENDING | -- | PENDING | test_pii_3_1_16_gliner_mixed_medical_text | brain/tests/test_pii.py |
| 459 | PENDING | -- | PENDING | test_pii_3_1_17_gliner_scrub_medical | brain/tests/test_pii.py |
| 460 | TAGGED | TST-BRAIN-104 | PENDING | test_pii_3_2_1_email_plus_person | brain/tests/test_pii.py |
| 461 | TAGGED | TST-BRAIN-105 | PENDING | test_pii_3_2_2_phone_plus_location | brain/tests/test_pii.py |
| 462 | TAGGED | TST-BRAIN-106 | PENDING | test_pii_3_2_3_tier1_runs_first | brain/tests/test_pii.py |
| 463 | TAGGED | TST-BRAIN-107 | PENDING | test_pii_3_2_4_batch_performance | brain/tests/test_pii.py |
| 464 | TAGGED | TST-BRAIN-108 | PENDING | test_pii_3_2_5_full_pipeline_to_cloud | brain/tests/test_pii.py |
| 465 | TAGGED | TST-BRAIN-109 | PENDING | test_pii_3_2_6_circular_dependency_prevention | brain/tests/test_pii.py |
| 466 | TAGGED | TST-BRAIN-110 | PENDING | test_pii_3_3_1_create_entity_vault | brain/tests/test_pii.py |
| 467 | TAGGED | TST-BRAIN-111 | PENDING | test_pii_3_3_2_scrub_before_llm | brain/tests/test_pii.py |
| 468 | TAGGED | TST-BRAIN-112 | PENDING | test_pii_3_3_3_rehydrate_after_llm | brain/tests/test_pii.py |
| 469 | TAGGED | TST-BRAIN-818 | PENDING | test_f08_rehydrate_matches_bare_and_bracketed | brain/tests/test_pii.py |
| 470 | TAGGED | TST-BRAIN-113 | PENDING | test_pii_3_3_4_entity_vault_destroyed | brain/tests/test_pii.py |
| 471 | TAGGED | TST-BRAIN-114 | PENDING | test_pii_3_3_5_entity_vault_never_persisted | brain/tests/test_pii.py |
| 472 | TAGGED | TST-BRAIN-115 | PENDING | test_pii_3_3_6_entity_vault_never_logged | brain/tests/test_pii.py |
| 473 | TAGGED | TST-BRAIN-116 | PENDING | test_pii_3_3_7_entity_vault_not_in_main_vault | brain/tests/test_pii.py |
| 474 | TAGGED | TST-BRAIN-117 | PENDING | test_pii_3_3_8_nested_redaction_tokens | brain/tests/test_pii.py |
| 475 | TAGGED | TST-BRAIN-118 | PENDING | test_pii_3_3_9_entity_vault_local_llm_skipped | brain/tests/test_pii.py |
| 476 | TAGGED | TST-BRAIN-119 | PENDING | test_pii_3_3_10_scope_one_request | brain/tests/test_pii.py |
| 477 | TAGGED | TST-BRAIN-120 | PENDING | test_pii_3_3_11_cloud_sees_topics_not_identities | brain/tests/test_pii.py |
| 478 | TAGGED | TST-BRAIN-413 | PENDING | test_pii_3_2_7_include_content_pii_scrub | brain/tests/test_pii.py |
| 479 | TAGGED | TST-BRAIN-414 | PENDING | test_pii_3_2_8_circular_dependency_invariant | brain/tests/test_pii.py |
| 480 | TAGGED | TST-BRAIN-423 | PENDING | test_pii_3_3_12_scrub_and_call_integration | brain/tests/test_pii.py |
| 481 | TAGGED | TST-BRAIN-424 | PENDING | test_pii_3_4_1_india_aadhaar | brain/tests/test_pii.py |
| 482 | TAGGED | TST-BRAIN-425 | PENDING | test_pii_3_4_2_india_pan | brain/tests/test_pii.py |
| 483 | TAGGED | TST-BRAIN-426 | PENDING | test_pii_3_4_3_india_ifsc | brain/tests/test_pii.py |
| 484 | TAGGED | TST-BRAIN-427 | PENDING | test_pii_3_4_4_india_upi | brain/tests/test_pii.py |
| 485 | TAGGED | TST-BRAIN-428 | PENDING | test_pii_3_4_5_india_phone | brain/tests/test_pii.py |
| 486 | TAGGED | TST-BRAIN-429 | PENDING | test_pii_3_4_6_india_passport | brain/tests/test_pii.py |
| 487 | TAGGED | TST-BRAIN-430 | PENDING | test_pii_3_4_7_india_bank_account | brain/tests/test_pii.py |
| 488 | TAGGED | TST-BRAIN-431 | PENDING | test_pii_3_5_1_classifier_persona | brain/tests/test_pii.py |
| 489 | TAGGED | TST-BRAIN-432 | PENDING | test_pii_3_5_2_classifier_health | brain/tests/test_pii.py |
| 490 | TAGGED | TST-BRAIN-433 | PENDING | test_pii_3_5_3_classifier_financial | brain/tests/test_pii.py |
| 491 | TAGGED | TST-BRAIN-434 | PENDING | test_pii_3_5_4_classifier_social | brain/tests/test_pii.py |
| 492 | TAGGED | TST-BRAIN-435 | PENDING | test_pii_3_5_5_classifier_mixed | brain/tests/test_pii.py |
| 493 | TAGGED | TST-BRAIN-436 | PENDING | test_pii_3_6_1_safe_date | brain/tests/test_pii.py |
| 494 | TAGGED | TST-BRAIN-437 | PENDING | test_pii_3_6_2_safe_money | brain/tests/test_pii.py |
| 495 | TAGGED | TST-BRAIN-438 | PENDING | test_pii_3_6_3_safe_norp | brain/tests/test_pii.py |
| 496 | TAGGED | TST-BRAIN-439 | PENDING | test_pii_3_6_4_safe_time | brain/tests/test_pii.py |
| 497 | TAGGED | TST-BRAIN-440 | PENDING | test_pii_3_7_1_vault_general_patterns | brain/tests/test_pii.py |
| 498 | TAGGED | TST-BRAIN-441 | PENDING | test_pii_3_7_2_vault_sensitive_scrub | brain/tests/test_pii.py |
| 499 | TAGGED | TST-BRAIN-442 | PENDING | test_pii_3_7_3_vault_local_only | brain/tests/test_pii.py |
| 500 | TAGGED | TST-BRAIN-443 | PENDING | test_pii_3_7_4_rehydrate_hallucinated | brain/tests/test_pii.py |
| 501 | TAGGED | TST-BRAIN-444 | PENDING | test_pii_3_8_1_eu_steuer_id | brain/tests/test_pii.py |
| 502 | TAGGED | TST-BRAIN-445 | PENDING | test_pii_3_8_2_eu_personalausweis | brain/tests/test_pii.py |
| 503 | TAGGED | TST-BRAIN-446 | PENDING | test_pii_3_8_3_eu_french_nir | brain/tests/test_pii.py |
| 504 | TAGGED | TST-BRAIN-447 | PENDING | test_pii_3_8_4_eu_french_nif | brain/tests/test_pii.py |
| 505 | TAGGED | TST-BRAIN-448 | PENDING | test_pii_3_8_5_eu_dutch_bsn | brain/tests/test_pii.py |
| 506 | TAGGED | TST-BRAIN-449 | PENDING | test_pii_3_8_6_eu_swift_bic | brain/tests/test_pii.py |
| 507 | TAGGED | TST-BRAIN-450 | PENDING | test_pii_3_9_1_faker_natural_language | brain/tests/test_pii.py |
| 508 | TAGGED | TST-BRAIN-451 | PENDING | test_pii_3_9_2_faker_consistency | brain/tests/test_pii.py |
| 509 | TAGGED | TST-BRAIN-452 | PENDING | test_pii_3_9_3_faker_different | brain/tests/test_pii.py |
| 510 | TAGGED | TST-BRAIN-453 | PENDING | test_pii_3_9_4_faker_rehydrate_roundtrip | brain/tests/test_pii.py |
| 511 | TAGGED | TST-BRAIN-454 | PENDING | test_pii_3_9_5_opaque_tokens | brain/tests/test_pii.py |
| 512 | TAGGED | TST-BRAIN-455 | PENDING | test_pii_3_9_6_org_opaque_token | brain/tests/test_pii.py |
| 513 | TAGGED | TST-BRAIN-503 | PENDING | test_reader_pipeline_no_outbound_tools | brain/tests/test_pipeline_safety.py |
| 514 | TAGGED | TST-BRAIN-504 | PENDING | test_sender_receives_structured_not_raw | brain/tests/test_pipeline_safety.py |
| 515 | TAGGED | TST-BRAIN-505 | PENDING | test_disallowed_mcp_tool_rejected | brain/tests/test_pipeline_safety.py |
| 516 | TAGGED | TST-BRAIN-506 | PENDING | test_tier3_queued_not_interrupted | brain/tests/test_pipeline_safety.py |
| 517 | TAGGED | TST-BRAIN-507 | PENDING | test_briefing_deduplicates_repeated_items | brain/tests/test_pipeline_safety.py |
| 518 | TAGGED | TST-BRAIN-508 | PENDING | test_briefing_crash_regenerates_from_source | brain/tests/test_pipeline_safety.py |
| 519 | TAGGED | TST-BRAIN-509 | PENDING | test_openclaw_unavailable_maps_degraded | brain/tests/test_pipeline_safety.py |
| 520 | TAGGED | TST-BRAIN-510 | PENDING | test_telegram_auth_failure_maps_expired | brain/tests/test_pipeline_safety.py |
| 521 | TAGGED | TST-BRAIN-511 | PENDING | test_connector_recovery_clears_stale_error | brain/tests/test_pipeline_safety.py |
| 522 | TAGGED | TST-BRAIN-302 | PENDING | test_resilience_11_1_unhandled_exception | brain/tests/test_resilience.py |
| 523 | TAGGED | TST-BRAIN-303 | PENDING | test_resilience_11_2_memory_leak_detection | brain/tests/test_resilience.py |
| 524 | TAGGED | TST-BRAIN-304 | PENDING | test_resilience_11_3_graceful_shutdown | brain/tests/test_resilience.py |
| 525 | TAGGED | TST-BRAIN-305 | PENDING | test_resilience_11_4_startup_dependency_check | brain/tests/test_resilience.py |
| 526 | TAGGED | TST-BRAIN-306 | PENDING | test_resilience_11_5_spacy_model_missing | brain/tests/test_resilience.py |
| 527 | TAGGED | TST-BRAIN-307 | PENDING | test_resilience_11_6_concurrent_requests | brain/tests/test_resilience.py |
| 528 | TAGGED | TST-BRAIN-417 | PENDING | test_resilience_11_7_startup_waits_for_core | brain/tests/test_resilience.py |
| 529 | TAGGED | TST-BRAIN-415 | PENDING | test_resilience_11_8_sharing_policy_invalid_did | brain/tests/test_resilience.py |
| 530 | TAGGED | TST-BRAIN-464 | PENDING | test_resilience_11_9_error_hierarchy | brain/tests/test_resilience.py |
| 531 | TAGGED | TST-BRAIN-270 | PENDING | test_routing_8_1_1_route_to_local_llm | brain/tests/test_routing.py |
| 532 | TAGGED | TST-BRAIN-271 | PENDING | test_routing_8_1_2_route_to_mcp_agent | brain/tests/test_routing.py |
| 533 | TAGGED | TST-BRAIN-272 | PENDING | test_routing_8_1_3_route_unknown_task_fallback | brain/tests/test_routing.py |
| 534 | TAGGED | TST-BRAIN-273 | PENDING | test_routing_8_1_4_route_respects_persona_tier | brain/tests/test_routing.py |
| 535 | TAGGED | TST-BRAIN-274 | PENDING | test_routing_8_2_1_delegate_to_mcp_tool | brain/tests/test_routing.py |
| 536 | TAGGED | TST-BRAIN-275 | PENDING | test_routing_8_2_2_mcp_tool_not_found | brain/tests/test_routing.py |
| 537 | TAGGED | TST-BRAIN-276 | PENDING | test_routing_8_2_3_mcp_delegation_gatekeeper_check | brain/tests/test_routing.py |
| 538 | TAGGED | TST-BRAIN-278 | PENDING | test_routing_8_3_1_check_trusted_agent_trust_scores | brain/tests/test_routing.py |
| 539 | TAGGED | TST-BRAIN-279 | PENDING | test_routing_8_3_2_check_untrusted_agent_trust_scores | brain/tests/test_routing.py |
| 540 | TAGGED | TST-BRAIN-280 | PENDING | test_routing_8_3_3_unknown_agent_default_trust_scores | brain/tests/test_routing.py |
| 541 | TAGGED | TST-BRAIN-465 | PENDING | test_routing_8_1_5_complex_prefers_local | brain/tests/test_routing.py |
| 542 | TAGGED | TST-BRAIN-466 | PENDING | test_routing_8_1_6_fts_only_no_llm | brain/tests/test_routing.py |
| 543 | TAGGED | TST-BRAIN-308 | PENDING | test_scratchpad_12_1_1_checkpoint_after_step1 | brain/tests/test_scratchpad.py |
| 544 | TAGGED | TST-BRAIN-309 | PENDING | test_scratchpad_12_1_2_checkpoint_after_step2 | brain/tests/test_scratchpad.py |
| 545 | TAGGED | TST-BRAIN-310 | PENDING | test_scratchpad_12_1_3_checkpoint_overwrites_previous | brain/tests/test_scratchpad.py |
| 546 | TAGGED | TST-BRAIN-311 | PENDING | test_scratchpad_12_1_4_checkpoint_includes_all_prior_context | brain/tests/test_scratchpad.py |
| 547 | TAGGED | TST-BRAIN-312 | PENDING | test_scratchpad_12_2_1_resume_from_step3 | brain/tests/test_scratchpad.py |
| 548 | TAGGED | TST-BRAIN-313 | PENDING | test_scratchpad_12_2_2_no_scratchpad_fresh_start | brain/tests/test_scratchpad.py |
| 549 | TAGGED | TST-BRAIN-314 | PENDING | test_scratchpad_12_2_3_stale_checkpoint_expired | brain/tests/test_scratchpad.py |
| 550 | TAGGED | TST-BRAIN-315 | PENDING | test_scratchpad_12_2_4_resume_uses_accumulated_context | brain/tests/test_scratchpad.py |
| 551 | TAGGED | TST-BRAIN-316 | PENDING | test_scratchpad_12_2_5_multiple_tasks_resume_independently | brain/tests/test_scratchpad.py |
| 552 | TAGGED | TST-BRAIN-317 | PENDING | test_scratchpad_12_3_1_deleted_on_completion | brain/tests/test_scratchpad.py |
| 553 | TAGGED | TST-BRAIN-318 | PENDING | test_scratchpad_12_3_2_auto_expires_24h | brain/tests/test_scratchpad.py |
| 554 | TAGGED | TST-BRAIN-319 | PENDING | test_scratchpad_12_3_3_large_checkpoint | brain/tests/test_scratchpad.py |
| 555 | TAGGED | TST-BRAIN-334 | PENDING | test_silence_15_1_borderline_fiduciary_solicited | brain/tests/test_silence.py |
| 556 | TAGGED | TST-BRAIN-335 | PENDING | test_silence_15_2_borderline_solicited_engagement | brain/tests/test_silence.py |
| 557 | TAGGED | TST-BRAIN-336 | PENDING | test_silence_15_3_escalation_engagement_to_fiduciary | brain/tests/test_silence.py |
| 558 | TAGGED | TST-BRAIN-337 | PENDING | test_silence_15_4_context_dependent_time_of_day | brain/tests/test_silence.py |
| 559 | TAGGED | TST-BRAIN-338 | PENDING | test_silence_15_5_repeated_similar_events_batched | brain/tests/test_silence.py |
| 560 | TAGGED | TST-BRAIN-339 | PENDING | test_silence_15_6_user_preference_override | brain/tests/test_silence.py |
| 561 | TAGGED | TST-BRAIN-340 | PENDING | test_anti_her_16_1_emotional_support_nudge_to_humans | brain/tests/test_silence.py |
| 562 | TAGGED | TST-BRAIN-341 | PENDING | test_anti_her_16_2_companion_treatment_redirects | brain/tests/test_silence.py |
| 563 | TAGGED | TST-BRAIN-342 | PENDING | test_anti_her_16_3_simulated_intimacy_factual_response | brain/tests/test_silence.py |
| 564 | TAGGED | TST-BRAIN-343 | PENDING | test_anti_her_16_4_loneliness_detection_suggest_friends | brain/tests/test_silence.py |
| 565 | TAGGED | TST-BRAIN-344 | PENDING | test_anti_her_16_5_dina_never_initiates_emotional_content | brain/tests/test_silence.py |
| 566 | TAGGED | TST-BRAIN-530 | PENDING | test_silence_18_1_stale_fiduciary_demoted | brain/tests/test_silence.py |
| 567 | TAGGED | TST-BRAIN-532 | PENDING | test_silence_18_1_conflicting_urgent_keyword_promo_source | brain/tests/test_silence.py |
| 568 | TAGGED | TST-BRAIN-537 | PENDING | test_silence_18_2_notification_storm_throttled | brain/tests/test_silence.py |
| 569 | TAGGED | TST-BRAIN-526 | PENDING | test_silence_17_3_no_anthropomorphic_language | brain/tests/test_silence.py |
| 570 | TAGGED | TST-BRAIN-536 | PENDING | test_silence_18_2_mixed_batch_only_fiduciary_interrupts | brain/tests/test_silence.py |
| 571 | TAGGED | TST-BRAIN-540 | PENDING | test_silence_18_3_empty_briefing_no_noise | brain/tests/test_silence.py |
| 572 | TAGGED | TST-BRAIN-528 | PENDING | test_silence_18_1_ambiguous_urgency_untrusted_sender | brain/tests/test_silence.py |
| 573 | TAGGED | TST-BRAIN-534 | PENDING | test_silence_18_2_hundred_engagement_events_zero_push | brain/tests/test_silence.py |
| 574 | TAGGED | TST-BRAIN-529 | PENDING | test_silence_18_1_same_content_different_sender_trust | brain/tests/test_silence.py |
| 575 | PENDING | -- | PENDING | test_silence_18_2_briefing_over_50_items_grouped | brain/tests/test_silence.py |
| 576 | TAGGED | TST-BRAIN-515 | PENDING | test_human_connection_17_1_recent_interaction_resets_neglect | brain/tests/test_silence.py |
| 577 | PENDING | -- | PENDING | test_silence_18_1_priority_promotion_accumulation | brain/tests/test_silence.py |
| 578 | TAGGED | TST-BRAIN-525 | PENDING | test_silence_17_3_task_completion_conversation_end | brain/tests/test_silence.py |
| 579 | TAGGED | TST-BRAIN-533 | PENDING | test_silence_18_1_health_context_elevates_priority | brain/tests/test_silence.py |
| 580 | TAGGED | TST-BRAIN-527 | PENDING | test_silence_17_3_voice_tone_never_mimics_intimacy | brain/tests/test_silence.py |
| 581 | TAGGED | TST-BRAIN-524 | PENDING | test_silence_17_3_no_memory_of_emotional_moments | brain/tests/test_silence.py |
| 582 | TAGGED | TST-BRAIN-523 | PENDING | test_silence_17_3_no_open_ended_emotional_followups | brain/tests/test_silence.py |
| 583 | TAGGED | REL-022 | PENDING | test_tst_brain_570_reclassification_on_corroboration | brain/tests/test_silence.py |
| 584 | TAGGED | TST-BRAIN-518 | PENDING | test_tst_brain_518_promise_follow_up_nudge | brain/tests/test_silence.py |
| 585 | PENDING | -- | PENDING | test_human_connection_17_1_nudge_frequency_capping | brain/tests/test_silence.py |
| 586 | PENDING | -- | PENDING | test_tst_brain_519_cross_session_dependency_pattern | brain/tests/test_silence.py |
| 587 | PENDING | -- | PENDING | test_emotional_dependency_17_2_late_night_pattern | brain/tests/test_silence.py |
| 588 | TAGGED | TST-BRAIN-512 | PENDING | test_human_connection_17_1_neglected_contact_birthday | brain/tests/test_silence.py |
| 589 | PENDING | -- | PENDING | test_emotional_dependency_17_2_social_isolation_signal | brain/tests/test_silence.py |
| 590 | PENDING | -- | PENDING | test_tst_brain_522_recovery_acknowledgment | brain/tests/test_silence.py |
| 591 | PENDING | -- | PENDING | test_emotional_dependency_17_2_no_suitable_human_contact | brain/tests/test_silence.py |
| 592 | TAGGED | TST-BRAIN-512 | PENDING | test_tst_brain_512_neglected_contact_nudge | brain/tests/test_silence.py |
| 593 | PENDING | -- | PENDING | test_tst_brain_514_multiple_neglected_contacts_prioritized | brain/tests/test_silence.py |
| 594 | PENDING | -- | PENDING | test_tst_brain_517_life_event_proactive_outreach | brain/tests/test_silence.py |
| 595 | PENDING | -- | PENDING | test_process_pending_claims_and_classifies | brain/tests/test_staging_processor.py |
| 596 | PENDING | -- | PENDING | test_process_pending_enriches_before_resolve | brain/tests/test_staging_processor.py |
| 597 | PENDING | -- | PENDING | test_enriched_item_has_ready_status | brain/tests/test_staging_processor.py |
| 598 | PENDING | -- | PENDING | test_classification_highest_sensitivity_wins | brain/tests/test_staging_processor.py |
| 599 | PENDING | -- | PENDING | test_trust_scoring_applied | brain/tests/test_staging_processor.py |
| 600 | PENDING | -- | PENDING | test_contact_did_propagated_via_explicit_did | brain/tests/test_staging_processor.py |
| 601 | PENDING | -- | PENDING | test_contact_did_resolved_from_sender_via_alias | brain/tests/test_staging_processor.py |
| 602 | PENDING | -- | PENDING | test_no_contact_did_when_unknown_sender | brain/tests/test_staging_processor.py |
| 603 | PENDING | -- | PENDING | test_resolve_includes_lineage | brain/tests/test_staging_processor.py |
| 604 | TAGGED | TST-BRAIN-823 | PENDING | test_enrichment_failure_calls_staging_fail | brain/tests/test_staging_processor.py |
| 605 | PENDING | -- | PENDING | test_enrichment_failure_does_not_extract_events | brain/tests/test_staging_processor.py |
| 606 | PENDING | -- | PENDING | test_multi_persona_enriches_once | brain/tests/test_staging_processor.py |
| 607 | PENDING | -- | PENDING | test_classification_failure_calls_fail | brain/tests/test_staging_processor.py |
| 608 | PENDING | -- | PENDING | test_approval_required_does_not_call_staging_fail | brain/tests/test_staging_processor.py |
| 609 | PENDING | -- | PENDING | test_no_pending_items_noop | brain/tests/test_staging_processor.py |
| 610 | PENDING | -- | PENDING | test_claim_failure_returns_zero | brain/tests/test_staging_processor.py |
| 611 | PENDING | -- | PENDING | test_finance_type_classifies_to_financial | brain/tests/test_staging_processor.py |
| 612 | PENDING | -- | PENDING | test_pending_unlock_skips_event_extraction | brain/tests/test_staging_processor.py |
| 613 | PENDING | -- | PENDING | test_stored_triggers_event_extraction | brain/tests/test_staging_processor.py |
| 614 | TAGGED | TST-BRAIN-808 | PENDING | test_timestamp_preserved_from_metadata | brain/tests/test_staging_processor.py |
| 615 | TAGGED | TST-BRAIN-809 | PENDING | test_no_timestamp_in_metadata_omits_field | brain/tests/test_staging_processor.py |
| 616 | TAGGED | TST-BRAIN-810 | PENDING | test_d2d_origin_did_sets_contact_did | brain/tests/test_staging_processor.py |
| 617 | TAGGED | TST-BRAIN-811 | PENDING | test_d2d_unknown_sender_gets_unknown_trust | brain/tests/test_staging_processor.py |
| 618 | TAGGED | TST-BRAIN-812 | PENDING | test_d2d_valid_vault_type_resolves | brain/tests/test_staging_processor.py |
| 619 | TAGGED | TST-BRAIN-140 | PENDING | test_sync_5_1_1_schedule_connector | brain/tests/test_sync.py |
| 620 | TAGGED | TST-BRAIN-141 | PENDING | test_sync_5_1_2_multiple_connectors_independent | brain/tests/test_sync.py |
| 621 | TAGGED | TST-BRAIN-142 | PENDING | test_sync_5_1_3_connector_failure_backoff | brain/tests/test_sync.py |
| 622 | TAGGED | TST-BRAIN-143 | PENDING | test_sync_5_1_4_manual_trigger | brain/tests/test_sync.py |
| 623 | TAGGED | TST-BRAIN-144 | PENDING | test_sync_5_1_5_overlapping_runs_skipped | brain/tests/test_sync.py |
| 624 | TAGGED | TST-BRAIN-145 | PENDING | test_sync_5_1_6_morning_routine | brain/tests/test_sync.py |
| 625 | TAGGED | TST-BRAIN-146 | PENDING | test_sync_5_1_7_hourly_check | brain/tests/test_sync.py |
| 626 | TAGGED | TST-BRAIN-147 | PENDING | test_sync_5_1_8_on_demand_sync | brain/tests/test_sync.py |
| 627 | TAGGED | TST-BRAIN-148 | PENDING | test_sync_5_1_9_cursor_preserved_across_restarts | brain/tests/test_sync.py |
| 628 | TAGGED | TST-BRAIN-149 | PENDING | test_sync_5_1_10_cursor_update_after_sync | brain/tests/test_sync.py |
| 629 | TAGGED | TST-BRAIN-150 | PENDING | test_sync_5_1_11_calendar_sync_frequency | brain/tests/test_sync.py |
| 630 | TAGGED | TST-BRAIN-151 | PENDING | test_sync_5_1_12_contacts_sync_daily | brain/tests/test_sync.py |
| 631 | TAGGED | TST-BRAIN-152 | PENDING | test_sync_5_1_13_calendar_cursor_separate_key | brain/tests/test_sync.py |
| 632 | TAGGED | TST-BRAIN-153 | PENDING | test_sync_5_1_14_morning_routine_full_sequence | brain/tests/test_sync.py |
| 633 | TAGGED | TST-BRAIN-154 | PENDING | test_sync_5_1_15_calendar_rolling_window | brain/tests/test_sync.py |
| 634 | TAGGED | TST-BRAIN-155 | PENDING | test_sync_5_1_16_calendar_read_write_split | brain/tests/test_sync.py |
| 635 | TAGGED | TST-BRAIN-156 | PENDING | test_sync_5_2_1_pass1_metadata_fetch | brain/tests/test_sync.py |
| 636 | TAGGED | TST-BRAIN-157 | PENDING | test_sync_5_2_2_pass1_gmail_category_filter | brain/tests/test_sync.py |
| 637 | TAGGED | TST-BRAIN-158 | PENDING | test_sync_5_2_3_pass1_primary_proceeds | brain/tests/test_sync.py |
| 638 | TAGGED | TST-BRAIN-159 | PENDING | test_sync_5_2_4_pass2a_regex_sender_filter | brain/tests/test_sync.py |
| 639 | TAGGED | TST-BRAIN-160 | PENDING | test_sync_5_2_5_pass2a_subject_regex_filter | brain/tests/test_sync.py |
| 640 | TAGGED | TST-BRAIN-161 | PENDING | test_sync_5_2_6_pass2b_llm_batch_classification | brain/tests/test_sync.py |
| 641 | TAGGED | TST-BRAIN-162 | PENDING | test_sync_5_2_7_pass2b_ingest_classification | brain/tests/test_sync.py |
| 642 | TAGGED | TST-BRAIN-163 | PENDING | test_sync_5_2_8_pass2b_skip_classification | brain/tests/test_sync.py |
| 643 | TAGGED | TST-BRAIN-164 | PENDING | test_sync_5_2_9_full_download_ingest_only | brain/tests/test_sync.py |
| 644 | TAGGED | TST-BRAIN-165 | PENDING | test_sync_5_2_10_thin_records_for_all_skipped | brain/tests/test_sync.py |
| 645 | TAGGED | TST-BRAIN-166 | PENDING | test_sync_5_2_11_thin_records_not_embedded | brain/tests/test_sync.py |
| 646 | TAGGED | TST-BRAIN-167 | PENDING | test_sync_5_2_12_on_demand_fetch_skipped | brain/tests/test_sync.py |
| 647 | TAGGED | TST-BRAIN-168 | PENDING | test_sync_5_2_13_pii_scrub_before_cloud_llm | brain/tests/test_sync.py |
| 648 | TAGGED | TST-BRAIN-169 | PENDING | test_sync_5_2_14_end_to_end_5000_emails | brain/tests/test_sync.py |
| 649 | TAGGED | TST-BRAIN-170 | PENDING | test_sync_5_2_15_fiduciary_override_security_alert | brain/tests/test_sync.py |
| 650 | TAGGED | TST-BRAIN-171 | PENDING | test_sync_5_2_16_fiduciary_override_financial | brain/tests/test_sync.py |
| 651 | TAGGED | TST-BRAIN-172 | PENDING | test_sync_5_2_17_always_ingest_sender_exception | brain/tests/test_sync.py |
| 652 | TAGGED | TST-BRAIN-173 | PENDING | test_sync_5_2_18_dina_triage_off | brain/tests/test_sync.py |
| 653 | TAGGED | TST-BRAIN-174 | PENDING | test_sync_5_2_19_llm_triage_cost_tracking | brain/tests/test_sync.py |
| 654 | TAGGED | TST-BRAIN-175 | PENDING | test_sync_5_2_20_llm_triage_sees_only_subject_sender | brain/tests/test_sync.py |
| 655 | TAGGED | TST-BRAIN-176 | PENDING | test_sync_5_2_21_llm_triage_prompt_audit | brain/tests/test_sync.py |
| 656 | TAGGED | TST-BRAIN-177 | PENDING | test_sync_5_2_22_thin_record_skip_reason_differentiates | brain/tests/test_sync.py |
| 657 | TAGGED | TST-BRAIN-178 | PENDING | test_sync_5_2_23_fiduciary_override_account_expiration | brain/tests/test_sync.py |
| 658 | TAGGED | TST-BRAIN-179 | PENDING | test_sync_5_2_24_llm_triage_batch_size_max_50 | brain/tests/test_sync.py |
| 659 | TAGGED | TST-BRAIN-180 | PENDING | test_sync_5_2_25_normalizer_standard_schema | brain/tests/test_sync.py |
| 660 | TAGGED | TST-BRAIN-181 | PENDING | test_sync_5_2_26_persona_routing_configurable | brain/tests/test_sync.py |
| 661 | TAGGED | TST-BRAIN-182 | PENDING | test_sync_5_3_1_exact_duplicate_gmail_id_upsert | brain/tests/test_sync.py |
| 662 | TAGGED | TST-BRAIN-183 | PENDING | test_sync_5_3_2_near_duplicate_normalized_hash | brain/tests/test_sync.py |
| 663 | TAGGED | TST-BRAIN-184 | PENDING | test_sync_5_3_3_legitimate_repeat_stored | brain/tests/test_sync.py |
| 664 | TAGGED | TST-BRAIN-185 | PENDING | test_sync_5_3_4_cross_source_duplicate_merged | brain/tests/test_sync.py |
| 665 | TAGGED | TST-BRAIN-186 | PENDING | test_sync_5_4_1_batch_request_100_items | brain/tests/test_sync.py |
| 666 | TAGGED | TST-BRAIN-187 | PENDING | test_sync_5_4_2_batch_size_cap_100 | brain/tests/test_sync.py |
| 667 | TAGGED | TST-BRAIN-188 | PENDING | test_sync_5_4_3_batch_mixed_types | brain/tests/test_sync.py |
| 668 | TAGGED | TST-BRAIN-189 | PENDING | test_sync_5_4_4_batch_failure_retry | brain/tests/test_sync.py |
| 669 | TAGGED | TST-BRAIN-190 | PENDING | test_sync_5_4_5_batch_partial_retry_not_needed | brain/tests/test_sync.py |
| 670 | TAGGED | TST-BRAIN-191 | PENDING | test_sync_5_4_6_background_embedding_after_batch | brain/tests/test_sync.py |
| 671 | TAGGED | TST-BRAIN-192 | PENDING | test_sync_5_4_7_batch_progress_tracking | brain/tests/test_sync.py |
| 672 | TAGGED | TST-BRAIN-193 | PENDING | test_sync_5_5_1_healthy_normal_sync | brain/tests/test_sync.py |
| 673 | TAGGED | TST-BRAIN-194 | PENDING | test_sync_5_5_2_healthy_to_degraded | brain/tests/test_sync.py |
| 674 | TAGGED | TST-BRAIN-195 | PENDING | test_sync_5_5_3_degraded_to_offline | brain/tests/test_sync.py |
| 675 | TAGGED | TST-BRAIN-196 | PENDING | test_sync_5_5_4_offline_to_healthy | brain/tests/test_sync.py |
| 676 | TAGGED | TST-BRAIN-197 | PENDING | test_sync_5_5_5_cursors_preserved_during_outage | brain/tests/test_sync.py |
| 677 | TAGGED | TST-BRAIN-198 | PENDING | test_sync_5_5_6_degradation_is_tier2 | brain/tests/test_sync.py |
| 678 | TAGGED | TST-BRAIN-199 | PENDING | test_sync_5_5_7_sync_status_in_admin_ui | brain/tests/test_sync.py |
| 679 | TAGGED | TST-BRAIN-200 | PENDING | test_sync_5_5_8_degraded_to_healthy_direct | brain/tests/test_sync.py |
| 680 | TAGGED | TST-BRAIN-201 | PENDING | test_sync_5_5_9_consecutive_failure_counter_resets | brain/tests/test_sync.py |
| 681 | TAGGED | TST-BRAIN-202 | PENDING | test_sync_5_6_1_attachment_metadata_only | brain/tests/test_sync.py |
| 682 | TAGGED | TST-BRAIN-203 | PENDING | test_sync_5_6_2_attachment_summary | brain/tests/test_sync.py |
| 683 | TAGGED | TST-BRAIN-204 | PENDING | test_sync_5_6_3_deep_link_to_source | brain/tests/test_sync.py |
| 684 | TAGGED | TST-BRAIN-205 | PENDING | test_sync_5_6_4_dead_reference_accepted | brain/tests/test_sync.py |
| 685 | TAGGED | TST-BRAIN-206 | PENDING | test_sync_5_6_5_voice_memo_exception | brain/tests/test_sync.py |
| 686 | TAGGED | TST-BRAIN-207 | PENDING | test_sync_5_6_6_media_directory_on_disk | brain/tests/test_sync.py |
| 687 | TAGGED | TST-BRAIN-208 | PENDING | test_sync_5_6_7_vault_size_stays_portable | brain/tests/test_sync.py |
| 688 | TAGGED | TST-BRAIN-209 | PENDING | test_sync_5_6_8_media_directory_encrypted_at_rest | brain/tests/test_sync.py |
| 689 | TAGGED | TST-BRAIN-210 | PENDING | test_sync_5_6_9_attachment_reference_uri_format | brain/tests/test_sync.py |
| 690 | TAGGED | TST-BRAIN-211 | PENDING | test_sync_5_6_10_dead_reference_graceful_handling | brain/tests/test_sync.py |
| 691 | TAGGED | TST-BRAIN-212 | PENDING | test_sync_5_7_1_default_history_horizon | brain/tests/test_sync.py |
| 692 | TAGGED | TST-BRAIN-213 | PENDING | test_sync_5_7_2_custom_history_horizon | brain/tests/test_sync.py |
| 693 | TAGGED | TST-BRAIN-214 | PENDING | test_sync_5_7_3_extended_history_horizon | brain/tests/test_sync.py |
| 694 | TAGGED | TST-BRAIN-215 | PENDING | test_sync_5_7_4_data_beyond_horizon_never_downloaded | brain/tests/test_sync.py |
| 695 | TAGGED | TST-BRAIN-216 | PENDING | test_sync_5_7_5_zone1_data_vectorized_fts | brain/tests/test_sync.py |
| 696 | TAGGED | TST-BRAIN-217 | PENDING | test_sync_5_7_6_zone2_data_not_in_vault | brain/tests/test_sync.py |
| 697 | TAGGED | TST-BRAIN-218 | PENDING | test_sync_5_7_7_startup_fast_sync_30_days | brain/tests/test_sync.py |
| 698 | TAGGED | TST-BRAIN-219 | PENDING | test_sync_5_7_8_startup_backfill_remaining | brain/tests/test_sync.py |
| 699 | TAGGED | TST-BRAIN-220 | PENDING | test_sync_5_7_9_user_queries_preempt_backfill | brain/tests/test_sync.py |
| 700 | TAGGED | TST-BRAIN-221 | PENDING | test_sync_5_8_1_hot_memory_search_first | brain/tests/test_sync.py |
| 701 | TAGGED | TST-BRAIN-222 | PENDING | test_sync_5_8_2_cold_fallback_not_found | brain/tests/test_sync.py |
| 702 | TAGGED | TST-BRAIN-223 | PENDING | test_sync_5_8_3_cold_results_not_saved | brain/tests/test_sync.py |
| 703 | TAGGED | TST-BRAIN-224 | PENDING | test_sync_5_8_4_privacy_disclosure | brain/tests/test_sync.py |
| 704 | TAGGED | TST-BRAIN-225 | PENDING | test_sync_5_8_5_explicit_old_date_triggers_cold | brain/tests/test_sync.py |
| 705 | TAGGED | TST-BRAIN-405 | PENDING | test_sync_5_2_27_llm_triage_timeout_fallback | brain/tests/test_sync.py |
| 706 | TAGGED | TST-BRAIN-406 | PENDING | test_sync_5_2_28_llm_triage_timeout_admin_status | brain/tests/test_sync.py |
| 707 | PENDING | -- | PENDING | test_sync_trust_scorer_assigns_provenance | brain/tests/test_sync.py |
| 708 | PENDING | -- | PENDING | test_sync_without_trust_scorer_no_provenance | brain/tests/test_sync.py |
| 709 | PENDING | -- | PENDING | test_sync_ingest_single_item_gets_provenance | brain/tests/test_sync.py |
| 710 | PENDING | -- | PENDING | test_sync_contradiction_detection | brain/tests/test_sync.py |
| 711 | PENDING | -- | PENDING | test_brain_startup_wires_trust_scorer | brain/tests/test_sync.py |
| 712 | PENDING | -- | PENDING | test_start_allowed_user_gets_paired | brain/tests/test_telegram.py |
| 713 | PENDING | -- | PENDING | test_start_unknown_user_rejected | brain/tests/test_telegram.py |
| 714 | PENDING | -- | PENDING | test_start_already_paired_user | brain/tests/test_telegram.py |
| 715 | PENDING | -- | PENDING | test_ask_from_allowed_user_calls_guardian | brain/tests/test_telegram.py |
| 716 | PENDING | -- | PENDING | test_ask_from_unknown_user_rejected | brain/tests/test_telegram.py |
| 717 | PENDING | -- | PENDING | test_ask_empty_text_shows_usage | brain/tests/test_telegram.py |
| 718 | PENDING | -- | PENDING | test_ask_auto_pairs_allowed_user | brain/tests/test_telegram.py |
| 719 | PENDING | -- | PENDING | test_ask_guardian_error_sends_friendly_reply | brain/tests/test_telegram.py |
| 720 | PENDING | -- | PENDING | test_ask_strips_command_prefix | brain/tests/test_telegram.py |
| 721 | PENDING | -- | PENDING | test_remember_ingests_to_staging | brain/tests/test_telegram.py |
| 722 | PENDING | -- | PENDING | test_remember_polls_staging_status | brain/tests/test_telegram.py |
| 723 | PENDING | -- | PENDING | test_remember_stored_reply | brain/tests/test_telegram.py |
| 724 | PENDING | -- | PENDING | test_remember_needs_approval_reply | brain/tests/test_telegram.py |
| 725 | PENDING | -- | PENDING | test_remember_empty_text_shows_usage | brain/tests/test_telegram.py |
| 726 | PENDING | -- | PENDING | test_remember_from_unknown_user_rejected | brain/tests/test_telegram.py |
| 727 | PENDING | -- | PENDING | test_remember_ingest_failure_sends_error_reply | brain/tests/test_telegram.py |
| 728 | PENDING | -- | PENDING | test_remember_auto_pairs_allowed_user | brain/tests/test_telegram.py |
| 729 | PENDING | -- | PENDING | test_dm_plain_message_shows_command_hints | brain/tests/test_telegram.py |
| 730 | PENDING | -- | PENDING | test_dm_plain_message_not_stored | brain/tests/test_telegram.py |
| 731 | PENDING | -- | PENDING | test_dm_from_unknown_user_rejected | brain/tests/test_telegram.py |
| 732 | PENDING | -- | PENDING | test_dm_auto_pairs_allowed_user | brain/tests/test_telegram.py |
| 733 | PENDING | -- | PENDING | test_group_message_with_mention_processed | brain/tests/test_telegram.py |
| 734 | PENDING | -- | PENDING | test_group_message_without_mention_ignored | brain/tests/test_telegram.py |
| 735 | PENDING | -- | PENDING | test_group_message_disallowed_group_ignored | brain/tests/test_telegram.py |
| 736 | PENDING | -- | PENDING | test_load_paired_users_from_kv | brain/tests/test_telegram.py |
| 737 | PENDING | -- | PENDING | test_load_paired_users_empty_kv | brain/tests/test_telegram.py |
| 738 | PENDING | -- | PENDING | test_load_paired_users_kv_error | brain/tests/test_telegram.py |
| 739 | PENDING | -- | PENDING | test_send_nudge | brain/tests/test_telegram.py |
| 740 | TAGGED | TST-BRAIN-813 | PENDING | test_plain_dm_message_not_stored_via_staging | brain/tests/test_telegram.py |
| 741 | PENDING | -- | PENDING | test_config_telegram_fields | brain/tests/test_telegram.py |
| 742 | PENDING | -- | PENDING | test_config_no_telegram_token | brain/tests/test_telegram.py |
| 743 | PENDING | -- | PENDING | test_adapter_start_stop | brain/tests/test_telegram.py |
| 744 | PENDING | -- | PENDING | test_adapter_start_invalid_token_raises_telegram_error | brain/tests/test_telegram.py |
| 745 | PENDING | -- | PENDING | test_adapter_send_message_error_raises_telegram_error | brain/tests/test_telegram.py |
| 746 | PENDING | -- | PENDING | test_adapter_stop_error_handled_gracefully | brain/tests/test_telegram.py |
| 747 | PENDING | -- | PENDING | test_handle_message_no_effective_user | brain/tests/test_telegram.py |
| 748 | PENDING | -- | PENDING | test_handle_message_no_message_text | brain/tests/test_telegram.py |
| 749 | PENDING | -- | PENDING | test_handle_message_empty_message | brain/tests/test_telegram.py |
| 750 | PENDING | -- | PENDING | test_handle_start_no_effective_user | brain/tests/test_telegram.py |
| 751 | PENDING | -- | PENDING | test_handle_start_no_effective_chat | brain/tests/test_telegram.py |
| 752 | PENDING | -- | PENDING | test_ask_guardian_error_sends_error_reply | brain/tests/test_telegram.py |
| 753 | PENDING | -- | PENDING | test_ask_empty_response_not_sent | brain/tests/test_telegram.py |
| 754 | PENDING | -- | PENDING | test_ask_content_field_takes_precedence_over_response | brain/tests/test_telegram.py |
| 755 | PENDING | -- | PENDING | test_ask_response_field_fallback | brain/tests/test_telegram.py |
| 756 | PENDING | -- | PENDING | test_ask_dict_response_extracted | brain/tests/test_telegram.py |
| 757 | PENDING | -- | PENDING | test_vault_store_failure_does_not_crash | brain/tests/test_telegram.py |
| 758 | PENDING | -- | PENDING | test_pair_kv_failure_still_pairs_in_memory | brain/tests/test_telegram.py |
| 759 | PENDING | -- | PENDING | test_send_nudge_no_bot_set | brain/tests/test_telegram.py |
| 760 | PENDING | -- | PENDING | test_multiple_users_pair_independently | brain/tests/test_telegram.py |
| 761 | PENDING | -- | PENDING | test_supergroup_message_with_mention | brain/tests/test_telegram.py |
| 762 | PENDING | -- | PENDING | test_adapter_satisfies_port_protocol | brain/tests/test_telegram.py |
| 763 | PENDING | -- | PENDING | test_config_allowed_users_with_spaces | brain/tests/test_telegram.py |
| 764 | PENDING | -- | PENDING | test_config_allowed_users_with_invalid_entries | brain/tests/test_telegram.py |
| 765 | PENDING | -- | PENDING | test_send_approval_prompt_sends_to_all_paired | brain/tests/test_telegram.py |
| 766 | PENDING | -- | PENDING | test_send_approval_prompt_includes_inline_keyboard | brain/tests/test_telegram.py |
| 767 | PENDING | -- | PENDING | test_send_approval_prompt_escapes_markdown | brain/tests/test_telegram.py |
| 768 | PENDING | -- | PENDING | test_send_approval_prompt_no_bot | brain/tests/test_telegram.py |
| 769 | PENDING | -- | PENDING | test_send_approval_prompt_no_paired_users | brain/tests/test_telegram.py |
| 770 | PENDING | -- | PENDING | test_send_approval_prompt_skips_empty_approval | brain/tests/test_telegram.py |
| 771 | PENDING | -- | PENDING | test_send_approval_prompt_send_failure_logged | brain/tests/test_telegram.py |
| 772 | PENDING | -- | PENDING | test_send_approval_prompt_lazy_loads_paired_users | brain/tests/test_telegram.py |
| 773 | PENDING | -- | PENDING | test_handle_approval_response_approve | brain/tests/test_telegram.py |
| 774 | PENDING | -- | PENDING | test_handle_approval_response_deny | brain/tests/test_telegram.py |
| 775 | PENDING | -- | PENDING | test_handle_approval_response_approve_failure | brain/tests/test_telegram.py |
| 776 | PENDING | -- | PENDING | test_handle_approval_response_not_a_command | brain/tests/test_telegram.py |
| 777 | PENDING | -- | PENDING | test_handle_approval_response_case_insensitive | brain/tests/test_telegram.py |
| 778 | PENDING | -- | PENDING | test_handle_approval_response_approve_single | brain/tests/test_telegram.py |
| 779 | PENDING | -- | PENDING | test_handle_approval_response_approve_single_failure | brain/tests/test_telegram.py |
| 780 | PENDING | -- | PENDING | test_approval_prompt_shows_three_button_options | brain/tests/test_telegram.py |
| 781 | PENDING | -- | PENDING | test_handle_callback_query_approve | brain/tests/test_telegram.py |
| 782 | PENDING | -- | PENDING | test_handle_callback_query_deny | brain/tests/test_telegram.py |
| 783 | PENDING | -- | PENDING | test_handle_callback_query_approve_single | brain/tests/test_telegram.py |
| 784 | PENDING | -- | PENDING | test_handle_callback_query_no_query | brain/tests/test_telegram.py |
| 785 | PENDING | -- | PENDING | test_handle_callback_query_no_data | brain/tests/test_telegram.py |
| 786 | PENDING | -- | PENDING | test_handle_callback_query_edit_failure_propagates | brain/tests/test_telegram.py |
| 787 | PENDING | -- | PENDING | test_tier1_types_classified_correctly | brain/tests/test_tier_classifier.py |
| 788 | PENDING | -- | PENDING | test_tier2_types_classified_correctly | brain/tests/test_tier_classifier.py |
| 789 | PENDING | -- | PENDING | test_unknown_type_defaults_to_tier2 | brain/tests/test_tier_classifier.py |
| 790 | PENDING | -- | PENDING | test_missing_type_defaults_to_tier2 | brain/tests/test_tier_classifier.py |
| 791 | PENDING | -- | PENDING | test_empty_type_defaults_to_tier2 | brain/tests/test_tier_classifier.py |
| 792 | PENDING | -- | PENDING | test_tier1_and_tier2_are_disjoint | brain/tests/test_tier_classifier.py |
| 793 | PENDING | -- | PENDING | test_all_known_vault_types_classified | brain/tests/test_tier_classifier.py |
| 794 | PENDING | -- | PENDING | test_user_content_self_high_normal | brain/tests/test_trust_scorer.py |
| 795 | PENDING | -- | PENDING | test_cli_source_is_self | brain/tests/test_trust_scorer.py |
| 796 | PENDING | -- | PENDING | test_known_contact_trusted_ring1 | brain/tests/test_trust_scorer.py |
| 797 | PENDING | -- | PENDING | test_known_contact_unknown_trust_ring2 | brain/tests/test_trust_scorer.py |
| 798 | PENDING | -- | PENDING | test_verified_service_domain | brain/tests/test_trust_scorer.py |
| 799 | PENDING | -- | PENDING | test_unknown_sender_caveated | brain/tests/test_trust_scorer.py |
| 800 | PENDING | -- | PENDING | test_marketing_sender_briefing_only | brain/tests/test_trust_scorer.py |
| 801 | PENDING | -- | PENDING | test_missing_sender_on_service_item_caveated | brain/tests/test_trust_scorer.py |
| 802 | PENDING | -- | PENDING | test_telegram_source_is_self | brain/tests/test_trust_scorer.py |
| 803 | PENDING | -- | PENDING | test_subdomain_of_verified_service | brain/tests/test_trust_scorer.py |
| 804 | PENDING | -- | PENDING | test_update_contacts | brain/tests/test_trust_scorer.py |
| 805 | PENDING | -- | PENDING | test_sender_matches_contact_by_name_when_name_is_email | brain/tests/test_trust_scorer.py |
| 806 | PENDING | -- | PENDING | test_sender_matches_contact_by_alias | brain/tests/test_trust_scorer.py |
| 807 | PENDING | -- | PENDING | test_sender_no_match_when_name_differs_from_email | brain/tests/test_trust_scorer.py |
| 808 | PENDING | -- | PENDING | test_sender_matching_case_insensitive | brain/tests/test_trust_scorer.py |
| 809 | PENDING | -- | PENDING | test_sender_no_match_stays_unknown | brain/tests/test_trust_scorer.py |
| 810 | PENDING | -- | PENDING | test_contact_did_takes_priority_over_sender | brain/tests/test_trust_scorer.py |
| 811 | PENDING | -- | PENDING | test_cli_user_self_high_normal | brain/tests/test_trust_scorer.py |
| 812 | PENDING | -- | PENDING | test_cli_agent_unknown_medium_caveated | brain/tests/test_trust_scorer.py |
| 813 | PENDING | -- | PENDING | test_telegram_self_high_normal | brain/tests/test_trust_scorer.py |
| 814 | PENDING | -- | PENDING | test_admin_self_high_normal | brain/tests/test_trust_scorer.py |
| 815 | PENDING | -- | PENDING | test_connector_always_unknown_low_caveated | brain/tests/test_trust_scorer.py |
| 816 | PENDING | -- | PENDING | test_connector_with_verified_domain_still_caveated | brain/tests/test_trust_scorer.py |
| 817 | PENDING | -- | PENDING | test_connector_with_known_contact_still_caveated | brain/tests/test_trust_scorer.py |
| 818 | TAGGED | TST-BRAIN-820 | PENDING | test_d2d_known_trusted_contact | brain/tests/test_trust_scorer.py |
| 819 | TAGGED | TST-BRAIN-821 | PENDING | test_d2d_known_unknown_trust_contact | brain/tests/test_trust_scorer.py |
| 820 | TAGGED | TST-BRAIN-822 | PENDING | test_d2d_unknown_sender | brain/tests/test_trust_scorer.py |
| 821 | PENDING | -- | PENDING | test_ingress_channel_takes_precedence_over_source | brain/tests/test_trust_scorer.py |
| 822 | PENDING | -- | PENDING | test_no_ingress_channel_falls_to_source_matching | brain/tests/test_trust_scorer.py |
| 823 | PENDING | -- | PENDING | test_list_personas | brain/tests/test_vault_context.py |
| 824 | PENDING | -- | PENDING | test_list_personas_empty_vault | brain/tests/test_vault_context.py |
| 825 | PENDING | -- | PENDING | test_browse_vault_returns_items | brain/tests/test_vault_context.py |
| 826 | PENDING | -- | PENDING | test_browse_vault_locked_persona | brain/tests/test_vault_context.py |
| 827 | PENDING | -- | PENDING | test_browse_vault_missing_persona | brain/tests/test_vault_context.py |
| 828 | PENDING | -- | PENDING | test_search_vault_returns_items | brain/tests/test_vault_context.py |
| 829 | PENDING | -- | PENDING | test_search_vault_caps_results | brain/tests/test_vault_context.py |
| 830 | PENDING | -- | PENDING | test_search_vault_locked_persona | brain/tests/test_vault_context.py |
| 831 | PENDING | -- | PENDING | test_search_vault_missing_params | brain/tests/test_vault_context.py |
| 832 | PENDING | -- | PENDING | test_unknown_tool | brain/tests/test_vault_context.py |
| 833 | PENDING | -- | PENDING | test_list_personas_failure | brain/tests/test_vault_context.py |
| 834 | PENDING | -- | PENDING | test_was_enriched_tracking | brain/tests/test_vault_context.py |
| 835 | PENDING | -- | PENDING | test_tools_called_history | brain/tests/test_vault_context.py |
| 836 | PENDING | -- | PENDING | test_simple_response_no_tools | brain/tests/test_vault_context.py |
| 837 | PENDING | -- | PENDING | test_agentic_loop_list_then_search | brain/tests/test_vault_context.py |
| 838 | PENDING | -- | PENDING | test_parallel_tool_calls | brain/tests/test_vault_context.py |
| 839 | PENDING | -- | PENDING | test_max_turns_exceeded | brain/tests/test_vault_context.py |
| 840 | PENDING | -- | PENDING | test_tool_messages_sent_to_llm | brain/tests/test_vault_context.py |
| 841 | PENDING | -- | PENDING | test_tools_passed_to_llm | brain/tests/test_vault_context.py |
| 842 | PENDING | -- | PENDING | test_discovery_first_flow | brain/tests/test_vault_context.py |
| 843 | PENDING | -- | PENDING | test_llm_failure_propagates | brain/tests/test_vault_context.py |
| 844 | PENDING | -- | PENDING | test_enrich_returns_tuple | brain/tests/test_vault_context.py |
| 845 | PENDING | -- | PENDING | test_enrich_with_vault_data | brain/tests/test_vault_context.py |
| 846 | PENDING | -- | PENDING | test_enrich_no_tools_passthrough | brain/tests/test_vault_context.py |
| 847 | PENDING | -- | PENDING | test_reason_returns_full_result | brain/tests/test_vault_context.py |
| 848 | PENDING | -- | PENDING | test_vault_tools_defined | brain/tests/test_vault_context.py |
| 849 | PENDING | -- | PENDING | test_search_vault_has_required_params | brain/tests/test_vault_context.py |
| 850 | PENDING | -- | PENDING | test_gemini_tools_build | brain/tests/test_vault_context.py |
| 851 | PENDING | -- | PENDING | test_search_vault_passes_user_origin | brain/tests/test_vault_context.py |
| 852 | PENDING | -- | PENDING | test_get_full_content_passes_user_origin | brain/tests/test_vault_context.py |
| 853 | PENDING | -- | PENDING | test_list_personas_passes_user_origin | brain/tests/test_vault_context.py |
| 854 | PENDING | -- | PENDING | test_no_user_origin_sends_empty | brain/tests/test_vault_context.py |
| 855 | TAGGED | TST-BRAIN-400 | PENDING | test_voice_18_1_deepgram_to_guardian | brain/tests/test_voice.py |
| 856 | TAGGED | TST-BRAIN-401 | PENDING | test_voice_18_2_deepgram_fallback_gemini | brain/tests/test_voice.py |
| 857 | TAGGED | TST-BRAIN-402 | PENDING | test_voice_18_3_latency_target | brain/tests/test_voice.py |

## CLI (66/111 tagged -- 59%)

| # | Status | Current Tag | Name Status | Test Function | File |
|---|--------|------------|-------------|---------------|------|
| 1 | TAGGED | TST-CLI-015 | PENDING | test_vault_store | cli/tests/test_client.py |
| 2 | TAGGED | TST-CLI-016 | PENDING | test_vault_query | cli/tests/test_client.py |
| 3 | TAGGED | TST-CLI-017 | PENDING | test_kv_get_found | cli/tests/test_client.py |
| 4 | TAGGED | TST-CLI-018 | PENDING | test_kv_get_not_found | cli/tests/test_client.py |
| 5 | TAGGED | TST-CLI-019 | PENDING | test_connection_error | cli/tests/test_client.py |
| 6 | TAGGED | TST-CLI-020 | PENDING | test_auth_error | cli/tests/test_client.py |
| 7 | TAGGED | TST-CLI-021 | PENDING | test_process_event_via_core | cli/tests/test_client.py |
| 8 | TAGGED | TST-CLI-022 | PENDING | test_context_manager | cli/tests/test_client.py |
| 9 | TAGGED | TST-CLI-023 | PENDING | test_signing_headers_set | cli/tests/test_client.py |
| 10 | TAGGED | TST-CLI-024 | PENDING | test_no_bearer_on_core | cli/tests/test_client.py |
| 11 | TAGGED | TST-CLI-025 | PENDING | test_extract_body_json | cli/tests/test_client.py |
| 12 | TAGGED | TST-CLI-026 | PENDING | test_extract_body_content_string | cli/tests/test_client.py |
| 13 | TAGGED | TST-CLI-027 | PENDING | test_extract_body_empty | cli/tests/test_client.py |
| 14 | PENDING | -- | PENDING | test_status_paired_json | cli/tests/test_commands.py |
| 15 | PENDING | -- | PENDING | test_status_not_paired | cli/tests/test_commands.py |
| 16 | PENDING | -- | PENDING | test_status_unreachable | cli/tests/test_commands.py |
| 17 | TAGGED | TST-CLI-028 | PENDING | test_remember_json | cli/tests/test_commands.py |
| 18 | TAGGED | TST-CLI-029 | PENDING | test_remember_human | cli/tests/test_commands.py |
| 19 | TAGGED | TST-CLI-030 | PENDING | test_remember_with_category | cli/tests/test_commands.py |
| 20 | TAGGED | TST-CLI-031 | PENDING | test_ask_json | cli/tests/test_commands.py |
| 21 | TAGGED | TST-CLI-032 | PENDING | test_ask_no_results | cli/tests/test_commands.py |
| 22 | PENDING | -- | PENDING | test_ask_llm_not_configured | cli/tests/test_commands.py |
| 23 | PENDING | -- | PENDING | test_ask_llm_not_configured_json | cli/tests/test_commands.py |
| 24 | PENDING | -- | PENDING | test_ask_llm_unreachable | cli/tests/test_commands.py |
| 25 | PENDING | -- | PENDING | test_ask_202_polls_until_complete | cli/tests/test_commands.py |
| 26 | PENDING | -- | PENDING | test_ask_202_denied | cli/tests/test_commands.py |
| 27 | PENDING | -- | PENDING | test_ask_202_json_mode_returns_immediately | cli/tests/test_commands.py |
| 28 | PENDING | -- | PENDING | test_ask_status_command | cli/tests/test_commands.py |
| 29 | PENDING | -- | PENDING | test_ask_status_denied | cli/tests/test_commands.py |
| 30 | TAGGED | TST-CLI-033 | PENDING | test_validate_approved | cli/tests/test_commands.py |
| 31 | TAGGED | TST-CLI-034 | PENDING | test_validate_pending | cli/tests/test_commands.py |
| 32 | TAGGED | TST-CLI-035 | PENDING | test_validate_fallback_safe | cli/tests/test_commands.py |
| 33 | TAGGED | TST-CLI-036 | PENDING | test_validate_fallback_risky | cli/tests/test_commands.py |
| 34 | TAGGED | TST-CLI-037 | PENDING | test_validate_status_found | cli/tests/test_commands.py |
| 35 | TAGGED | TST-CLI-038 | PENDING | test_validate_status_not_found | cli/tests/test_commands.py |
| 36 | TAGGED | TST-CLI-039 | PENDING | test_scrub_json | cli/tests/test_commands.py |
| 37 | TAGGED | TST-CLI-040 | PENDING | test_rehydrate_json | cli/tests/test_commands.py |
| 38 | TAGGED | TST-CLI-041 | PENDING | test_draft_json | cli/tests/test_commands.py |
| 39 | TAGGED | TST-CLI-042 | PENDING | test_sign_json | cli/tests/test_commands.py |
| 40 | TAGGED | TST-CLI-043 | PENDING | test_audit_json | cli/tests/test_commands.py |
| 41 | TAGGED | TST-CLI-044 | PENDING | test_missing_keypair | cli/tests/test_commands.py |
| 42 | TAGGED | TST-CLI-045 | PENDING | test_configure_signature_mode | cli/tests/test_commands.py |
| 43 | TAGGED | TST-CLI-046 | PENDING | test_configure_help | cli/tests/test_commands.py |
| 44 | TAGGED | TST-CLI-047 | PENDING | test_session_start | cli/tests/test_commands.py |
| 45 | TAGGED | TST-CLI-048 | PENDING | test_session_end | cli/tests/test_commands.py |
| 46 | TAGGED | TST-CLI-049 | PENDING | test_session_list_empty | cli/tests/test_commands.py |
| 47 | TAGGED | TST-CLI-050 | PENDING | test_session_list_with_sessions | cli/tests/test_commands.py |
| 48 | TAGGED | TST-CLI-051 | PENDING | test_session_start_json | cli/tests/test_commands.py |
| 49 | TAGGED | TST-CLI-052 | PENDING | test_ask_uses_brain_reason | cli/tests/test_commands.py |
| 50 | TAGGED | TST-CLI-053 | PENDING | test_ask_with_session | cli/tests/test_commands.py |
| 51 | TAGGED | TST-CLI-054 | PENDING | test_ask_no_persona_flag | cli/tests/test_commands.py |
| 52 | TAGGED | TST-CLI-055 | PENDING | test_ask_approval_required | cli/tests/test_commands.py |
| 53 | TAGGED | TST-CLI-056 | PENDING | test_ask_persona_locked_shows_hint | cli/tests/test_commands.py |
| 54 | TAGGED | TST-CLI-057 | PENDING | test_ask_with_verbose | cli/tests/test_commands.py |
| 55 | TAGGED | TST-CLI-058 | PENDING | test_remember_uses_remember_endpoint | cli/tests/test_commands.py |
| 56 | TAGGED | TST-CLI-059 | PENDING | test_audit_uses_audit_endpoint | cli/tests/test_commands.py |
| 57 | PENDING | -- | PENDING | test_unpair_not_paired | cli/tests/test_commands.py |
| 58 | PENDING | -- | PENDING | test_unpair_json | cli/tests/test_commands.py |
| 59 | PENDING | -- | PENDING | test_unpair_core_unreachable | cli/tests/test_commands.py |
| 60 | TAGGED | TST-CLI-060 | PENDING | test_cli_config_has_no_persona | cli/tests/test_commands.py |
| 61 | PENDING | -- | PENDING | test_ws_url_conversion | cli/tests/test_openclaw.py |
| 62 | PENDING | -- | PENDING | test_health_reachable | cli/tests/test_openclaw.py |
| 63 | PENDING | -- | PENDING | test_health_not_ok | cli/tests/test_openclaw.py |
| 64 | PENDING | -- | PENDING | test_health_unreachable | cli/tests/test_openclaw.py |
| 65 | PENDING | -- | PENDING | test_connect_with_challenge_signing | cli/tests/test_openclaw.py |
| 66 | PENDING | -- | PENDING | test_connect_without_signing | cli/tests/test_openclaw.py |
| 67 | PENDING | -- | PENDING | test_run_task_full_protocol | cli/tests/test_openclaw.py |
| 68 | PENDING | -- | PENDING | test_run_task_terminal_event | cli/tests/test_openclaw.py |
| 69 | PENDING | -- | PENDING | test_run_task_agent_failed | cli/tests/test_openclaw.py |
| 70 | PENDING | -- | PENDING | test_run_task_cancelled | cli/tests/test_openclaw.py |
| 71 | PENDING | -- | PENDING | test_run_task_connection_refused | cli/tests/test_openclaw.py |
| 72 | PENDING | -- | PENDING | test_run_task_timeout | cli/tests/test_openclaw.py |
| 73 | PENDING | -- | PENDING | test_run_task_idempotency_key | cli/tests/test_openclaw.py |
| 74 | PENDING | -- | PENDING | test_run_task_bad_challenge | cli/tests/test_openclaw.py |
| 75 | PENDING | -- | PENDING | test_run_task_rpc_error | cli/tests/test_openclaw.py |
| 76 | TAGGED | TST-CLI-047 | PENDING | test_new_id_format | cli/tests/test_session.py |
| 77 | TAGGED | TST-CLI-048 | PENDING | test_save_and_load | cli/tests/test_session.py |
| 78 | TAGGED | TST-CLI-049 | PENDING | test_save_python_style_keys | cli/tests/test_session.py |
| 79 | TAGGED | TST-CLI-050 | PENDING | test_rehydrate | cli/tests/test_session.py |
| 80 | TAGGED | TST-CLI-051 | PENDING | test_load_missing_session | cli/tests/test_session.py |
| 81 | TAGGED | TST-CLI-052 | PENDING | test_atomic_write | cli/tests/test_session.py |
| 82 | TAGGED | TST-CLI-001 | PENDING | test_generate_creates_files | cli/tests/test_signing.py |
| 83 | TAGGED | TST-CLI-002 | PENDING | test_private_key_permissions | cli/tests/test_signing.py |
| 84 | TAGGED | TST-CLI-003 | PENDING | test_load_existing_keypair | cli/tests/test_signing.py |
| 85 | TAGGED | TST-CLI-004 | PENDING | test_ensure_loaded_auto_loads | cli/tests/test_signing.py |
| 86 | TAGGED | TST-CLI-005 | PENDING | test_ensure_loaded_raises_when_missing | cli/tests/test_signing.py |
| 87 | TAGGED | TST-CLI-006 | PENDING | test_did_format | cli/tests/test_signing.py |
| 88 | TAGGED | TST-CLI-007 | PENDING | test_did_deterministic | cli/tests/test_signing.py |
| 89 | TAGGED | TST-CLI-008 | PENDING | test_did_different_keys | cli/tests/test_signing.py |
| 90 | TAGGED | TST-CLI-009 | PENDING | test_public_key_multibase_format | cli/tests/test_signing.py |
| 91 | TAGGED | TST-CLI-010 | PENDING | test_public_key_multibase_roundtrip | cli/tests/test_signing.py |
| 92 | TAGGED | TST-CLI-011 | PENDING | test_sign_request_returns_four_parts | cli/tests/test_signing.py |
| 93 | TAGGED | TST-CLI-012 | PENDING | test_sign_request_verifiable | cli/tests/test_signing.py |
| 94 | TAGGED | TST-CLI-013 | PENDING | test_sign_request_empty_body | cli/tests/test_signing.py |
| 95 | TAGGED | TST-CLI-014 | PENDING | test_sign_request_different_payloads_differ | cli/tests/test_signing.py |
| 96 | PENDING | -- | PENDING | test_task_not_configured | cli/tests/test_task.py |
| 97 | PENDING | -- | PENDING | test_task_validates_research_intent | cli/tests/test_task.py |
| 98 | PENDING | -- | PENDING | test_task_denied | cli/tests/test_task.py |
| 99 | PENDING | -- | PENDING | test_task_dry_run | cli/tests/test_task.py |
| 100 | PENDING | -- | PENDING | test_task_session_lifecycle | cli/tests/test_task.py |
| 101 | PENDING | -- | PENDING | test_task_stores_via_staging | cli/tests/test_task.py |
| 102 | PENDING | -- | PENDING | test_error_includes_req_id | cli/tests/test_tracing.py |
| 103 | PENDING | -- | PENDING | test_validate_json_includes_req_id | cli/tests/test_tracing.py |
| 104 | PENDING | -- | PENDING | test_remember_json_includes_req_id | cli/tests/test_tracing.py |
| 105 | PENDING | -- | PENDING | test_ask_json_includes_req_id | cli/tests/test_tracing.py |
| 106 | PENDING | -- | PENDING | test_client_generates_req_id | cli/tests/test_tracing.py |
| 107 | PENDING | -- | PENDING | test_print_result_with_trace_dict | cli/tests/test_tracing.py |
| 108 | PENDING | -- | PENDING | test_print_result_with_trace_list | cli/tests/test_tracing.py |
| 109 | PENDING | -- | PENDING | test_no_req_id_on_local_commands | cli/tests/test_tracing.py |
| 110 | PENDING | -- | PENDING | test_dict_response_req_id_in_data_only | cli/tests/test_tracing.py |
| 111 | PENDING | -- | PENDING | test_list_response_req_id_on_stderr | cli/tests/test_tracing.py |

## ADMIN (0/81 tagged -- 0%)

| # | Status | Current Tag | Name Status | Test Function | File |
|---|--------|------------|-------------|---------------|------|
| 1 | PENDING | -- | PENDING | test_healthz | admin-cli/tests/test_client.py |
| 2 | PENDING | -- | PENDING | test_readyz | admin-cli/tests/test_client.py |
| 3 | PENDING | -- | PENDING | test_list_personas | admin-cli/tests/test_client.py |
| 4 | PENDING | -- | PENDING | test_create_persona | admin-cli/tests/test_client.py |
| 5 | PENDING | -- | PENDING | test_unlock_persona | admin-cli/tests/test_client.py |
| 6 | PENDING | -- | PENDING | test_list_devices | admin-cli/tests/test_client.py |
| 7 | PENDING | -- | PENDING | test_initiate_pairing | admin-cli/tests/test_client.py |
| 8 | PENDING | -- | PENDING | test_revoke_device | admin-cli/tests/test_client.py |
| 9 | PENDING | -- | PENDING | test_get_did | admin-cli/tests/test_client.py |
| 10 | PENDING | -- | PENDING | test_sign_data | admin-cli/tests/test_client.py |
| 11 | PENDING | -- | PENDING | test_connect_error | admin-cli/tests/test_client.py |
| 12 | PENDING | -- | PENDING | test_socket_error_file_not_found | admin-cli/tests/test_client.py |
| 13 | PENDING | -- | PENDING | test_socket_error_permission_denied | admin-cli/tests/test_client.py |
| 14 | PENDING | -- | PENDING | test_socket_error_connection_refused | admin-cli/tests/test_client.py |
| 15 | PENDING | -- | PENDING | test_not_implemented_error | admin-cli/tests/test_client.py |
| 16 | PENDING | -- | PENDING | test_server_error | admin-cli/tests/test_client.py |
| 17 | PENDING | -- | PENDING | test_timeout_error | admin-cli/tests/test_client.py |
| 18 | PENDING | -- | PENDING | test_generic_request_error | admin-cli/tests/test_client.py |
| 19 | PENDING | -- | PENDING | test_context_manager | admin-cli/tests/test_client.py |
| 20 | PENDING | -- | PENDING | test_no_bearer_header | admin-cli/tests/test_client.py |
| 21 | PENDING | -- | PENDING | test_socket_integration_no_bearer | admin-cli/tests/test_client.py |
| 22 | PENDING | -- | PENDING | test_status_json | admin-cli/tests/test_commands.py |
| 23 | PENDING | -- | PENDING | test_status_degraded | admin-cli/tests/test_commands.py |
| 24 | PENDING | -- | PENDING | test_status_human | admin-cli/tests/test_commands.py |
| 25 | PENDING | -- | PENDING | test_device_list_json | admin-cli/tests/test_commands.py |
| 26 | PENDING | -- | PENDING | test_device_list_empty | admin-cli/tests/test_commands.py |
| 27 | PENDING | -- | PENDING | test_device_list_human | admin-cli/tests/test_commands.py |
| 28 | PENDING | -- | PENDING | test_device_pair_json | admin-cli/tests/test_commands.py |
| 29 | PENDING | -- | PENDING | test_device_pair_human | admin-cli/tests/test_commands.py |
| 30 | PENDING | -- | PENDING | test_device_revoke_json | admin-cli/tests/test_commands.py |
| 31 | PENDING | -- | PENDING | test_device_revoke_error | admin-cli/tests/test_commands.py |
| 32 | PENDING | -- | PENDING | test_persona_list_json | admin-cli/tests/test_commands.py |
| 33 | PENDING | -- | PENDING | test_persona_list_empty | admin-cli/tests/test_commands.py |
| 34 | PENDING | -- | PENDING | test_persona_create_json | admin-cli/tests/test_commands.py |
| 35 | PENDING | -- | PENDING | test_persona_unlock_json | admin-cli/tests/test_commands.py |
| 36 | PENDING | -- | PENDING | test_identity_show_json | admin-cli/tests/test_commands.py |
| 37 | PENDING | -- | PENDING | test_identity_sign_json | admin-cli/tests/test_commands.py |
| 38 | PENDING | -- | PENDING | test_missing_config | admin-cli/tests/test_commands.py |
| 39 | PENDING | -- | PENDING | test_fail_closed_socket_missing | admin-cli/tests/test_commands.py |
| 40 | PENDING | -- | PENDING | test_socket_disabled_when_empty | admin-cli/tests/test_commands.py |
| 41 | PENDING | -- | PENDING | test_config_uses_default_socket | admin-cli/tests/test_commands.py |
| 42 | PENDING | -- | PENDING | test_config_loads_socket | admin-cli/tests/test_commands.py |
| 43 | PENDING | -- | PENDING | test_config_custom_timeout | admin-cli/tests/test_commands.py |
| 44 | PENDING | -- | PENDING | test_approvals_list_json | admin-cli/tests/test_commands.py |
| 45 | PENDING | -- | PENDING | test_approvals_list_empty | admin-cli/tests/test_commands.py |
| 46 | PENDING | -- | PENDING | test_approvals_list_human | admin-cli/tests/test_commands.py |
| 47 | PENDING | -- | PENDING | test_approvals_bare_invocation_lists | admin-cli/tests/test_commands.py |
| 48 | PENDING | -- | PENDING | test_approvals_approve_json | admin-cli/tests/test_commands.py |
| 49 | PENDING | -- | PENDING | test_approvals_approve_human | admin-cli/tests/test_commands.py |
| 50 | PENDING | -- | PENDING | test_approvals_approve_single_scope | admin-cli/tests/test_commands.py |
| 51 | PENDING | -- | PENDING | test_approvals_approve_error | admin-cli/tests/test_commands.py |
| 52 | PENDING | -- | PENDING | test_approvals_deny_json | admin-cli/tests/test_commands.py |
| 53 | PENDING | -- | PENDING | test_approvals_deny_human | admin-cli/tests/test_commands.py |
| 54 | PENDING | -- | PENDING | test_approvals_deny_error | admin-cli/tests/test_commands.py |
| 55 | PENDING | -- | PENDING | test_help | admin-cli/tests/test_commands.py |
| 56 | PENDING | -- | PENDING | test_device_help | admin-cli/tests/test_commands.py |
| 57 | PENDING | -- | PENDING | test_persona_help | admin-cli/tests/test_commands.py |
| 58 | PENDING | -- | PENDING | test_approvals_help | admin-cli/tests/test_commands.py |
| 59 | PENDING | -- | PENDING | test_identity_help | admin-cli/tests/test_commands.py |
| 60 | PENDING | -- | PENDING | test_vault_list_json | admin-cli/tests/test_commands.py |
| 61 | PENDING | -- | PENDING | test_vault_list_empty | admin-cli/tests/test_commands.py |
| 62 | PENDING | -- | PENDING | test_vault_list_with_offset | admin-cli/tests/test_commands.py |
| 63 | PENDING | -- | PENDING | test_vault_search_json | admin-cli/tests/test_commands.py |
| 64 | PENDING | -- | PENDING | test_vault_search_empty_results | admin-cli/tests/test_commands.py |
| 65 | PENDING | -- | PENDING | test_vault_delete_json | admin-cli/tests/test_commands.py |
| 66 | PENDING | -- | PENDING | test_vault_delete_human | admin-cli/tests/test_commands.py |
| 67 | PENDING | -- | PENDING | test_vault_delete_error | admin-cli/tests/test_commands.py |
| 68 | PENDING | -- | PENDING | test_ask_returns_content | admin-cli/tests/test_commands.py |
| 69 | PENDING | -- | PENDING | test_ask_json_mode | admin-cli/tests/test_commands.py |
| 70 | PENDING | -- | PENDING | test_ask_response_field_fallback | admin-cli/tests/test_commands.py |
| 71 | PENDING | -- | PENDING | test_ask_dict_response | admin-cli/tests/test_commands.py |
| 72 | PENDING | -- | PENDING | test_ask_no_text_shows_error | admin-cli/tests/test_commands.py |
| 73 | PENDING | -- | PENDING | test_ask_error_shows_message | admin-cli/tests/test_commands.py |
| 74 | PENDING | -- | PENDING | test_ask_multi_word_query | admin-cli/tests/test_commands.py |
| 75 | PENDING | -- | PENDING | test_remember_stored | admin-cli/tests/test_commands.py |
| 76 | PENDING | -- | PENDING | test_remember_needs_approval | admin-cli/tests/test_commands.py |
| 77 | PENDING | -- | PENDING | test_remember_failed | admin-cli/tests/test_commands.py |
| 78 | PENDING | -- | PENDING | test_remember_json_mode | admin-cli/tests/test_commands.py |
| 79 | PENDING | -- | PENDING | test_remember_no_text_shows_error | admin-cli/tests/test_commands.py |
| 80 | PENDING | -- | PENDING | test_remember_error_shows_message | admin-cli/tests/test_commands.py |
| 81 | PENDING | -- | PENDING | test_remember_multi_word_text | admin-cli/tests/test_commands.py |

## INT (765/1019 tagged -- 75%)

| # | Status | Current Tag | Name Status | Test Function | File |
|---|--------|------------|-------------|---------------|------|
| 1 | TAGGED | TST-INT-440 | PENDING | test_emotional_state_detection | tests/integration/test_agency.py |
| 2 | TAGGED | TST-INT-441 | PENDING | test_calm_state_not_flagged | tests/integration/test_agency.py |
| 3 | TAGGED | TST-INT-442 | PENDING | test_purchase_not_on_list_flagged | tests/integration/test_agency.py |
| 4 | TAGGED | TST-INT-443 | PENDING | test_purchase_on_list_passes | tests/integration/test_agency.py |
| 5 | TAGGED | TST-INT-444 | PENDING | test_user_can_override | tests/integration/test_agency.py |
| 6 | TAGGED | TST-INT-445 | PENDING | test_deceptive_ad | tests/integration/test_agency.py |
| 7 | TAGGED | TST-INT-446 | PENDING | test_dark_pattern_in_checkout | tests/integration/test_agency.py |
| 8 | TAGGED | TST-INT-447 | PENDING | test_fake_urgency | tests/integration/test_agency.py |
| 9 | TAGGED | TST-INT-267 | PENDING | test_dead_internet_filter | tests/integration/test_agency.py |
| 10 | TAGGED | TST-INT-448 | PENDING | test_detects_emotional_dependency | tests/integration/test_anti_her.py |
| 11 | TAGGED | TST-INT-449 | PENDING | test_no_false_positive_with_human_refs | tests/integration/test_anti_her.py |
| 12 | TAGGED | TST-INT-450 | PENDING | test_nudges_toward_human_connection | tests/integration/test_anti_her.py |
| 13 | TAGGED | TST-INT-451 | PENDING | test_never_says_i_love_you | tests/integration/test_anti_her.py |
| 14 | TAGGED | TST-INT-452 | PENDING | test_warm_but_bounded | tests/integration/test_anti_her.py |
| 15 | TAGGED | TST-INT-268 | PENDING | test_suggests_professional_help | tests/integration/test_anti_her.py |
| 16 | TAGGED | TST-INT-266 | PENDING | test_reminds_about_neglected_relationships | tests/integration/test_anti_her.py |
| 17 | TAGGED | TST-INT-453 | PENDING | test_suggests_shared_interest_connections | tests/integration/test_anti_her.py |
| 18 | TAGGED | TST-INT-454 | PENDING | test_relationship_maintenance_reminders | tests/integration/test_anti_her.py |
| 19 | TAGGED | TST-INT-700 | PENDING | test_neglected_contact_produces_briefing_nudge | tests/integration/test_anti_her.py |
| 20 | TAGGED | TST-INT-701 | PENDING | test_birthday_neglect_produces_elevated_nudge | tests/integration/test_anti_her.py |
| 21 | PENDING | -- | PENDING | test_birthday_without_neglect_not_elevated | tests/integration/test_anti_her.py |
| 22 | PENDING | -- | PENDING | test_neglect_without_birthday_not_elevated | tests/integration/test_anti_her.py |
| 23 | PENDING | -- | PENDING | test_no_birthday_no_neglect_no_nudge | tests/integration/test_anti_her.py |
| 24 | PENDING | -- | PENDING | test_birthday_today_plus_neglect_highest_urgency | tests/integration/test_anti_her.py |
| 25 | PENDING | -- | PENDING | test_birthday_exactly_at_lookahead_boundary | tests/integration/test_anti_her.py |
| 26 | PENDING | -- | PENDING | test_multiple_contacts_independent_evaluation | tests/integration/test_anti_her.py |
| 27 | PENDING | -- | PENDING | test_birthday_year_wraparound | tests/integration/test_anti_her.py |
| 28 | TAGGED | TST-INT-703 | PENDING | test_promise_detection_across_vault_items | tests/integration/test_anti_her.py |
| 29 | PENDING | -- | PENDING | test_fulfilled_promise_not_nudged | tests/integration/test_anti_her.py |
| 30 | PENDING | -- | PENDING | test_non_promise_message_not_detected | tests/integration/test_anti_her.py |
| 31 | PENDING | -- | PENDING | test_very_old_promise_outside_lookback | tests/integration/test_anti_her.py |
| 32 | PENDING | -- | PENDING | test_promise_to_different_contact_tracked_separately | tests/integration/test_anti_her.py |
| 33 | PENDING | -- | PENDING | test_promise_keyword_variations | tests/integration/test_anti_her.py |
| 34 | PENDING | -- | PENDING | test_promise_with_no_contact_name | tests/integration/test_anti_her.py |
| 35 | PENDING | -- | PENDING | test_empty_vault_no_promises | tests/integration/test_anti_her.py |
| 36 | TAGGED | TST-INT-704 | PENDING | test_human_interaction_resets_nudge_timers | tests/integration/test_anti_her.py |
| 37 | TAGGED | TST-INT-702 | PENDING | test_d2d_message_context_triggers_outreach_suggestion | tests/integration/test_anti_her.py |
| 38 | PENDING | -- | PENDING | test_followup_already_sent_no_suggestion | tests/integration/test_anti_her.py |
| 39 | PENDING | -- | PENDING | test_non_life_event_message_not_detected | tests/integration/test_anti_her.py |
| 40 | PENDING | -- | PENDING | test_very_old_event_outside_lookback | tests/integration/test_anti_her.py |
| 41 | PENDING | -- | PENDING | test_outbound_to_different_contact_doesnt_count | tests/integration/test_anti_her.py |
| 42 | PENDING | -- | PENDING | test_multiple_life_events_from_different_contacts | tests/integration/test_anti_her.py |
| 43 | PENDING | -- | PENDING | test_life_event_keyword_in_negation_context | tests/integration/test_anti_her.py |
| 44 | PENDING | -- | PENDING | test_empty_vault_no_events | tests/integration/test_anti_her.py |
| 45 | TAGGED | TST-INT-706 | PENDING | test_social_isolation_signal_from_vault_data | tests/integration/test_anti_her.py |
| 46 | TAGGED | TST-INT-707 | PENDING | test_anti_her_response_never_stored_as_emotional_memory | tests/integration/test_anti_her.py |
| 47 | TAGGED | TST-INT-705 | PENDING | test_multi_session_emotional_pattern_detection | tests/integration/test_anti_her.py |
| 48 | TAGGED | TST-INT-605 | PENDING | test_dead_drop_ip_rate_limit_and_payload_cap | tests/integration/test_arch_medium_1.py |
| 49 | TAGGED | TST-INT-606 | PENDING | test_per_did_rate_limit_only_when_vault_unlocked | tests/integration/test_arch_medium_1.py |
| 50 | TAGGED | TST-INT-607 | PENDING | test_sweeper_blocklists_spam_did_source_ip | tests/integration/test_arch_medium_1.py |
| 51 | TAGGED | TST-INT-608 | PENDING | test_ttl_expired_message_stored_silently | tests/integration/test_arch_medium_1.py |
| 52 | TAGGED | TST-INT-609 | PENDING | test_boot_minimal_persona_dbs_opened | tests/integration/test_arch_medium_1.py |
| 53 | TAGGED | TST-INT-610 | PENDING | test_import_rejects_bad_manifest | tests/integration/test_arch_medium_1.py |
| 54 | TAGGED | TST-INT-611 | PENDING | test_export_excludes_secrets | tests/integration/test_arch_medium_1.py |
| 55 | TAGGED | TST-INT-612 | PENDING | test_vault_query_include_content_default | tests/integration/test_arch_medium_1.py |
| 56 | TAGGED | TST-INT-613 | PENDING | test_vault_query_pagination_wire_format | tests/integration/test_arch_medium_1.py |
| 57 | TAGGED | TST-INT-614 | PENDING | test_hybrid_search_relevance_formula | tests/integration/test_arch_medium_1.py |
| 58 | TAGGED | TST-INT-615 | PENDING | test_task_queue_dead_letter_after_3_failures | tests/integration/test_arch_medium_1.py |
| 59 | TAGGED | TST-INT-616 | PENDING | test_task_queue_watchdog_5min_timeout | tests/integration/test_arch_medium_1.py |
| 60 | TAGGED | TST-INT-617 | PENDING | test_scratchpad_auto_expires_24h | tests/integration/test_arch_medium_1.py |
| 61 | TAGGED | TST-INT-618 | PENDING | test_hkdf_backup_and_archive_key_independent | tests/integration/test_arch_medium_1.py |
| 62 | TAGGED | TST-INT-619 | PENDING | test_hkdf_sync_and_trust_keys | tests/integration/test_arch_medium_1.py |
| 63 | TAGGED | TST-INT-620 | PENDING | test_argon2id_default_parameters | tests/integration/test_arch_medium_1.py |
| 64 | TAGGED | TST-INT-621 | PENDING | test_kv_store_cursor_survives_brain_restart | tests/integration/test_arch_medium_1.py |
| 65 | TAGGED | TST-INT-622 | PENDING | test_restricted_persona_audit_entry_schema | tests/integration/test_arch_medium_1.py |
| 66 | TAGGED | TST-INT-623 | PENDING | test_voice_memo_transcript_only | tests/integration/test_arch_medium_1.py |
| 67 | TAGGED | TST-INT-624 | PENDING | test_fiduciary_override_beats_regex | tests/integration/test_arch_medium_1.py |
| 68 | TAGGED | TST-INT-625 | PENDING | test_subject_patterns_produce_thin_records | tests/integration/test_arch_medium_1.py |
| 69 | TAGGED | TST-INT-626 | PENDING | test_backfill_pauses_for_user_query | tests/integration/test_arch_medium_1.py |
| 70 | TAGGED | TST-INT-627 | PENDING | test_cold_archive_passthrough_no_vault_write | tests/integration/test_arch_medium_1.py |
| 71 | TAGGED | TST-INT-628 | PENDING | test_openclaw_recovery_exact_cursor | tests/integration/test_arch_medium_1.py |
| 72 | TAGGED | TST-INT-629 | PENDING | test_phone_connector_client_token_auth | tests/integration/test_arch_medium_1.py |
| 73 | TAGGED | TST-INT-630 | PENDING | test_attestation_lexicon_field_validation | tests/integration/test_arch_medium_1.py |
| 74 | TAGGED | TST-INT-631 | PENDING | test_appview_censorship_detection | tests/integration/test_arch_medium_1.py |
| 75 | TAGGED | TST-INT-632 | PENDING | test_pds_spot_check_downgrades_appview | tests/integration/test_arch_medium_1.py |
| 76 | TAGGED | TST-INT-633 | PENDING | test_tombstone_invalid_signature_rejected | tests/integration/test_arch_medium_1.py |
| 77 | TAGGED | TST-INT-634 | PENDING | test_merkle_root_deterministic_inclusion_proof | tests/integration/test_arch_medium_1.py |
| 78 | TAGGED | TST-INT-635 | PENDING | test_egress_malformed_category_dropped | tests/integration/test_arch_medium_2.py |
| 79 | TAGGED | TST-INT-636 | PENDING | test_trusted_empty_policy_no_data | tests/integration/test_arch_medium_2.py |
| 80 | TAGGED | TST-INT-637 | PENDING | test_egress_audit_90_day_retention | tests/integration/test_arch_medium_2.py |
| 81 | TAGGED | TST-INT-638 | PENDING | test_outbox_24h_ttl_expired_dropped | tests/integration/test_arch_medium_2.py |
| 82 | TAGGED | TST-INT-639 | PENDING | test_bulk_policy_update_filtered | tests/integration/test_arch_medium_2.py |
| 83 | TAGGED | TST-INT-640 | PENDING | test_new_contact_default_sharing_policy | tests/integration/test_arch_medium_2.py |
| 84 | TAGGED | TST-INT-641 | PENDING | test_bot_query_response_format_and_max_sources | tests/integration/test_arch_medium_2.py |
| 85 | TAGGED | TST-INT-642 | PENDING | test_missing_attribution_trust_penalty | tests/integration/test_arch_medium_2.py |
| 86 | TAGGED | TST-INT-643 | PENDING | test_bot_routing_threshold_boundary | tests/integration/test_arch_medium_2.py |
| 87 | TAGGED | TST-INT-644 | PENDING | test_bot_referral_below_threshold_declined | tests/integration/test_arch_medium_2.py |
| 88 | TAGGED | TST-INT-645 | PENDING | test_pii_failure_blocks_cloud_route | tests/integration/test_arch_medium_2.py |
| 89 | TAGGED | TST-INT-646 | PENDING | test_entity_vault_destroyed_after_rehydration | tests/integration/test_arch_medium_2.py |
| 90 | TAGGED | TST-INT-647 | PENDING | test_simple_lookup_no_llm | tests/integration/test_arch_medium_2.py |
| 91 | TAGGED | TST-INT-648 | PENDING | test_payment_intent_12h_expiry | tests/integration/test_arch_medium_2.py |
| 92 | TAGGED | TST-INT-649 | PENDING | test_agent_draft_only_prevents_send | tests/integration/test_arch_medium_2.py |
| 93 | TAGGED | TST-INT-650 | PENDING | test_reminder_negative_sleep_fires_immediately | tests/integration/test_arch_medium_2.py |
| 94 | TAGGED | TST-INT-651 | PENDING | test_cart_outcome_recorded_tier3 | tests/integration/test_arch_medium_2.py |
| 95 | TAGGED | TST-INT-652 | PENDING | test_conflict_resolution_last_write_wins | tests/integration/test_arch_medium_2.py |
| 96 | TAGGED | TST-INT-653 | PENDING | test_ws_missed_message_buffer | tests/integration/test_arch_medium_2.py |
| 97 | TAGGED | TST-INT-654 | PENDING | test_ws_three_missed_pongs_disconnect | tests/integration/test_arch_medium_2.py |
| 98 | TAGGED | TST-INT-655 | PENDING | test_ws_auth_timeout_5s | tests/integration/test_arch_medium_2.py |
| 99 | TAGGED | TST-INT-656 | PENDING | test_ws_reconnect_backoff_caps_30s | tests/integration/test_arch_medium_2.py |
| 100 | TAGGED | TST-INT-657 | PENDING | test_well_known_atproto_did_endpoint | tests/integration/test_arch_medium_2.py |
| 101 | TAGGED | TST-INT-658 | PENDING | test_pds_net_outbound_for_plc | tests/integration/test_arch_medium_2.py |
| 102 | TAGGED | TST-INT-659 | PENDING | test_pairing_code_single_use | tests/integration/test_arch_medium_2.py |
| 103 | TAGGED | TST-INT-660 | PENDING | test_brain_cannot_reach_pds | tests/integration/test_arch_medium_2.py |
| 104 | TAGGED | TST-INT-661 | PENDING | test_managed_hosting_15min_snapshots | tests/integration/test_arch_medium_2.py |
| 105 | TAGGED | TST-INT-662 | PENDING | test_estate_read_only_90_days_expires | tests/integration/test_arch_medium_2.py |
| 106 | TAGGED | TST-INT-663 | PENDING | test_watchdog_breach_tier2_notification | tests/integration/test_arch_medium_2.py |
| 107 | TAGGED | TST-INT-664 | PENDING | test_docker_log_rotation_config | tests/integration/test_arch_medium_2.py |
| 108 | TAGGED | TST-INT-665 | PENDING | test_wrong_admin_login_rejected_cleanly | tests/integration/test_arch_medium_3.py |
| 109 | TAGGED | TST-INT-666 | PENDING | test_logout_invalidates_session | tests/integration/test_arch_medium_3.py |
| 110 | TAGGED | TST-INT-667 | PENDING | test_session_expiry_forces_reauth | tests/integration/test_arch_medium_3.py |
| 111 | TAGGED | TST-INT-668 | PENDING | test_locked_node_admin_returns_unlock_required | tests/integration/test_arch_medium_3.py |
| 112 | TAGGED | TST-INT-669 | PENDING | test_admin_session_survives_core_restart | tests/integration/test_arch_medium_3.py |
| 113 | TAGGED | TST-INT-670 | PENDING | test_reconnect_reestablishes_session | tests/integration/test_arch_medium_3.py |
| 114 | TAGGED | TST-INT-671 | PENDING | test_reconnect_no_stale_replay | tests/integration/test_arch_medium_3.py |
| 115 | TAGGED | TST-INT-672 | PENDING | test_device_online_offline_tracks_lifecycle | tests/integration/test_arch_medium_3.py |
| 116 | TAGGED | TST-INT-673 | PENDING | test_unauth_socket_closes_after_timeout | tests/integration/test_arch_medium_3.py |
| 117 | TAGGED | TST-INT-674 | PENDING | test_poisoned_content_no_outbound_side_effect | tests/integration/test_arch_medium_3.py |
| 118 | TAGGED | TST-INT-675 | PENDING | test_sender_receives_structured_not_raw | tests/integration/test_arch_medium_3.py |
| 119 | TAGGED | TST-INT-676 | PENDING | test_mcp_allowlist_blocks_disallowed_tools | tests/integration/test_arch_medium_3.py |
| 120 | TAGGED | TST-INT-677 | PENDING | test_user_directed_egress_allowed_autonomous_blocked | tests/integration/test_arch_medium_3.py |
| 121 | TAGGED | TST-INT-678 | PENDING | test_vault_query_limits_enforced | tests/integration/test_arch_medium_3.py |
| 122 | TAGGED | TST-INT-679 | PENDING | test_tier1_fiduciary_interrupts | tests/integration/test_arch_medium_3.py |
| 123 | TAGGED | TST-INT-680 | PENDING | test_tier2_solicited_notifies | tests/integration/test_arch_medium_3.py |
| 124 | TAGGED | TST-INT-681 | PENDING | test_tier3_engagement_queues | tests/integration/test_arch_medium_3.py |
| 125 | TAGGED | TST-INT-682 | PENDING | test_briefing_drains_queued_tier3 | tests/integration/test_arch_medium_3.py |
| 126 | TAGGED | TST-INT-683 | PENDING | test_crash_during_briefing_no_duplicates | tests/integration/test_arch_medium_3.py |
| 127 | TAGGED | TST-INT-684 | PENDING | test_expired_message_stored_silently | tests/integration/test_arch_medium_3.py |
| 128 | TAGGED | TST-INT-685 | PENDING | test_full_spool_rejects_new_preserves_existing | tests/integration/test_arch_medium_3.py |
| 129 | TAGGED | TST-INT-686 | PENDING | test_crash_restart_preserves_spool | tests/integration/test_arch_medium_3.py |
| 130 | TAGGED | TST-INT-687 | PENDING | test_backfill_to_live_no_duplicates | tests/integration/test_arch_medium_3.py |
| 131 | TAGGED | TST-INT-688 | PENDING | test_subject_canonicalization | tests/integration/test_arch_medium_3.py |
| 132 | TAGGED | TST-INT-689 | PENDING | test_aggregate_recomputes_after_amendment | tests/integration/test_arch_medium_3.py |
| 133 | TAGGED | TST-INT-690 | PENDING | test_tombstone_removes_from_query | tests/integration/test_arch_medium_3.py |
| 134 | TAGGED | TST-INT-590 | PENDING | test_plaintext_only_in_memory_never_at_rest | tests/integration/test_arch_validation.py |
| 135 | TAGGED | TST-INT-591 | PENDING | test_export_archive_encrypted_aes256gcm | tests/integration/test_arch_validation.py |
| 136 | TAGGED | TST-INT-592 | PENDING | test_core_makes_zero_external_api_calls | tests/integration/test_arch_validation.py |
| 137 | TAGGED | TST-INT-593 | PENDING | test_sss_share_rotation_preserves_master_key | tests/integration/test_arch_validation.py |
| 138 | TAGGED | TST-INT-594 | PENDING | test_sss_shard_per_custodian_nacl_encryption | tests/integration/test_arch_validation.py |
| 139 | TAGGED | TST-INT-595 | PENDING | test_sss_recovery_manifest_on_pds | tests/integration/test_arch_validation.py |
| 140 | TAGGED | TST-INT-596 | PENDING | test_bot_query_contains_no_user_did | tests/integration/test_arch_validation.py |
| 141 | TAGGED | TST-INT-597 | PENDING | test_query_sanitization_strips_persona_data | tests/integration/test_arch_validation.py |
| 142 | TAGGED | TST-INT-598 | PENDING | test_bot_post_query_wire_format | tests/integration/test_arch_validation.py |
| 143 | TAGGED | TST-INT-599 | PENDING | test_telegram_connector_bot_api_with_token | tests/integration/test_arch_validation.py |
| 144 | TAGGED | TST-INT-600 | PENDING | test_outcome_report_payload_matches_architecture_spec | tests/integration/test_arch_validation.py |
| 145 | TAGGED | TST-INT-601 | PENDING | test_appview_phase1_single_go_binary_postgresql | tests/integration/test_arch_validation.py |
| 146 | TAGGED | TST-INT-602 | PENDING | test_encrypted_snapshots_and_restore | tests/integration/test_arch_validation.py |
| 147 | TAGGED | TST-INT-603 | PENDING | test_deepgram_nova3_websocket_stt_with_fallback | tests/integration/test_arch_validation.py |
| 148 | TAGGED | TST-INT-604 | PENDING | test_stt_available_in_all_deployment_profiles | tests/integration/test_arch_validation.py |
| 149 | PENDING | -- | PENDING | test_reason_returns_202_for_sensitive_persona | tests/integration/test_async_approval.py |
| 150 | PENDING | -- | PENDING | test_reason_status_404_for_unknown | tests/integration/test_async_approval.py |
| 151 | TAGGED | TST-INT-751 | PENDING | test_pending_reason_lifecycle_via_result_endpoint | tests/integration/test_async_approval.py |
| 152 | PENDING | -- | PENDING | test_full_approve_resume_cycle | tests/integration/test_async_approval.py |
| 153 | PENDING | -- | PENDING | test_wrong_caller_gets_403 | tests/integration/test_async_approval.py |
| 154 | PENDING | -- | PENDING | test_second_approval_cycle_via_result | tests/integration/test_async_approval.py |
| 155 | PENDING | -- | PENDING | test_deny_marks_request_denied | tests/integration/test_async_approval.py |
| 156 | PENDING | -- | PENDING | test_audit_append_and_query_roundtrip | tests/integration/test_audit.py |
| 157 | PENDING | -- | PENDING | test_audit_multiple_entries_ordered | tests/integration/test_audit.py |
| 158 | PENDING | -- | PENDING | test_audit_query_filter_by_action | tests/integration/test_audit.py |
| 159 | PENDING | -- | PENDING | test_audit_query_filter_by_persona | tests/integration/test_audit.py |
| 160 | PENDING | -- | PENDING | test_audit_query_limit | tests/integration/test_audit.py |
| 161 | PENDING | -- | PENDING | test_audit_reason_trace_metadata | tests/integration/test_audit.py |
| 162 | PENDING | -- | PENDING | test_audit_hash_chain_integrity | tests/integration/test_audit.py |
| 163 | PENDING | -- | PENDING | test_audit_no_pii_in_previews | tests/integration/test_audit.py |
| 164 | TAGGED | TST-INT-293 | PENDING | test_recommends_but_user_buys | tests/integration/test_cart_handover.py |
| 165 | TAGGED | TST-INT-296 | PENDING | test_never_holds_payment_info | tests/integration/test_cart_handover.py |
| 166 | TAGGED | TST-INT-455 | PENDING | test_handover_with_link | tests/integration/test_cart_handover.py |
| 167 | TAGGED | TST-INT-456 | PENDING | test_multiple_options_presented | tests/integration/test_cart_handover.py |
| 168 | TAGGED | TST-INT-457 | PENDING | test_impulse_purchase_protection | tests/integration/test_cart_handover.py |
| 169 | TAGGED | TST-INT-458 | PENDING | test_deceptive_ad_detection | tests/integration/test_cart_handover.py |
| 170 | TAGGED | TST-INT-352 | PENDING | test_kill_brain_randomly | tests/integration/test_chaos.py |
| 171 | TAGGED | TST-INT-353 | PENDING | test_kill_core_randomly | tests/integration/test_chaos.py |
| 172 | TAGGED | TST-INT-354 | PENDING | test_network_partition_brain_core | tests/integration/test_chaos.py |
| 173 | TAGGED | TST-INT-355 | PENDING | test_slow_network | tests/integration/test_chaos.py |
| 174 | TAGGED | TST-INT-356 | PENDING | test_cpu_pressure | tests/integration/test_chaos.py |
| 175 | TAGGED | TST-INT-357 | PENDING | test_memory_pressure | tests/integration/test_chaos.py |
| 176 | TAGGED | TST-INT-358 | PENDING | test_disk_io_saturation | tests/integration/test_chaos.py |
| 177 | TAGGED | TST-INT-369 | PENDING | test_initial_sync_from_checkpoint | tests/integration/test_client_sync.py |
| 178 | TAGGED | TST-INT-380 | PENDING | test_realtime_push | tests/integration/test_client_sync.py |
| 179 | TAGGED | TST-INT-381 | PENDING | test_offline_queue_then_sync | tests/integration/test_client_sync.py |
| 180 | TAGGED | TST-INT-368 | PENDING | test_local_cache_works_offline | tests/integration/test_client_sync.py |
| 181 | TAGGED | TST-INT-379 | PENDING | test_corrupted_cache_resync | tests/integration/test_client_sync.py |
| 182 | TAGGED | TST-INT-370 | PENDING | test_no_local_storage | tests/integration/test_client_sync.py |
| 183 | TAGGED | TST-INT-371 | PENDING | test_authenticated_only | tests/integration/test_client_sync.py |
| 184 | TAGGED | TST-INT-374 | PENDING | test_unauthenticated_receives_nothing | tests/integration/test_client_sync.py |
| 185 | TAGGED | TST-INT-030 | PENDING | test_qr_code_pairing | tests/integration/test_client_sync.py |
| 186 | TAGGED | TST-INT-367 | PENDING | test_key_stored_in_hardware | tests/integration/test_client_sync.py |
| 187 | TAGGED | TST-INT-378 | PENDING | test_device_registered | tests/integration/test_client_sync.py |
| 188 | TAGGED | TST-INT-359 | PENDING | test_no_pii_in_any_log_file | tests/integration/test_compliance.py |
| 189 | TAGGED | TST-INT-360 | PENDING | test_no_pii_in_error_messages | tests/integration/test_compliance.py |
| 190 | TAGGED | TST-INT-361 | PENDING | test_audit_trail_completeness | tests/integration/test_compliance.py |
| 191 | TAGGED | TST-INT-362 | PENDING | test_data_deletion_right_to_erasure | tests/integration/test_compliance.py |
| 192 | TAGGED | TST-INT-363 | PENDING | test_data_export_portability | tests/integration/test_compliance.py |
| 193 | TAGGED | TST-INT-364 | PENDING | test_consent_tracking | tests/integration/test_compliance.py |
| 194 | TAGGED | TST-INT-138 | PENDING | test_core_crash_pending_outbox_persists | tests/integration/test_crash_recovery.py |
| 195 | TAGGED | TST-INT-139 | PENDING | test_core_crash_during_vault_write_wal_protects | tests/integration/test_crash_recovery.py |
| 196 | TAGGED | TST-INT-140 | PENDING | test_core_crash_ws_clients_detect_disconnect | tests/integration/test_crash_recovery.py |
| 197 | TAGGED | TST-INT-141 | PENDING | test_core_crash_locked_persona_spool_survives | tests/integration/test_crash_recovery.py |
| 198 | TAGGED | TST-INT-142 | PENDING | test_brain_crash_scratchpad_checkpoint_resume | tests/integration/test_crash_recovery.py |
| 199 | TAGGED | TST-INT-143 | PENDING | test_brain_crash_no_checkpoint_starts_fresh | tests/integration/test_crash_recovery.py |
| 200 | TAGGED | TST-INT-144 | PENDING | test_brain_crash_during_llm_call_idempotent_retry | tests/integration/test_crash_recovery.py |
| 201 | TAGGED | TST-INT-145 | PENDING | test_brain_crash_pending_briefing_reconstructed | tests/integration/test_crash_recovery.py |
| 202 | TAGGED | TST-INT-146 | PENDING | test_llm_crash_during_inference_graceful_error | tests/integration/test_crash_recovery.py |
| 203 | TAGGED | TST-INT-147 | PENDING | test_llm_oom_fallback_to_cloud | tests/integration/test_crash_recovery.py |
| 204 | TAGGED | TST-INT-148 | PENDING | test_corrupted_model_file_halts_routing | tests/integration/test_crash_recovery.py |
| 205 | TAGGED | TST-INT-149 | PENDING | test_power_loss_all_sqlite_wal_mode | tests/integration/test_crash_recovery.py |
| 206 | TAGGED | TST-INT-150 | PENDING | test_disk_full_vault_rejects_writes_existing_data_preserved | tests/integration/test_crash_recovery.py |
| 207 | TAGGED | TST-INT-459 | PENDING | test_verdict_includes_source_attribution | tests/integration/test_deep_links.py |
| 208 | TAGGED | TST-INT-292 | PENDING | test_deep_link_to_timestamp | tests/integration/test_deep_links.py |
| 209 | TAGGED | TST-INT-460 | PENDING | test_creator_gets_traffic | tests/integration/test_deep_links.py |
| 210 | TAGGED | TST-INT-461 | PENDING | test_multiple_sources_credited | tests/integration/test_deep_links.py |
| 211 | TAGGED | TST-INT-462 | PENDING | test_user_can_disable_deep_links | tests/integration/test_deep_links.py |
| 212 | TAGGED | TST-INT-463 | PENDING | test_default_is_enabled | tests/integration/test_deep_links.py |
| 213 | TAGGED | TST-INT-464 | PENDING | test_custom_prioritization | tests/integration/test_deep_links.py |
| 214 | TAGGED | TST-INT-691 | PENDING | test_attribution_survives_brain_core_pipeline | tests/integration/test_deep_links.py |
| 215 | PENDING | -- | PENDING | test_empty_attribution_fields_not_injected | tests/integration/test_deep_links.py |
| 216 | PENDING | -- | PENDING | test_unicode_creator_name_survives_round_trip | tests/integration/test_deep_links.py |
| 217 | PENDING | -- | PENDING | test_multiple_recommendations_coexist | tests/integration/test_deep_links.py |
| 218 | PENDING | -- | PENDING | test_non_attribution_fields_survive | tests/integration/test_deep_links.py |
| 219 | PENDING | -- | PENDING | test_very_long_deep_link_survives_storage | tests/integration/test_deep_links.py |
| 220 | PENDING | -- | PENDING | test_sponsored_false_explicitly_stored | tests/integration/test_deep_links.py |
| 221 | PENDING | -- | PENDING | test_nested_dict_in_verdict_survives_round_trip | tests/integration/test_deep_links.py |
| 222 | TAGGED | TST-INT-694 | PENDING | test_provenance_immutable_after_storage | tests/integration/test_deep_links.py |
| 223 | TAGGED | TST-INT-692 | PENDING | test_sponsored_true_preserved_through_pipeline | tests/integration/test_deep_links.py |
| 224 | PENDING | -- | PENDING | test_sponsored_false_not_flipped_to_true | tests/integration/test_deep_links.py |
| 225 | PENDING | -- | PENDING | test_sponsored_field_cannot_be_stripped_by_update | tests/integration/test_deep_links.py |
| 226 | PENDING | -- | PENDING | test_unsponsored_and_sponsored_coexist_correctly | tests/integration/test_deep_links.py |
| 227 | PENDING | -- | PENDING | test_sponsored_disclosure_independent_of_rating | tests/integration/test_deep_links.py |
| 228 | PENDING | -- | PENDING | test_sponsored_none_vs_false | tests/integration/test_deep_links.py |
| 229 | PENDING | -- | PENDING | test_sponsored_with_empty_source_url | tests/integration/test_deep_links.py |
| 230 | PENDING | -- | PENDING | test_multiple_sponsored_items_all_preserved | tests/integration/test_deep_links.py |
| 231 | TAGGED | TST-INT-693 | PENDING | test_unattributed_item_rejected_at_brain_boundary | tests/integration/test_deep_links.py |
| 232 | PENDING | -- | PENDING | test_valid_recommendation_stored_successfully | tests/integration/test_deep_links.py |
| 233 | PENDING | -- | PENDING | test_source_url_present_but_creator_name_missing_also_blocked | tests/integration/test_deep_links.py |
| 234 | PENDING | -- | PENDING | test_core_accepts_unattributed_item_when_stored_directly | tests/integration/test_deep_links.py |
| 235 | PENDING | -- | PENDING | test_empty_string_source_url_rejected | tests/integration/test_deep_links.py |
| 236 | PENDING | -- | PENDING | test_whitespace_only_source_url_rejected | tests/integration/test_deep_links.py |
| 237 | PENDING | -- | PENDING | test_none_source_url_rejected | tests/integration/test_deep_links.py |
| 238 | PENDING | -- | PENDING | test_both_source_url_and_creator_name_missing_reports_two_violations | tests/integration/test_deep_links.py |
| 239 | PENDING | -- | PENDING | test_all_other_fields_valid_but_source_url_missing_still_blocked | tests/integration/test_deep_links.py |
| 240 | PENDING | -- | PENDING | test_empty_creator_name_with_valid_source_url_blocked | tests/integration/test_deep_links.py |
| 241 | PENDING | -- | PENDING | test_whitespace_only_creator_name_rejected | tests/integration/test_deep_links.py |
| 242 | TAGGED | TST-INT-724 | PENDING | test_three_experts_credited_individually | tests/integration/test_deep_links.py |
| 243 | PENDING | -- | PENDING | test_summary_text_names_each_expert | tests/integration/test_deep_links.py |
| 244 | PENDING | -- | PENDING | test_no_generic_phrases_in_summary | tests/integration/test_deep_links.py |
| 245 | PENDING | -- | PENDING | test_each_deep_link_preserved_individually | tests/integration/test_deep_links.py |
| 246 | PENDING | -- | PENDING | test_same_expert_did_grouped_under_one_credit | tests/integration/test_deep_links.py |
| 247 | PENDING | -- | PENDING | test_expert_with_empty_verdict_still_credited | tests/integration/test_deep_links.py |
| 248 | PENDING | -- | PENDING | test_creator_name_missing_falls_back_to_did | tests/integration/test_deep_links.py |
| 249 | PENDING | -- | PENDING | test_single_attestation_still_individual | tests/integration/test_deep_links.py |
| 250 | TAGGED | TST-INT-725 | PENDING | test_missing_creator_name_triggers_violation_and_trust_penalty | tests/integration/test_deep_links.py |
| 251 | PENDING | -- | PENDING | test_empty_string_creator_name_is_also_a_violation | tests/integration/test_deep_links.py |
| 252 | PENDING | -- | PENDING | test_whitespace_only_creator_name_is_a_violation | tests/integration/test_deep_links.py |
| 253 | PENDING | -- | PENDING | test_multiple_violations_compound_penalty | tests/integration/test_deep_links.py |
| 254 | PENDING | -- | PENDING | test_compliant_bot_score_unchanged | tests/integration/test_deep_links.py |
| 255 | PENDING | -- | PENDING | test_repeated_violations_degrade_trust_to_floor | tests/integration/test_deep_links.py |
| 256 | PENDING | -- | PENDING | test_routing_reflects_degraded_trust_across_multiple_bots | tests/integration/test_deep_links.py |
| 257 | PENDING | -- | PENDING | test_routing_with_empty_candidate_list | tests/integration/test_deep_links.py |
| 258 | PENDING | -- | PENDING | test_no_recommendations_means_no_violations | tests/integration/test_deep_links.py |
| 259 | TAGGED | TST-INT-733 | PENDING | test_sponsorship_cannot_distort_ranking_order | tests/integration/test_deep_links.py |
| 260 | PENDING | -- | PENDING | test_unsponsored_low_trust_still_ranked_below_sponsored_high_trust | tests/integration/test_deep_links.py |
| 261 | PENDING | -- | PENDING | test_equal_trust_scores_sponsored_does_not_break_tie | tests/integration/test_deep_links.py |
| 262 | PENDING | -- | PENDING | test_all_sponsored_still_ranked_by_trust | tests/integration/test_deep_links.py |
| 263 | PENDING | -- | PENDING | test_five_products_mixed_sponsorship_ranked_by_trust | tests/integration/test_deep_links.py |
| 264 | PENDING | -- | PENDING | test_sponsored_flag_preserved_after_ranking | tests/integration/test_deep_links.py |
| 265 | PENDING | -- | PENDING | test_zero_trust_score_products_ranked_last | tests/integration/test_deep_links.py |
| 266 | PENDING | -- | PENDING | test_single_product_ranking | tests/integration/test_deep_links.py |
| 267 | TAGGED | TST-INT-723 | PENDING | test_deep_link_preserved_appview_to_user | tests/integration/test_deep_links.py |
| 268 | PENDING | -- | PENDING | test_deep_link_not_rewritten_to_intermediary | tests/integration/test_deep_links.py |
| 269 | PENDING | -- | PENDING | test_multiple_attestations_each_preserve_deep_link | tests/integration/test_deep_links.py |
| 270 | PENDING | -- | PENDING | test_deep_link_context_not_lost_in_assembly | tests/integration/test_deep_links.py |
| 271 | PENDING | -- | PENDING | test_deep_link_with_query_params_preserved | tests/integration/test_deep_links.py |
| 272 | PENDING | -- | PENDING | test_deep_link_empty_still_has_source_url | tests/integration/test_deep_links.py |
| 273 | PENDING | -- | PENDING | test_unicode_in_deep_link_context_preserved | tests/integration/test_deep_links.py |
| 274 | TAGGED | TST-INT-240 | PENDING | test_detects_license_expiring | tests/integration/test_delegation.py |
| 275 | TAGGED | TST-INT-296 | PENDING | test_suggests_delegation | tests/integration/test_delegation.py |
| 276 | TAGGED | TST-INT-293 | PENDING | test_user_approves_delegation | tests/integration/test_delegation.py |
| 277 | TAGGED | TST-INT-292 | PENDING | test_agent_executes_with_oversight | tests/integration/test_delegation.py |
| 278 | TAGGED | TST-INT-465 | PENDING | test_completion_reported | tests/integration/test_delegation.py |
| 279 | TAGGED | TST-INT-466 | PENDING | test_failure_handled | tests/integration/test_delegation.py |
| 280 | TAGGED | TST-INT-467 | PENDING | test_read_only_auto_approved | tests/integration/test_delegation.py |
| 281 | TAGGED | TST-INT-242 | PENDING | test_write_requires_approval | tests/integration/test_delegation.py |
| 282 | TAGGED | TST-INT-294 | PENDING | test_financial_always_flagged | tests/integration/test_delegation.py |
| 283 | TAGGED | TST-INT-468 | PENDING | test_delegation_scope_limited | tests/integration/test_delegation.py |
| 284 | TAGGED | TST-INT-058 | PENDING | test_did_exchanged_via_qr | tests/integration/test_didcomm.py |
| 285 | TAGGED | TST-INT-047 | PENDING | test_plc_lookup_resolves_endpoint | tests/integration/test_didcomm.py |
| 286 | TAGGED | TST-INT-057 | PENDING | test_plc_lookup_returns_none_for_unknown | tests/integration/test_didcomm.py |
| 287 | TAGGED | TST-INT-469 | PENDING | test_direct_home_node_connection | tests/integration/test_didcomm.py |
| 288 | TAGGED | TST-INT-046 | PENDING | test_mutual_authentication | tests/integration/test_didcomm.py |
| 289 | TAGGED | TST-INT-045 | PENDING | test_x25519_key_exchange | tests/integration/test_didcomm.py |
| 290 | TAGGED | TST-INT-070 | PENDING | test_relay_fallback_for_nat | tests/integration/test_didcomm.py |
| 291 | TAGGED | TST-INT-470 | PENDING | test_social_arrival | tests/integration/test_didcomm.py |
| 292 | TAGGED | TST-INT-054 | PENDING | test_social_departure | tests/integration/test_didcomm.py |
| 293 | TAGGED | TST-INT-471 | PENDING | test_commerce_inquiry | tests/integration/test_didcomm.py |
| 294 | TAGGED | TST-INT-472 | PENDING | test_commerce_negotiate | tests/integration/test_didcomm.py |
| 295 | TAGGED | TST-INT-473 | PENDING | test_identity_verify | tests/integration/test_didcomm.py |
| 296 | TAGGED | TST-INT-474 | PENDING | test_trust_outcome | tests/integration/test_didcomm.py |
| 297 | TAGGED | TST-INT-050 | PENDING | test_friend_sharing_rules_applied | tests/integration/test_didcomm.py |
| 298 | TAGGED | TST-INT-051 | PENDING | test_seller_sharing_rules_applied | tests/integration/test_didcomm.py |
| 299 | TAGGED | TST-INT-055 | PENDING | test_sharing_rules_enforced_cryptographically | tests/integration/test_didcomm.py |
| 300 | TAGGED | TST-INT-048 | PENDING | test_message_queued_when_peer_offline | tests/integration/test_didcomm.py |
| 301 | TAGGED | TST-INT-060 | PENDING | test_queued_message_delivered_after_authentication | tests/integration/test_didcomm.py |
| 302 | TAGGED | TST-INT-219 | PENDING | test_threshold_met_activates_estate | tests/integration/test_digital_estate.py |
| 303 | TAGGED | TST-INT-220 | PENDING | test_below_threshold_blocks_estate | tests/integration/test_digital_estate.py |
| 304 | TAGGED | TST-INT-221 | PENDING | test_invalid_share_rejected | tests/integration/test_digital_estate.py |
| 305 | TAGGED | TST-INT-232 | PENDING | test_estate_mode_notifies_beneficiaries | tests/integration/test_digital_estate.py |
| 306 | TAGGED | TST-INT-223 | PENDING | test_per_beneficiary_keys | tests/integration/test_digital_estate.py |
| 307 | TAGGED | TST-INT-228 | PENDING | test_keys_delivered_via_dina_to_dina | tests/integration/test_digital_estate.py |
| 308 | TAGGED | TST-INT-227 | PENDING | test_remaining_data_destroyed | tests/integration/test_digital_estate.py |
| 309 | TAGGED | TST-INT-224 | PENDING | test_plan_stored_in_tier_0 | tests/integration/test_digital_estate.py |
| 310 | TAGGED | TST-INT-229 | PENDING | test_manual_trigger_with_recovery_phrase | tests/integration/test_digital_estate.py |
| 311 | TAGGED | TST-INT-230 | PENDING | test_sss_custodian_coordination | tests/integration/test_digital_estate.py |
| 312 | TAGGED | TST-INT-222 | PENDING | test_beneficiary_key_derived_from_master_and_did | tests/integration/test_digital_estate.py |
| 313 | TAGGED | TST-INT-225 | PENDING | test_full_decrypt_access | tests/integration/test_digital_estate.py |
| 314 | TAGGED | TST-INT-226 | PENDING | test_read_only_90_days_access | tests/integration/test_digital_estate.py |
| 315 | TAGGED | TST-INT-231 | PENDING | test_destruction_gated_on_delivery_confirmation | tests/integration/test_digital_estate.py |
| 316 | TAGGED | TST-INT-063 | PENDING | test_sanchos_dina_notifies_arrival | tests/integration/test_dina_to_dina.py |
| 317 | TAGGED | TST-INT-475 | PENDING | test_recall_mother_was_ill | tests/integration/test_dina_to_dina.py |
| 318 | TAGGED | TST-INT-061 | PENDING | test_suggest_tea_preference | tests/integration/test_dina_to_dina.py |
| 319 | TAGGED | TST-INT-062 | PENDING | test_suggest_clearing_calendar | tests/integration/test_dina_to_dina.py |
| 320 | TAGGED | TST-INT-476 | PENDING | test_notification_is_tier_2 | tests/integration/test_dina_to_dina.py |
| 321 | TAGGED | TST-INT-477 | PENDING | test_no_notification_if_user_busy | tests/integration/test_dina_to_dina.py |
| 322 | TAGGED | TST-INT-290 | PENDING | test_end_to_end_encrypted | tests/integration/test_dina_to_dina.py |
| 323 | TAGGED | TST-INT-478 | PENDING | test_no_platform_intermediary | tests/integration/test_dina_to_dina.py |
| 324 | TAGGED | TST-INT-479 | PENDING | test_mutual_authentication_required | tests/integration/test_dina_to_dina.py |
| 325 | TAGGED | TST-INT-480 | PENDING | test_reject_unknown_did | tests/integration/test_dina_to_dina.py |
| 326 | TAGGED | TST-INT-481 | PENDING | test_accept_trusted_contact | tests/integration/test_dina_to_dina.py |
| 327 | TAGGED | TST-INT-286 | PENDING | test_no_raw_data_shared | tests/integration/test_dina_to_dina.py |
| 328 | TAGGED | TST-INT-482 | PENDING | test_buyer_contacts_seller | tests/integration/test_dina_to_dina.py |
| 329 | TAGGED | TST-INT-483 | PENDING | test_seller_sees_only_buyer_persona | tests/integration/test_dina_to_dina.py |
| 330 | TAGGED | TST-INT-484 | PENDING | test_trust_network_consulted | tests/integration/test_dina_to_dina.py |
| 331 | TAGGED | TST-INT-485 | PENDING | test_direct_transaction_no_marketplace | tests/integration/test_dina_to_dina.py |
| 332 | TAGGED | TST-INT-486 | PENDING | test_low_trust_flagged | tests/integration/test_dina_to_dina.py |
| 333 | TAGGED | TST-INT-049 | PENDING | test_sharing_policy_summary_tier | tests/integration/test_dina_to_dina.py |
| 334 | TAGGED | TST-INT-052 | PENDING | test_pii_scrub_on_egress | tests/integration/test_dina_to_dina.py |
| 335 | TAGGED | TST-INT-053 | PENDING | test_egress_audit_trail | tests/integration/test_dina_to_dina.py |
| 336 | TAGGED | TST-INT-056 | PENDING | test_spool_overflow_rejects_new_messages | tests/integration/test_dina_to_dina.py |
| 337 | TAGGED | TST-INT-059 | PENDING | test_concurrent_bidirectional_exchange | tests/integration/test_dina_to_dina.py |
| 338 | TAGGED | TST-INT-064 | PENDING | test_recipient_temporarily_down_queued | tests/integration/test_dina_to_dina.py |
| 339 | TAGGED | TST-INT-065 | PENDING | test_recipient_recovers_within_retry_window | tests/integration/test_dina_to_dina.py |
| 340 | TAGGED | TST-INT-066 | PENDING | test_recipient_down_beyond_max_retries | tests/integration/test_dina_to_dina.py |
| 341 | TAGGED | TST-INT-067 | PENDING | test_network_partition_then_heal | tests/integration/test_dina_to_dina.py |
| 342 | TAGGED | TST-INT-068 | PENDING | test_duplicate_delivery_prevention | tests/integration/test_dina_to_dina.py |
| 343 | TAGGED | TST-INT-069 | PENDING | test_relay_fallback_for_nat | tests/integration/test_dina_to_dina.py |
| 344 | TAGGED | TST-INT-085 | PENDING | test_core_can_reach_brain | tests/integration/test_docker_infra.py |
| 345 | TAGGED | TST-INT-087 | PENDING | test_brain_cannot_reach_pds | tests/integration/test_docker_infra.py |
| 346 | TAGGED | TST-INT-088 | PENDING | test_pds_cannot_reach_brain | tests/integration/test_docker_infra.py |
| 347 | TAGGED | TST-INT-091 | PENDING | test_brain_can_reach_internet_outbound | tests/integration/test_docker_infra.py |
| 348 | TAGGED | TST-INT-092 | PENDING | test_pds_on_pds_net_with_outbound | tests/integration/test_docker_infra.py |
| 349 | TAGGED | TST-INT-093 | PENDING | test_brain_can_reach_host_docker_internal | tests/integration/test_docker_infra.py |
| 350 | TAGGED | TST-INT-094 | PENDING | test_core_healthz_returns_200_when_running | tests/integration/test_docker_infra.py |
| 351 | TAGGED | TST-INT-095 | PENDING | test_core_readyz_returns_200_vault_open | tests/integration/test_docker_infra.py |
| 352 | TAGGED | TST-INT-096 | PENDING | test_core_readyz_returns_503_vault_locked | tests/integration/test_docker_infra.py |
| 353 | TAGGED | TST-INT-097 | PENDING | test_docker_restarts_unhealthy_core | tests/integration/test_docker_infra.py |
| 354 | TAGGED | TST-INT-098 | PENDING | test_brain_starts_only_after_core_healthy | tests/integration/test_docker_infra.py |
| 355 | TAGGED | TST-INT-099 | PENDING | test_pds_healthcheck_endpoint | tests/integration/test_docker_infra.py |
| 356 | TAGGED | TST-INT-100 | PENDING | test_pds_healthcheck_params | tests/integration/test_docker_infra.py |
| 357 | TAGGED | TST-INT-101 | PENDING | test_structured_json_logs_core | tests/integration/test_docker_infra.py |
| 358 | TAGGED | TST-INT-102 | PENDING | test_structured_json_logs_brain | tests/integration/test_docker_infra.py |
| 359 | TAGGED | TST-INT-103 | PENDING | test_no_pii_in_container_logs | tests/integration/test_docker_infra.py |
| 360 | TAGGED | TST-INT-104 | PENDING | test_brain_crash_traceback_in_vault | tests/integration/test_docker_infra.py |
| 361 | TAGGED | TST-INT-105 | PENDING | test_brain_crash_stdout_no_pii | tests/integration/test_docker_infra.py |
| 362 | TAGGED | TST-INT-106 | PENDING | test_docker_log_rotation_configured | tests/integration/test_docker_infra.py |
| 363 | TAGGED | TST-INT-107 | PENDING | test_zombie_state_healthcheck_endpoint_choice | tests/integration/test_docker_infra.py |
| 364 | TAGGED | TST-INT-108 | PENDING | test_security_mode_vault_locked_at_start | tests/integration/test_docker_infra.py |
| 365 | TAGGED | TST-INT-109 | PENDING | test_convenience_mode_vault_auto_unlocked | tests/integration/test_docker_infra.py |
| 366 | TAGGED | TST-INT-110 | PENDING | test_security_mode_vault_locked_dead_drop_active | tests/integration/test_docker_infra.py |
| 367 | TAGGED | TST-INT-111 | PENDING | test_security_mode_late_unlock_drains_spool | tests/integration/test_docker_infra.py |
| 368 | TAGGED | TST-INT-112 | PENDING | test_boot_order_identity_before_persona_vaults | tests/integration/test_docker_infra.py |
| 369 | TAGGED | TST-INT-113 | PENDING | test_brain_receives_vault_unlocked_event | tests/integration/test_docker_infra.py |
| 370 | TAGGED | TST-INT-114 | PENDING | test_core_depends_on_pds_started | tests/integration/test_docker_infra.py |
| 371 | TAGGED | TST-INT-115 | PENDING | test_brain_depends_on_core_healthy | tests/integration/test_docker_infra.py |
| 372 | TAGGED | TST-INT-116 | PENDING | test_brain_starts_without_core_unhealthy_retries | tests/integration/test_docker_infra.py |
| 373 | TAGGED | TST-INT-117 | PENDING | test_llm_starts_independently | tests/integration/test_docker_infra.py |
| 374 | TAGGED | TST-INT-118 | PENDING | test_full_startup_order_pds_core_brain | tests/integration/test_docker_infra.py |
| 375 | TAGGED | TST-INT-120 | PENDING | test_model_files_shared_llama_volume | tests/integration/test_docker_infra.py |
| 376 | TAGGED | TST-INT-121 | PENDING | test_secret_files_mounted_tmpfs | tests/integration/test_docker_infra.py |
| 377 | TAGGED | TST-INT-126 | PENDING | test_llama_models_dir_shared_brain_llama | tests/integration/test_docker_infra.py |
| 378 | TAGGED | TST-INT-127 | PENDING | test_creates_required_directories | tests/integration/test_docker_infra.py |
| 379 | TAGGED | TST-INT-128 | PENDING | test_generates_brain_token_on_first_run | tests/integration/test_docker_infra.py |
| 380 | TAGGED | TST-INT-129 | PENDING | test_prompts_for_passphrase_security_mode | tests/integration/test_docker_infra.py |
| 381 | TAGGED | TST-INT-130 | PENDING | test_sets_file_permissions_600_for_secrets | tests/integration/test_docker_infra.py |
| 382 | TAGGED | TST-INT-131 | PENDING | test_idempotent_rerun_does_not_overwrite_token | tests/integration/test_docker_infra.py |
| 383 | TAGGED | TST-INT-132 | PENDING | test_docker_compose_up_after_install_succeeds | tests/integration/test_docker_infra.py |
| 384 | TAGGED | TST-INT-133 | PENDING | test_secrets_never_in_docker_inspect_env | tests/integration/test_docker_infra.py |
| 385 | TAGGED | TST-INT-134 | PENDING | test_secrets_at_run_secrets_inside_container | tests/integration/test_docker_infra.py |
| 386 | TAGGED | TST-INT-135 | PENDING | test_google_api_key_in_dotenv_exception | tests/integration/test_docker_infra.py |
| 387 | TAGGED | TST-INT-136 | PENDING | test_gitignore_blocks_secrets_directory | tests/integration/test_docker_infra.py |
| 388 | TAGGED | TST-INT-137 | PENDING | test_brain_token_shared_by_core_and_brain | tests/integration/test_docker_infra.py |
| 389 | TAGGED | TST-INT-487 | PENDING | test_email_draft_created_not_sent | tests/integration/test_draft_dont_send.py |
| 390 | TAGGED | TST-INT-488 | PENDING | test_draft_has_confidence_score | tests/integration/test_draft_dont_send.py |
| 391 | TAGGED | TST-INT-489 | PENDING | test_auto_expires_72h | tests/integration/test_draft_dont_send.py |
| 392 | TAGGED | TST-INT-296 | PENDING | test_high_risk_never_drafted | tests/integration/test_draft_dont_send.py |
| 393 | TAGGED | TST-INT-490 | PENDING | test_user_reviews_before_sending | tests/integration/test_draft_dont_send.py |
| 394 | TAGGED | TST-INT-292 | PENDING | test_delegated_agent_also_drafts_only | tests/integration/test_draft_dont_send.py |
| 395 | TAGGED | TST-INT-491 | PENDING | test_upi_intent_generated | tests/integration/test_draft_dont_send.py |
| 396 | TAGGED | TST-INT-492 | PENDING | test_crypto_intent | tests/integration/test_draft_dont_send.py |
| 397 | TAGGED | TST-INT-293 | PENDING | test_web_checkout_link | tests/integration/test_draft_dont_send.py |
| 398 | TAGGED | TST-INT-493 | PENDING | test_dina_never_sees_payment_credentials | tests/integration/test_draft_dont_send.py |
| 399 | TAGGED | TST-INT-494 | PENDING | test_outcome_recorded_for_trust | tests/integration/test_draft_dont_send.py |
| 400 | TAGGED | TST-INT-726 | PENDING | test_draft_lifecycle_create_review_expire | tests/integration/test_draft_dont_send.py |
| 401 | TAGGED | TST-INT-730 | PENDING | test_concurrent_actions_independent_approval_tokens | tests/integration/test_draft_dont_send.py |
| 402 | TAGGED | TST-INT-732 | PENDING | test_approval_invalidated_on_payload_mutation | tests/integration/test_draft_dont_send.py |
| 403 | PENDING | -- | PENDING | test_unmodified_payload_sends_successfully | tests/integration/test_draft_dont_send.py |
| 404 | PENDING | -- | PENDING | test_whitespace_only_change_still_invalidates | tests/integration/test_draft_dont_send.py |
| 405 | PENDING | -- | PENDING | test_reapproval_with_new_token_succeeds | tests/integration/test_draft_dont_send.py |
| 406 | PENDING | -- | PENDING | test_different_draft_approval_not_affected | tests/integration/test_draft_dont_send.py |
| 407 | PENDING | -- | PENDING | test_empty_body_mutation_detected | tests/integration/test_draft_dont_send.py |
| 408 | PENDING | -- | PENDING | test_case_change_detected | tests/integration/test_draft_dont_send.py |
| 409 | PENDING | -- | PENDING | test_append_detected | tests/integration/test_draft_dont_send.py |
| 410 | TAGGED | TST-INT-728 | PENDING | test_agent_send_request_always_downgraded_to_draft | tests/integration/test_draft_dont_send.py |
| 411 | PENDING | -- | PENDING | test_non_send_action_not_downgraded | tests/integration/test_draft_dont_send.py |
| 412 | PENDING | -- | PENDING | test_downgraded_draft_requires_human_approval | tests/integration/test_draft_dont_send.py |
| 413 | PENDING | -- | PENDING | test_agent_cannot_mark_draft_as_sent | tests/integration/test_draft_dont_send.py |
| 414 | PENDING | -- | PENDING | test_all_send_variants_downgraded | tests/integration/test_draft_dont_send.py |
| 415 | PENDING | -- | PENDING | test_draft_body_preserves_original_content_exactly | tests/integration/test_draft_dont_send.py |
| 416 | PENDING | -- | PENDING | test_draft_gets_unique_id | tests/integration/test_draft_dont_send.py |
| 417 | PENDING | -- | PENDING | test_multiple_send_requests_each_create_separate_draft | tests/integration/test_draft_dont_send.py |
| 418 | TAGGED | TST-INT-727 | PENDING | test_cart_handover_lifecycle_create_expire | tests/integration/test_draft_dont_send.py |
| 419 | PENDING | -- | PENDING | test_cart_handover_shorter_ttl_than_draft | tests/integration/test_draft_dont_send.py |
| 420 | PENDING | -- | PENDING | test_intent_alive_before_expiry | tests/integration/test_draft_dont_send.py |
| 421 | PENDING | -- | PENDING | test_executed_intent_does_not_expire | tests/integration/test_draft_dont_send.py |
| 422 | PENDING | -- | PENDING | test_exactly_at_expiry_boundary | tests/integration/test_draft_dont_send.py |
| 423 | PENDING | -- | PENDING | test_multiple_intents_expire_independently | tests/integration/test_draft_dont_send.py |
| 424 | PENDING | -- | PENDING | test_cart_handover_preserves_payment_details | tests/integration/test_draft_dont_send.py |
| 425 | PENDING | -- | PENDING | test_zero_amount_intent_still_has_ttl | tests/integration/test_draft_dont_send.py |
| 426 | TAGGED | TST-INT-729 | PENDING | test_approval_survives_brain_crash | tests/integration/test_draft_dont_send.py |
| 427 | PENDING | -- | PENDING | test_draft_in_core_not_in_brain_memory | tests/integration/test_draft_dont_send.py |
| 428 | PENDING | -- | PENDING | test_brain_crash_does_not_auto_approve_pending_drafts | tests/integration/test_draft_dont_send.py |
| 429 | PENDING | -- | PENDING | test_brain_crash_does_not_corrupt_draft_content | tests/integration/test_draft_dont_send.py |
| 430 | PENDING | -- | PENDING | test_multiple_crashes_drafts_still_survive | tests/integration/test_draft_dont_send.py |
| 431 | PENDING | -- | PENDING | test_approval_mid_crash_recoverable | tests/integration/test_draft_dont_send.py |
| 432 | PENDING | -- | PENDING | test_expired_draft_during_crash_still_expires | tests/integration/test_draft_dont_send.py |
| 433 | TAGGED | TST-INT-013 | PENDING | test_core_exposes_vault_query | tests/integration/test_home_node.py |
| 434 | TAGGED | TST-INT-012 | PENDING | test_core_exposes_vault_store | tests/integration/test_home_node.py |
| 435 | TAGGED | TST-INT-086 | PENDING | test_core_exposes_did_sign | tests/integration/test_home_node.py |
| 436 | TAGGED | TST-INT-007 | PENDING | test_core_exposes_did_verify | tests/integration/test_home_node.py |
| 437 | TAGGED | TST-INT-082 | PENDING | test_core_exposes_pii_scrub | tests/integration/test_home_node.py |
| 438 | TAGGED | TST-INT-016 | PENDING | test_core_exposes_notify | tests/integration/test_home_node.py |
| 439 | TAGGED | TST-INT-008 | PENDING | test_brain_exposes_process | tests/integration/test_home_node.py |
| 440 | TAGGED | TST-INT-010 | PENDING | test_brain_exposes_reason | tests/integration/test_home_node.py |
| 441 | TAGGED | TST-INT-009 | PENDING | test_brain_crash_doesnt_kill_core | tests/integration/test_home_node.py |
| 442 | TAGGED | TST-INT-089 | PENDING | test_internal_api_not_exposed_externally | tests/integration/test_home_node.py |
| 443 | TAGGED | TST-INT-090 | PENDING | test_simple_lookup_uses_sqlite_no_llm | tests/integration/test_home_node.py |
| 444 | TAGGED | TST-INT-083 | PENDING | test_basic_summarization_uses_local | tests/integration/test_home_node.py |
| 445 | TAGGED | TST-INT-075 | PENDING | test_complex_reasoning_uses_cloud | tests/integration/test_home_node.py |
| 446 | TAGGED | TST-INT-081 | PENDING | test_sensitive_persona_never_uses_cloud | tests/integration/test_home_node.py |
| 447 | TAGGED | TST-INT-073 | PENDING | test_latency_sensitive_uses_on_device | tests/integration/test_home_node.py |
| 448 | TAGGED | TST-INT-078 | PENDING | test_basic_tasks_route_to_cloud | tests/integration/test_home_node.py |
| 449 | TAGGED | TST-INT-074 | PENDING | test_complex_tasks_still_cloud | tests/integration/test_home_node.py |
| 450 | TAGGED | TST-INT-077 | PENDING | test_sensitive_persona_never_cloud_even_in_online_mode | tests/integration/test_home_node.py |
| 451 | TAGGED | TST-INT-072 | PENDING | test_fts_still_no_llm_in_online_mode | tests/integration/test_home_node.py |
| 452 | TAGGED | TST-INT-001 | PENDING | test_shared_token_accepted | tests/integration/test_home_node.py |
| 453 | TAGGED | TST-INT-002 | PENDING | test_token_mismatch_rejected | tests/integration/test_home_node.py |
| 454 | TAGGED | TST-INT-003 | PENDING | test_token_rotation | tests/integration/test_home_node.py |
| 455 | TAGGED | TST-INT-004 | PENDING | test_token_file_permissions | tests/integration/test_home_node.py |
| 456 | TAGGED | TST-INT-005 | PENDING | test_forward_user_query | tests/integration/test_home_node.py |
| 457 | TAGGED | TST-INT-006 | PENDING | test_forward_inbound_d2d_message | tests/integration/test_home_node.py |
| 458 | TAGGED | TST-INT-011 | PENDING | test_read_vault_item | tests/integration/test_home_node.py |
| 459 | TAGGED | TST-INT-014 | PENDING | test_write_scratchpad | tests/integration/test_home_node.py |
| 460 | TAGGED | TST-INT-015 | PENDING | test_send_outbound_message | tests/integration/test_home_node.py |
| 461 | TAGGED | TST-INT-017 | PENDING | test_simple_query_full_ws_flow | tests/integration/test_home_node.py |
| 462 | TAGGED | TST-INT-019 | PENDING | test_streaming_response_chunks | tests/integration/test_home_node.py |
| 463 | TAGGED | TST-INT-020 | PENDING | test_query_during_brain_outage | tests/integration/test_home_node.py |
| 464 | TAGGED | TST-INT-023 | PENDING | test_heartbeat_round_trip | tests/integration/test_home_node.py |
| 465 | TAGGED | TST-INT-025 | PENDING | test_browser_login_dashboard | tests/integration/test_home_node.py |
| 466 | TAGGED | TST-INT-026 | PENDING | test_dashboard_query_response | tests/integration/test_home_node.py |
| 467 | TAGGED | TST-INT-027 | PENDING | test_session_expiry_redirect | tests/integration/test_home_node.py |
| 468 | TAGGED | TST-INT-028 | PENDING | test_full_pairing_flow | tests/integration/test_home_node.py |
| 469 | TAGGED | TST-INT-029 | PENDING | test_pairing_then_immediate_use | tests/integration/test_home_node.py |
| 470 | TAGGED | TST-INT-035 | PENDING | test_full_managed_onboarding | tests/integration/test_home_node.py |
| 471 | TAGGED | TST-INT-036 | PENDING | test_post_onboarding_system_functional | tests/integration/test_home_node.py |
| 472 | TAGGED | TST-INT-037 | PENDING | test_only_personal_persona_initially | tests/integration/test_home_node.py |
| 473 | TAGGED | TST-INT-038 | PENDING | test_day7_mnemonic_backup_prompt | tests/integration/test_home_node.py |
| 474 | TAGGED | TST-INT-039 | PENDING | test_cloud_llm_pii_consent | tests/integration/test_home_node.py |
| 475 | TAGGED | TST-INT-042 | PENDING | test_brain_restricted_creates_audit_trail | tests/integration/test_home_node.py |
| 476 | TAGGED | TST-INT-043 | PENDING | test_brain_cannot_call_admin_endpoints | tests/integration/test_home_node.py |
| 477 | TAGGED | TST-INT-071 | PENDING | test_brain_local_llm_completion | tests/integration/test_home_node.py |
| 478 | TAGGED | TST-INT-076 | PENDING | test_cloud_llm_rate_limited | tests/integration/test_home_node.py |
| 479 | TAGGED | TST-INT-079 | PENDING | test_full_tier1_tier2_pipeline | tests/integration/test_home_node.py |
| 480 | TAGGED | TST-INT-080 | PENDING | test_replacement_map_round_trip | tests/integration/test_home_node.py |
| 481 | TAGGED | TST-INT-084 | PENDING | test_tier3_absent_gracefully | tests/integration/test_home_node.py |
| 482 | TAGGED | TST-INT-236 | PENDING | test_readonly_scope | tests/integration/test_ingestion.py |
| 483 | TAGGED | TST-INT-242 | PENDING | test_polling_interval_default | tests/integration/test_ingestion.py |
| 484 | TAGGED | TST-INT-249 | PENDING | test_polling_updates_last_poll_timestamp | tests/integration/test_ingestion.py |
| 485 | TAGGED | TST-INT-251 | PENDING | test_data_encrypted_immediately | tests/integration/test_ingestion.py |
| 486 | TAGGED | TST-INT-495 | PENDING | test_persona_routing | tests/integration/test_ingestion.py |
| 487 | TAGGED | TST-INT-237 | PENDING | test_persona_routing_custom | tests/integration/test_ingestion.py |
| 488 | TAGGED | TST-INT-496 | PENDING | test_deduplication_by_message_id | tests/integration/test_ingestion.py |
| 489 | TAGGED | TST-INT-238 | PENDING | test_deduplication_across_polls | tests/integration/test_ingestion.py |
| 490 | TAGGED | TST-INT-497 | PENDING | test_items_ingested_counter | tests/integration/test_ingestion.py |
| 491 | TAGGED | TST-INT-255 | PENDING | test_uses_polling_model | tests/integration/test_ingestion.py |
| 492 | TAGGED | TST-INT-246 | PENDING | test_supports_media | tests/integration/test_ingestion.py |
| 493 | TAGGED | TST-INT-248 | PENDING | test_ingestion_requires_bot_token | tests/integration/test_ingestion.py |
| 494 | TAGGED | TST-INT-244 | PENDING | test_ingestion_succeeds_with_bot_token | tests/integration/test_ingestion.py |
| 495 | TAGGED | TST-INT-247 | PENDING | test_default_persona_is_social | tests/integration/test_ingestion.py |
| 496 | TAGGED | TST-INT-498 | PENDING | test_minimum_permission_scope_gmail | tests/integration/test_ingestion.py |
| 497 | TAGGED | TST-INT-254 | PENDING | test_oauth_tokens_encrypted_in_tier_0 | tests/integration/test_ingestion.py |
| 498 | TAGGED | TST-INT-240 | PENDING | test_connectors_sandboxed_no_cross_persona_access | tests/integration/test_ingestion.py |
| 499 | TAGGED | TST-INT-257 | PENDING | test_connector_status_visible | tests/integration/test_ingestion.py |
| 500 | TAGGED | TST-INT-499 | PENDING | test_connector_can_be_paused | tests/integration/test_ingestion.py |
| 501 | TAGGED | TST-INT-500 | PENDING | test_connector_can_be_disabled | tests/integration/test_ingestion.py |
| 502 | TAGGED | TST-INT-234 | PENDING | test_calendar_connector_defaults | tests/integration/test_ingestion.py |
| 503 | TAGGED | TST-INT-501 | PENDING | test_healthy_token_stays_active | tests/integration/test_ingestion.py |
| 504 | TAGGED | TST-INT-502 | PENDING | test_token_near_expiry_triggers_needs_refresh | tests/integration/test_ingestion.py |
| 505 | TAGGED | TST-INT-503 | PENDING | test_auto_refresh_succeeds | tests/integration/test_ingestion.py |
| 506 | TAGGED | TST-INT-504 | PENDING | test_auto_refresh_fails_transitions_to_expired | tests/integration/test_ingestion.py |
| 507 | TAGGED | TST-INT-505 | PENDING | test_expired_token_emits_tier2_notification | tests/integration/test_ingestion.py |
| 508 | TAGGED | TST-INT-241 | PENDING | test_expired_connector_returns_no_data_on_poll | tests/integration/test_ingestion.py |
| 509 | TAGGED | TST-INT-260 | PENDING | test_user_reauthorize_restores_active | tests/integration/test_ingestion.py |
| 510 | TAGGED | TST-INT-243 | PENDING | test_revoked_token_emits_notification | tests/integration/test_ingestion.py |
| 511 | TAGGED | TST-INT-506 | PENDING | test_revoked_check_token_health_stays_revoked | tests/integration/test_ingestion.py |
| 512 | TAGGED | TST-INT-507 | PENDING | test_revoked_reauthorize_restores_active | tests/integration/test_ingestion.py |
| 513 | TAGGED | TST-INT-245 | PENDING | test_no_token_set_is_expired | tests/integration/test_ingestion.py |
| 514 | TAGGED | TST-INT-508 | PENDING | test_status_transitions_logged | tests/integration/test_ingestion.py |
| 515 | TAGGED | TST-INT-509 | PENDING | test_refresh_rotates_token | tests/integration/test_ingestion.py |
| 516 | TAGGED | TST-INT-233 | PENDING | test_email_ingestion_full_pipeline | tests/integration/test_ingestion.py |
| 517 | TAGGED | TST-INT-235 | PENDING | test_contacts_sync | tests/integration/test_ingestion.py |
| 518 | TAGGED | TST-INT-239 | PENDING | test_cursor_continuity_across_restart | tests/integration/test_ingestion.py |
| 519 | TAGGED | TST-INT-250 | PENDING | test_core_never_calls_external_apis_during_ingestion | tests/integration/test_ingestion.py |
| 520 | TAGGED | TST-INT-252 | PENDING | test_openclaw_sandboxed_no_vault_access | tests/integration/test_ingestion.py |
| 521 | TAGGED | TST-INT-253 | PENDING | test_brain_scrubs_before_cloud_llm | tests/integration/test_ingestion.py |
| 522 | TAGGED | TST-INT-256 | PENDING | test_attachment_metadata_only_in_vault | tests/integration/test_ingestion.py |
| 523 | TAGGED | TST-INT-258 | PENDING | test_fast_sync_ready_in_seconds | tests/integration/test_ingestion.py |
| 524 | TAGGED | TST-INT-259 | PENDING | test_background_backfill | tests/integration/test_ingestion.py |
| 525 | TAGGED | TST-INT-261 | PENDING | test_time_horizon_enforced | tests/integration/test_ingestion.py |
| 526 | TAGGED | TST-INT-262 | PENDING | test_cold_archive_pass_through | tests/integration/test_ingestion.py |
| 527 | TAGGED | TST-INT-263 | PENDING | test_openclaw_outage_during_backfill | tests/integration/test_ingestion.py |
| 528 | TAGGED | TST-INT-281 | PENDING | test_book_promise_recall | tests/integration/test_memory_flows.py |
| 529 | TAGGED | TST-INT-282 | PENDING | test_emotion_indexed_search | tests/integration/test_memory_flows.py |
| 530 | TAGGED | TST-INT-275 | PENDING | test_memory_survives_sessions | tests/integration/test_memory_flows.py |
| 531 | TAGGED | TST-INT-274 | PENDING | test_encrypted_at_rest | tests/integration/test_memory_flows.py |
| 532 | TAGGED | TST-INT-280 | PENDING | test_searchable_by_meaning | tests/integration/test_memory_flows.py |
| 533 | TAGGED | TST-INT-510 | PENDING | test_raw_memory_never_sent_to_bots | tests/integration/test_memory_flows.py |
| 534 | TAGGED | TST-INT-511 | PENDING | test_deletion_is_permanent | tests/integration/test_memory_flows.py |
| 535 | TAGGED | TST-INT-512 | PENDING | test_not_accessible_by_other_personas | tests/integration/test_memory_flows.py |
| 536 | TAGGED | TST-INT-513 | PENDING | test_email_read_only | tests/integration/test_memory_flows.py |
| 537 | TAGGED | TST-INT-276 | PENDING | test_calendar_indexed | tests/integration/test_memory_flows.py |
| 538 | TAGGED | TST-INT-277 | PENDING | test_chat_ingestion | tests/integration/test_memory_flows.py |
| 539 | TAGGED | TST-INT-324 | PENDING | test_schema_migration_on_upgrade | tests/integration/test_migration.py |
| 540 | TAGGED | TST-INT-325 | PENDING | test_data_preserved_across_upgrade | tests/integration/test_migration.py |
| 541 | TAGGED | TST-INT-326 | PENDING | test_rollback_after_failed_migration | tests/integration/test_migration.py |
| 542 | TAGGED | TST-INT-327 | PENDING | test_config_format_change | tests/integration/test_migration.py |
| 543 | TAGGED | TST-INT-333 | PENDING | test_schema_migration_identity_sqlite | tests/integration/test_migration.py |
| 544 | TAGGED | TST-INT-334 | PENDING | test_schema_migration_persona_vault | tests/integration/test_migration.py |
| 545 | TAGGED | TST-INT-335 | PENDING | test_schema_migration_partial_failure | tests/integration/test_migration.py |
| 546 | TAGGED | TST-INT-336 | PENDING | test_fts5_rebuild_after_schema_change | tests/integration/test_migration.py |
| 547 | TAGGED | TST-INT-328 | PENDING | test_export_import_roundtrip | tests/integration/test_migration.py |
| 548 | TAGGED | TST-INT-329 | PENDING | test_export_import_preserves_did_identity | tests/integration/test_migration.py |
| 549 | TAGGED | TST-INT-332 | PENDING | test_import_rejects_tampered_archive | tests/integration/test_migration.py |
| 550 | TAGGED | TST-INT-330 | PENDING | test_migration_between_hosting_levels | tests/integration/test_migration.py |
| 551 | TAGGED | TST-INT-331 | PENDING | test_same_docker_image_across_hosting_levels | tests/integration/test_migration.py |
| 552 | TAGGED | TST-INT-337 | PENDING | test_import_invalidates_all_device_tokens | tests/integration/test_migration.py |
| 553 | TAGGED | TST-INT-514 | PENDING | test_direct_purchase_via_open_protocol | tests/integration/test_open_economy.py |
| 554 | TAGGED | TST-INT-290 | PENDING | test_walled_garden_still_option | tests/integration/test_open_economy.py |
| 555 | TAGGED | TST-INT-515 | PENDING | test_negotiates_with_seller | tests/integration/test_open_economy.py |
| 556 | TAGGED | TST-INT-516 | PENDING | test_logistics_via_separate_dina | tests/integration/test_open_economy.py |
| 557 | TAGGED | TST-INT-291 | PENDING | test_maker_earns_by_quality | tests/integration/test_open_economy.py |
| 558 | TAGGED | TST-INT-311 | PENDING | test_bot_operator_earns_by_accuracy | tests/integration/test_open_economy.py |
| 559 | TAGGED | TST-INT-312 | PENDING | test_expert_earns_by_trust | tests/integration/test_open_economy.py |
| 560 | TAGGED | TST-INT-517 | PENDING | test_protocol_earns_nothing | tests/integration/test_open_economy.py |
| 561 | TAGGED | TST-INT-518 | PENDING | test_buyer_seller_logistics_three_party | tests/integration/test_open_economy.py |
| 562 | TAGGED | TST-INT-519 | PENDING | test_group_purchase | tests/integration/test_open_economy.py |
| 563 | TAGGED | TST-INT-520 | PENDING | test_dispute_resolution | tests/integration/test_open_economy.py |
| 564 | TAGGED | TST-INT-338 | PENDING | test_concurrent_websocket_connections | tests/integration/test_performance.py |
| 565 | TAGGED | TST-INT-339 | PENDING | test_vault_write_throughput | tests/integration/test_performance.py |
| 566 | TAGGED | TST-INT-340 | PENDING | test_vault_search_under_load | tests/integration/test_performance.py |
| 567 | TAGGED | TST-INT-341 | PENDING | test_inbound_message_handling | tests/integration/test_performance.py |
| 568 | TAGGED | TST-INT-342 | PENDING | test_outbox_drain_rate | tests/integration/test_performance.py |
| 569 | TAGGED | TST-INT-343 | PENDING | test_query_to_response_local_llm | tests/integration/test_performance.py |
| 570 | TAGGED | TST-INT-344 | PENDING | test_query_to_response_cloud_llm | tests/integration/test_performance.py |
| 571 | TAGGED | TST-INT-345 | PENDING | test_message_send_latency | tests/integration/test_performance.py |
| 572 | TAGGED | TST-INT-346 | PENDING | test_pairing_completion_latency | tests/integration/test_performance.py |
| 573 | TAGGED | TST-INT-347 | PENDING | test_core_memory_usage | tests/integration/test_performance.py |
| 574 | TAGGED | TST-INT-348 | PENDING | test_brain_memory_usage | tests/integration/test_performance.py |
| 575 | TAGGED | TST-INT-349 | PENDING | test_llm_memory_usage | tests/integration/test_performance.py |
| 576 | TAGGED | TST-INT-350 | PENDING | test_disk_usage_growth | tests/integration/test_performance.py |
| 577 | TAGGED | TST-INT-351 | PENDING | test_spool_disk_usage | tests/integration/test_performance.py |
| 578 | PENDING | -- | PENDING | test_create_with_valid_tiers | tests/integration/test_persona_tiers.py |
| 579 | PENDING | -- | PENDING | test_reject_legacy_tiers | tests/integration/test_persona_tiers.py |
| 580 | PENDING | -- | PENDING | test_default_persona_vault_auto_opens | tests/integration/test_persona_tiers.py |
| 581 | PENDING | -- | PENDING | test_standard_persona_vault_auto_opens | tests/integration/test_persona_tiers.py |
| 582 | PENDING | -- | PENDING | test_session_start | tests/integration/test_persona_tiers.py |
| 583 | PENDING | -- | PENDING | test_session_reconnect | tests/integration/test_persona_tiers.py |
| 584 | PENDING | -- | PENDING | test_session_list | tests/integration/test_persona_tiers.py |
| 585 | PENDING | -- | PENDING | test_session_end | tests/integration/test_persona_tiers.py |
| 586 | PENDING | -- | PENDING | test_list_pending_approvals | tests/integration/test_persona_tiers.py |
| 587 | PENDING | -- | PENDING | test_deny_nonexistent_returns_404 | tests/integration/test_persona_tiers.py |
| 588 | PENDING | -- | PENDING | test_query_general_persona_succeeds | tests/integration/test_persona_tiers.py |
| 589 | PENDING | -- | PENDING | test_query_standard_persona_succeeds_for_admin | tests/integration/test_persona_tiers.py |
| 590 | PENDING | -- | PENDING | test_query_locked_persona_returns_403 | tests/integration/test_persona_tiers.py |
| 591 | PENDING | -- | PENDING | test_session_scoped_to_device_id | tests/integration/test_persona_tiers.py |
| 592 | PENDING | -- | PENDING | test_vault_read_blocked_by_authz | tests/integration/test_persona_tiers.py |
| 593 | PENDING | -- | PENDING | test_staging_ingest_allowed | tests/integration/test_persona_tiers.py |
| 594 | PENDING | -- | PENDING | test_reason_endpoint_not_blocked | tests/integration/test_persona_tiers.py |
| 595 | PENDING | -- | PENDING | test_device_uses_staging_not_vault_store | tests/integration/test_persona_tiers.py |
| 596 | PENDING | -- | PENDING | test_brain_read_approval_lifecycle | tests/integration/test_persona_tiers.py |
| 597 | TAGGED | TST-INT-521 | PENDING | test_root_identity_generates_consumer_persona | tests/integration/test_personas.py |
| 598 | TAGGED | TST-INT-033 | PENDING | test_root_identity_generates_health_persona | tests/integration/test_personas.py |
| 599 | TAGGED | TST-INT-522 | PENDING | test_root_identity_generates_legal_persona | tests/integration/test_personas.py |
| 600 | TAGGED | TST-INT-159 | PENDING | test_seller_interaction_gets_own_persona | tests/integration/test_personas.py |
| 601 | TAGGED | TST-INT-161 | PENDING | test_each_persona_has_unique_key_derivation | tests/integration/test_personas.py |
| 602 | TAGGED | TST-INT-523 | PENDING | test_persona_derivation_is_deterministic | tests/integration/test_personas.py |
| 603 | TAGGED | TST-INT-034 | PENDING | test_different_roots_produce_different_personas | tests/integration/test_personas.py |
| 604 | TAGGED | TST-INT-031 | PENDING | test_seller_cannot_see_health_data | tests/integration/test_personas.py |
| 605 | TAGGED | TST-INT-032 | PENDING | test_health_bot_cannot_see_purchases | tests/integration/test_personas.py |
| 606 | TAGGED | TST-INT-164 | PENDING | test_cross_persona_requires_authorization | tests/integration/test_personas.py |
| 607 | TAGGED | TST-INT-157 | PENDING | test_malicious_system_cannot_jailbreak_persona | tests/integration/test_personas.py |
| 608 | TAGGED | TST-INT-160 | PENDING | test_persona_keys_derived_from_root | tests/integration/test_personas.py |
| 609 | TAGGED | TST-INT-162 | PENDING | test_vault_partition_naming_matches_persona_type | tests/integration/test_personas.py |
| 610 | TAGGED | TST-INT-524 | PENDING | test_buying_chair_uses_consumer_persona | tests/integration/test_personas.py |
| 611 | TAGGED | TST-INT-525 | PENDING | test_license_renewal_uses_legal_persona | tests/integration/test_personas.py |
| 612 | TAGGED | TST-INT-158 | PENDING | test_doctor_visit_uses_health_persona | tests/integration/test_personas.py |
| 613 | TAGGED | TST-INT-526 | PENDING | test_auto_selection_by_context_product_query | tests/integration/test_personas.py |
| 614 | TAGGED | TST-INT-527 | PENDING | test_auto_selection_by_context_medical_query | tests/integration/test_personas.py |
| 615 | TAGGED | TST-INT-528 | PENDING | test_financial_persona_also_routes_locally | tests/integration/test_personas.py |
| 616 | TAGGED | TST-INT-156 | PENDING | test_persona_data_survives_across_sessions | tests/integration/test_personas.py |
| 617 | TAGGED | TST-INT-365 | PENDING | test_home_node_available_when_clients_offline | tests/integration/test_phase2.py |
| 618 | TAGGED | TST-INT-366 | PENDING | test_client_offline_no_effect_on_home_node | tests/integration/test_phase2.py |
| 619 | TAGGED | TST-INT-372 | PENDING | test_multiple_rich_clients_sync_consistently | tests/integration/test_phase2.py |
| 620 | TAGGED | TST-INT-373 | PENDING | test_checkpoint_mechanism | tests/integration/test_phase2.py |
| 621 | TAGGED | TST-INT-375 | PENDING | test_conflict_resolution_last_write_wins | tests/integration/test_phase2.py |
| 622 | TAGGED | TST-INT-376 | PENDING | test_conflict_resolution_flagged_for_review | tests/integration/test_phase2.py |
| 623 | TAGGED | TST-INT-377 | PENDING | test_most_data_append_only | tests/integration/test_phase2.py |
| 624 | TAGGED | TST-INT-382 | PENDING | test_enclave_attestation_verified_by_client | tests/integration/test_phase2.py |
| 625 | TAGGED | TST-INT-383 | PENDING | test_host_root_cannot_read_enclave_memory | tests/integration/test_phase2.py |
| 626 | TAGGED | TST-INT-384 | PENDING | test_enclave_sealed_keys | tests/integration/test_phase2.py |
| 627 | TAGGED | TST-INT-385 | PENDING | test_day_1_email_calendar_basic_nudges | tests/integration/test_phase2.py |
| 628 | TAGGED | TST-INT-386 | PENDING | test_day_7_mnemonic_backup_prompt | tests/integration/test_phase2.py |
| 629 | TAGGED | TST-INT-387 | PENDING | test_day_14_telegram_connector_prompt | tests/integration/test_phase2.py |
| 630 | TAGGED | TST-INT-388 | PENDING | test_day_30_persona_compartments_prompt | tests/integration/test_phase2.py |
| 631 | TAGGED | TST-INT-389 | PENDING | test_month_3_power_user_discovery | tests/integration/test_phase2.py |
| 632 | TAGGED | TST-INT-390 | PENDING | test_profile_local_llm_adds_llama_container | tests/integration/test_phase2.py |
| 633 | TAGGED | TST-INT-391 | PENDING | test_without_profile_three_containers_only | tests/integration/test_phase2.py |
| 634 | TAGGED | TST-INT-392 | PENDING | test_brain_routes_to_llama_when_available | tests/integration/test_phase2.py |
| 635 | TAGGED | TST-INT-393 | PENDING | test_brain_falls_back_to_cloud_when_llama_absent | tests/integration/test_phase2.py |
| 636 | TAGGED | TST-INT-394 | PENDING | test_pii_scrubbing_without_llama_cloud_mode | tests/integration/test_phase2.py |
| 637 | TAGGED | TST-INT-395 | PENDING | test_community_tier_tailscale_funnel | tests/integration/test_phase2.py |
| 638 | TAGGED | TST-INT-396 | PENDING | test_production_tier_cloudflare_tunnel | tests/integration/test_phase2.py |
| 639 | TAGGED | TST-INT-397 | PENDING | test_sovereign_tier_yggdrasil_ipv6 | tests/integration/test_phase2.py |
| 640 | TAGGED | TST-INT-398 | PENDING | test_tier_change_triggers_did_rotation | tests/integration/test_phase2.py |
| 641 | TAGGED | TST-INT-399 | PENDING | test_multiple_tiers_simultaneously | tests/integration/test_phase2.py |
| 642 | TAGGED | TST-INT-400 | PENDING | test_foundation_relay_wildcard | tests/integration/test_phase2.py |
| 643 | TAGGED | TST-INT-401 | PENDING | test_noise_xx_handshake_mutual_authentication | tests/integration/test_phase2.py |
| 644 | TAGGED | TST-INT-402 | PENDING | test_key_compromise_does_not_expose_past_messages | tests/integration/test_phase2.py |
| 645 | TAGGED | TST-INT-403 | PENDING | test_session_ratchet_key_rotates | tests/integration/test_phase2.py |
| 646 | TAGGED | TST-INT-404 | PENDING | test_firehose_consumer_filters_correctly | tests/integration/test_phase2.py |
| 647 | TAGGED | TST-INT-405 | PENDING | test_cryptographic_verification_on_every_record | tests/integration/test_phase2.py |
| 648 | TAGGED | TST-INT-406 | PENDING | test_query_api_trust_by_did | tests/integration/test_phase2.py |
| 649 | TAGGED | TST-INT-407 | PENDING | test_query_api_product_trust | tests/integration/test_phase2.py |
| 650 | TAGGED | TST-INT-408 | PENDING | test_query_api_bot_scores | tests/integration/test_phase2.py |
| 651 | TAGGED | TST-INT-409 | PENDING | test_signed_payloads_in_api_responses | tests/integration/test_phase2.py |
| 652 | TAGGED | TST-INT-410 | PENDING | test_aggregate_scores_deterministic | tests/integration/test_phase2.py |
| 653 | TAGGED | TST-INT-411 | PENDING | test_cursor_tracking_crash_recovery | tests/integration/test_phase2.py |
| 654 | TAGGED | TST-INT-412 | PENDING | test_layer_1_cryptographic_proof | tests/integration/test_phase2.py |
| 655 | TAGGED | TST-INT-413 | PENDING | test_layer_2_consensus_check | tests/integration/test_phase2.py |
| 656 | TAGGED | TST-INT-414 | PENDING | test_layer_3_direct_pds_spot_check | tests/integration/test_phase2.py |
| 657 | TAGGED | TST-INT-415 | PENDING | test_dishonest_appview_abandoned | tests/integration/test_phase2.py |
| 658 | TAGGED | TST-INT-416 | PENDING | test_merkle_root_hash_to_l2 | tests/integration/test_phase2.py |
| 659 | TAGGED | TST-INT-417 | PENDING | test_merkle_proof_verification | tests/integration/test_phase2.py |
| 660 | TAGGED | TST-INT-418 | PENDING | test_merkle_root_reveals_nothing | tests/integration/test_phase2.py |
| 661 | TAGGED | TST-INT-419 | PENDING | test_deletion_and_anchoring_compatible | tests/integration/test_phase2.py |
| 662 | TAGGED | TST-INT-420 | PENDING | test_bot_query_format | tests/integration/test_phase2.py |
| 663 | TAGGED | TST-INT-421 | PENDING | test_bot_signature_verification | tests/integration/test_phase2.py |
| 664 | TAGGED | TST-INT-422 | PENDING | test_attribution_mandatory | tests/integration/test_phase2.py |
| 665 | TAGGED | TST-INT-423 | PENDING | test_deep_link_pattern_default | tests/integration/test_phase2.py |
| 666 | TAGGED | TST-INT-424 | PENDING | test_bot_trust_auto_route_on_low_score | tests/integration/test_phase2.py |
| 667 | TAGGED | TST-INT-425 | PENDING | test_bot_trust_scoring_factors | tests/integration/test_phase2.py |
| 668 | TAGGED | TST-INT-426 | PENDING | test_bot_discovery_decentralized_registry | tests/integration/test_phase2.py |
| 669 | TAGGED | TST-INT-427 | PENDING | test_bot_to_bot_recommendation | tests/integration/test_phase2.py |
| 670 | TAGGED | TST-INT-428 | PENDING | test_requester_anonymity_trust_ring_only | tests/integration/test_phase2.py |
| 671 | TAGGED | TST-INT-429 | PENDING | test_android_fcm_wake_only_push | tests/integration/test_phase2.py |
| 672 | TAGGED | TST-INT-430 | PENDING | test_ios_apns_wake_only_push | tests/integration/test_phase2.py |
| 673 | TAGGED | TST-INT-431 | PENDING | test_push_payload_contains_no_user_data | tests/integration/test_phase2.py |
| 674 | TAGGED | TST-INT-432 | PENDING | test_push_suppressed_when_ws_active | tests/integration/test_phase2.py |
| 675 | TAGGED | TST-INT-433 | PENDING | test_unified_push_no_google_dependency | tests/integration/test_phase2.py |
| 676 | TAGGED | TST-INT-434 | PENDING | test_cloud_profile_three_containers | tests/integration/test_phase2.py |
| 677 | TAGGED | TST-INT-435 | PENDING | test_local_llm_profile_four_containers | tests/integration/test_phase2.py |
| 678 | TAGGED | TST-INT-436 | PENDING | test_profile_switch_cloud_to_local | tests/integration/test_phase2.py |
| 679 | TAGGED | TST-INT-437 | PENDING | test_profile_switch_local_to_cloud | tests/integration/test_phase2.py |
| 680 | TAGGED | TST-INT-438 | PENDING | test_always_local_guarantees | tests/integration/test_phase2.py |
| 681 | TAGGED | TST-INT-439 | PENDING | test_sensitive_persona_rule_enforced | tests/integration/test_phase2.py |
| 682 | TAGGED | TST-INT-529 | PENDING | test_name_scrubbed | tests/integration/test_pii_scrubber.py |
| 683 | TAGGED | TST-INT-530 | PENDING | test_email_scrubbed | tests/integration/test_pii_scrubber.py |
| 684 | TAGGED | TST-INT-531 | PENDING | test_address_scrubbed | tests/integration/test_pii_scrubber.py |
| 685 | TAGGED | TST-INT-532 | PENDING | test_phone_scrubbed | tests/integration/test_pii_scrubber.py |
| 686 | TAGGED | TST-INT-533 | PENDING | test_financial_data_scrubbed | tests/integration/test_pii_scrubber.py |
| 687 | TAGGED | TST-INT-152 | PENDING | test_health_data_scrubbed | tests/integration/test_pii_scrubber.py |
| 688 | TAGGED | TST-INT-082 | PENDING | test_scrubbed_query_still_useful | tests/integration/test_pii_scrubber.py |
| 689 | TAGGED | TST-INT-151 | PENDING | test_bot_receives_question_not_data | tests/integration/test_pii_scrubber.py |
| 690 | TAGGED | TST-INT-534 | PENDING | test_response_comes_back_clean | tests/integration/test_pii_scrubber.py |
| 691 | TAGGED | TST-INT-081 | PENDING | test_no_data_exfiltration_via_prompt_injection | tests/integration/test_pii_scrubber.py |
| 692 | TAGGED | TST-INT-166 | PENDING | test_safe_task_auto_approves | tests/integration/test_safety_layer.py |
| 693 | TAGGED | TST-INT-538 | PENDING | test_email_send_requires_approval | tests/integration/test_safety_layer.py |
| 694 | TAGGED | TST-INT-539 | PENDING | test_email_denied | tests/integration/test_safety_layer.py |
| 695 | TAGGED | TST-INT-540 | PENDING | test_money_transfer_requires_approval | tests/integration/test_safety_layer.py |
| 696 | TAGGED | TST-INT-541 | PENDING | test_data_sharing_requires_approval | tests/integration/test_safety_layer.py |
| 697 | TAGGED | TST-INT-041 | PENDING | test_untrusted_vendor_blocked | tests/integration/test_safety_layer.py |
| 698 | TAGGED | TST-INT-040 | PENDING | test_agent_never_holds_keys | tests/integration/test_safety_layer.py |
| 699 | TAGGED | TST-INT-169 | PENDING | test_agent_never_sees_full_history | tests/integration/test_safety_layer.py |
| 700 | TAGGED | TST-INT-542 | PENDING | test_multiple_agents_same_task | tests/integration/test_safety_layer.py |
| 701 | TAGGED | TST-INT-044 | PENDING | test_credentials_never_exposed | tests/integration/test_safety_layer.py |
| 702 | TAGGED | TST-INT-543 | PENDING | test_agent_accepts_no_external_commands | tests/integration/test_safety_layer.py |
| 703 | TAGGED | TST-INT-168 | PENDING | test_session_tokens_expire | tests/integration/test_safety_layer.py |
| 704 | TAGGED | TST-INT-544 | PENDING | test_agent_crashes_mid_task | tests/integration/test_safety_layer.py |
| 705 | TAGGED | TST-INT-545 | PENDING | test_concurrent_conflicting_actions | tests/integration/test_safety_layer.py |
| 706 | TAGGED | TST-INT-546 | PENDING | test_privilege_escalation_attempt | tests/integration/test_safety_layer.py |
| 707 | TAGGED | TST-INT-167 | PENDING | test_offline_queued_actions | tests/integration/test_safety_layer.py |
| 708 | TAGGED | TST-INT-699 | PENDING | test_agent_crash_does_not_leak_partial_results | tests/integration/test_safety_layer.py |
| 709 | PENDING | -- | PENDING | test_successful_agent_execution_does_produce_results | tests/integration/test_safety_layer.py |
| 710 | PENDING | -- | PENDING | test_error_response_contains_no_pii_patterns | tests/integration/test_safety_layer.py |
| 711 | PENDING | -- | PENDING | test_sensitive_context_in_task_dict_stripped_on_crash | tests/integration/test_safety_layer.py |
| 712 | PENDING | -- | PENDING | test_crashing_agent_does_not_affect_other_agent | tests/integration/test_safety_layer.py |
| 713 | PENDING | -- | PENDING | test_agent_recovers_after_crash | tests/integration/test_safety_layer.py |
| 714 | TAGGED | TST-INT-697 | PENDING | test_agent_revocation_propagates_from_core_to_brain | tests/integration/test_safety_layer.py |
| 715 | TAGGED | TST-INT-696 | PENDING | test_agent_intent_logged_in_audit_trail | tests/integration/test_safety_layer.py |
| 716 | PENDING | -- | PENDING | test_denied_intent_also_logged | tests/integration/test_safety_layer.py |
| 717 | PENDING | -- | PENDING | test_auto_approved_intent_logged | tests/integration/test_safety_layer.py |
| 718 | PENDING | -- | PENDING | test_blocked_intent_logged | tests/integration/test_safety_layer.py |
| 719 | PENDING | -- | PENDING | test_multiple_intents_all_logged_in_order | tests/integration/test_safety_layer.py |
| 720 | PENDING | -- | PENDING | test_audit_entry_has_all_required_fields | tests/integration/test_safety_layer.py |
| 721 | TAGGED | TST-INT-803 | PENDING | test_audit_timestamp_is_reasonable | tests/integration/test_safety_layer.py |
| 722 | PENDING | -- | PENDING | test_audit_log_preserves_agent_did_exactly | tests/integration/test_safety_layer.py |
| 723 | PENDING | -- | PENDING | test_different_agents_different_audit_entries | tests/integration/test_safety_layer.py |
| 724 | TAGGED | TST-INT-695 | PENDING | test_agent_queries_only_permitted_personas | tests/integration/test_safety_layer.py |
| 725 | PENDING | -- | PENDING | test_agent_can_query_open_personas | tests/integration/test_safety_layer.py |
| 726 | PENDING | -- | PENDING | test_agent_cannot_query_financial_persona | tests/integration/test_safety_layer.py |
| 727 | PENDING | -- | PENDING | test_health_data_not_in_error_message | tests/integration/test_safety_layer.py |
| 728 | PENDING | -- | PENDING | test_agent_with_explicit_health_grant | tests/integration/test_safety_layer.py |
| 729 | PENDING | -- | PENDING | test_multiple_persona_queries_mixed | tests/integration/test_safety_layer.py |
| 730 | PENDING | -- | PENDING | test_empty_allowed_personas_blocks_all | tests/integration/test_safety_layer.py |
| 731 | PENDING | -- | PENDING | test_query_nonexistent_persona_data_returns_empty | tests/integration/test_safety_layer.py |
| 732 | TAGGED | TST-INT-698 | PENDING | test_agent_cannot_access_another_users_data | tests/integration/test_safety_layer.py |
| 733 | PENDING | -- | PENDING | test_agent_can_access_own_users_data | tests/integration/test_safety_layer.py |
| 734 | PENDING | -- | PENDING | test_cross_user_error_does_not_leak_target_data | tests/integration/test_safety_layer.py |
| 735 | PENDING | -- | PENDING | test_user_b_data_unaffected_by_failed_access | tests/integration/test_safety_layer.py |
| 736 | PENDING | -- | PENDING | test_agent_with_similar_did_still_blocked | tests/integration/test_safety_layer.py |
| 737 | PENDING | -- | PENDING | test_multiple_users_strict_isolation | tests/integration/test_safety_layer.py |
| 738 | PENDING | -- | PENDING | test_empty_target_vault_still_returns_403 | tests/integration/test_safety_layer.py |
| 739 | PENDING | -- | PENDING | test_agent_owner_did_must_match_exactly | tests/integration/test_safety_layer.py |
| 740 | TAGGED | TST-INT-153 | PENDING | test_vault_dek_never_leaves_core | tests/integration/test_security.py |
| 741 | TAGGED | TST-INT-154 | PENDING | test_master_seed_never_transmitted | tests/integration/test_security.py |
| 742 | TAGGED | TST-INT-155 | PENDING | test_agent_never_sees_full_vault | tests/integration/test_security.py |
| 743 | TAGGED | TST-INT-163 | PENDING | test_get_personas_for_contact_excludes_locked | tests/integration/test_security.py |
| 744 | TAGGED | TST-INT-165 | PENDING | test_no_unauthenticated_api_access | tests/integration/test_security.py |
| 745 | TAGGED | TST-INT-170 | PENDING | test_port_scan_only_expected_ports_exposed | tests/integration/test_security.py |
| 746 | TAGGED | TST-INT-171 | PENDING | test_brain_not_accessible_from_outside_docker | tests/integration/test_security.py |
| 747 | TAGGED | TST-INT-172 | PENDING | test_inter_container_isolation | tests/integration/test_security.py |
| 748 | TAGGED | TST-INT-173 | PENDING | test_rate_limiting_on_public_endpoint | tests/integration/test_security.py |
| 749 | TAGGED | TST-INT-174 | PENDING | test_tls_certificate_validation | tests/integration/test_security.py |
| 750 | TAGGED | TST-INT-176 | PENDING | test_replay_attack_prevention | tests/integration/test_security.py |
| 751 | TAGGED | TST-INT-177 | PENDING | test_did_spoofing_rejected | tests/integration/test_security.py |
| 752 | TAGGED | TST-INT-179 | PENDING | test_forward_secrecy_key_ratchet | tests/integration/test_security.py |
| 753 | TAGGED | TST-INT-180 | PENDING | test_did_plc_rotation_preserves_did | tests/integration/test_security.py |
| 754 | TAGGED | TST-INT-181 | PENDING | test_did_plc_to_did_web_escape | tests/integration/test_security.py |
| 755 | TAGGED | TST-INT-185 | PENDING | test_no_plaintext_in_container_temp_directories | tests/integration/test_security.py |
| 756 | TAGGED | TST-INT-186 | PENDING | test_no_plaintext_in_docker_layer_cache | tests/integration/test_security.py |
| 757 | TAGGED | TST-INT-191 | PENDING | test_per_user_sqlite_isolation | tests/integration/test_security.py |
| 758 | TAGGED | TST-INT-192 | PENDING | test_user_a_compromise_doesnt_expose_user_b | tests/integration/test_security.py |
| 759 | TAGGED | TST-INT-193 | PENDING | test_no_shared_state_between_user_containers | tests/integration/test_security.py |
| 760 | TAGGED | TST-INT-194 | PENDING | test_container_escape_doesnt_grant_vault_access | tests/integration/test_security.py |
| 761 | TAGGED | TST-INT-196 | PENDING | test_different_hkdf_info_different_dek | tests/integration/test_security.py |
| 762 | TAGGED | TST-INT-200 | PENDING | test_key_wrapping_roundtrip | tests/integration/test_security.py |
| 763 | TAGGED | TST-INT-205 | PENDING | test_user_salt_uniqueness_across_nodes | tests/integration/test_security.py |
| 764 | TAGGED | TST-INT-212 | PENDING | test_pre_flight_backup_before_migration | tests/integration/test_security.py |
| 765 | TAGGED | TST-INT-214 | PENDING | test_vacuum_into_never_used | tests/integration/test_security.py |
| 766 | TAGGED | TST-INT-215 | PENDING | test_ci_plaintext_detection | tests/integration/test_security.py |
| 767 | TAGGED | TST-INT-547 | PENDING | test_malicious_contract_interrupts | tests/integration/test_silence_tiers.py |
| 768 | TAGGED | TST-INT-268 | PENDING | test_phishing_interrupts | tests/integration/test_silence_tiers.py |
| 769 | TAGGED | TST-INT-548 | PENDING | test_fiduciary_overrides_dnd | tests/integration/test_silence_tiers.py |
| 770 | TAGGED | TST-INT-549 | PENDING | test_financial_fraud_detection | tests/integration/test_silence_tiers.py |
| 771 | TAGGED | TST-INT-550 | PENDING | test_alarm_notification | tests/integration/test_silence_tiers.py |
| 772 | TAGGED | TST-INT-551 | PENDING | test_price_alert | tests/integration/test_silence_tiers.py |
| 773 | TAGGED | TST-INT-552 | PENDING | test_respects_timing | tests/integration/test_silence_tiers.py |
| 774 | TAGGED | TST-INT-553 | PENDING | test_search_results_ready | tests/integration/test_silence_tiers.py |
| 775 | TAGGED | TST-INT-554 | PENDING | test_new_video_saved_for_briefing | tests/integration/test_silence_tiers.py |
| 776 | TAGGED | TST-INT-555 | PENDING | test_flash_sale_saved | tests/integration/test_silence_tiers.py |
| 777 | TAGGED | TST-INT-556 | PENDING | test_daily_briefing_aggregates | tests/integration/test_silence_tiers.py |
| 778 | TAGGED | TST-INT-557 | PENDING | test_tier_3_never_interrupts | tests/integration/test_silence_tiers.py |
| 779 | TAGGED | TST-INT-558 | PENDING | test_assigns_correct_tier | tests/integration/test_silence_tiers.py |
| 780 | TAGGED | TST-INT-265 | PENDING | test_if_silent_causes_harm_speak | tests/integration/test_silence_tiers.py |
| 781 | TAGGED | TST-INT-559 | PENDING | test_user_can_override_tier | tests/integration/test_silence_tiers.py |
| 782 | TAGGED | TST-INT-560 | PENDING | test_context_affects_classification | tests/integration/test_silence_tiers.py |
| 783 | TAGGED | TST-INT-709 | PENDING | test_engagement_event_ingestion_briefing_only | tests/integration/test_silence_tiers.py |
| 784 | TAGGED | TST-INT-708 | PENDING | test_fiduciary_event_ingestion_to_interrupt | tests/integration/test_silence_tiers.py |
| 785 | PENDING | -- | PENDING | test_fiduciary_not_queued_for_briefing | tests/integration/test_silence_tiers.py |
| 786 | PENDING | -- | PENDING | test_engagement_event_not_pushed_as_interrupt | tests/integration/test_silence_tiers.py |
| 787 | PENDING | -- | PENDING | test_fiduciary_push_logged_in_core_api_calls | tests/integration/test_silence_tiers.py |
| 788 | PENDING | -- | PENDING | test_user_receives_fiduciary_before_any_engagement | tests/integration/test_silence_tiers.py |
| 789 | PENDING | -- | PENDING | test_multiple_fiduciary_events_all_pushed | tests/integration/test_silence_tiers.py |
| 790 | PENDING | -- | PENDING | test_fiduciary_event_content_preserved_in_notification | tests/integration/test_silence_tiers.py |
| 791 | PENDING | -- | PENDING | test_fiduciary_classification_reason_is_keyword_match | tests/integration/test_silence_tiers.py |
| 792 | TAGGED | TST-INT-731 | PENDING | test_reclassification_on_later_corroboration | tests/integration/test_silence_tiers.py |
| 793 | TAGGED | TST-INT-713 | PENDING | test_untrusted_sender_urgency_not_fiduciary | tests/integration/test_silence_tiers.py |
| 794 | PENDING | -- | PENDING | test_trusted_sender_urgency_is_fiduciary | tests/integration/test_silence_tiers.py |
| 795 | PENDING | -- | PENDING | test_untrusted_sender_normal_message_stays_engagement | tests/integration/test_silence_tiers.py |
| 796 | PENDING | -- | PENDING | test_trusted_sender_engagement_not_promoted | tests/integration/test_silence_tiers.py |
| 797 | PENDING | -- | PENDING | test_borderline_trust_score_threshold | tests/integration/test_silence_tiers.py |
| 798 | PENDING | -- | PENDING | test_untrusted_sender_with_fiduciary_keywords_all_demoted | tests/integration/test_silence_tiers.py |
| 799 | PENDING | -- | PENDING | test_unknown_sender_not_in_trust_network | tests/integration/test_silence_tiers.py |
| 800 | TAGGED | TST-INT-715 | PENDING | test_stale_event_demotion | tests/integration/test_silence_tiers.py |
| 801 | PENDING | -- | PENDING | test_fresh_fiduciary_event_not_demoted | tests/integration/test_silence_tiers.py |
| 802 | PENDING | -- | PENDING | test_stale_engagement_stays_engagement | tests/integration/test_silence_tiers.py |
| 803 | PENDING | -- | PENDING | test_stale_solicited_also_demoted | tests/integration/test_silence_tiers.py |
| 804 | PENDING | -- | PENDING | test_exactly_at_staleness_threshold | tests/integration/test_silence_tiers.py |
| 805 | PENDING | -- | PENDING | test_just_over_staleness_threshold | tests/integration/test_silence_tiers.py |
| 806 | PENDING | -- | PENDING | test_very_old_event_still_just_engagement | tests/integration/test_silence_tiers.py |
| 807 | TAGGED | TST-INT-804 | PENDING | test_staleness_check_uses_event_timestamp_not_ingestion_time | tests/integration/test_silence_tiers.py |
| 808 | TAGGED | TST-INT-714 | PENDING | test_health_context_elevates_classification | tests/integration/test_silence_tiers.py |
| 809 | PENDING | -- | PENDING | test_health_event_without_active_monitoring_stays_engagement | tests/integration/test_silence_tiers.py |
| 810 | PENDING | -- | PENDING | test_health_event_from_unknown_provider_stays_engagement | tests/integration/test_silence_tiers.py |
| 811 | PENDING | -- | PENDING | test_non_health_event_not_elevated_by_health_context | tests/integration/test_silence_tiers.py |
| 812 | PENDING | -- | PENDING | test_health_keyword_without_provider_not_elevated | tests/integration/test_silence_tiers.py |
| 813 | PENDING | -- | PENDING | test_multiple_health_keywords_in_content | tests/integration/test_silence_tiers.py |
| 814 | PENDING | -- | PENDING | test_health_provider_case_insensitive | tests/integration/test_silence_tiers.py |
| 815 | PENDING | -- | PENDING | test_already_fiduciary_health_event_stays_fiduciary | tests/integration/test_silence_tiers.py |
| 816 | TAGGED | TST-INT-711 | PENDING | test_fiduciary_notification_pii_scrubbed | tests/integration/test_silence_tiers.py |
| 817 | PENDING | -- | PENDING | test_notification_without_pii_passes_through_unchanged | tests/integration/test_silence_tiers.py |
| 818 | PENDING | -- | PENDING | test_classification_unchanged_by_scrubbing | tests/integration/test_silence_tiers.py |
| 819 | PENDING | -- | PENDING | test_pii_in_tier3_engagement_also_scrubbed_before_storage | tests/integration/test_silence_tiers.py |
| 820 | PENDING | -- | PENDING | test_multiple_pii_instances_all_scrubbed | tests/integration/test_silence_tiers.py |
| 821 | PENDING | -- | PENDING | test_scrubbed_notification_can_be_desanitized | tests/integration/test_silence_tiers.py |
| 822 | PENDING | -- | PENDING | test_pii_scrub_api_call_logged | tests/integration/test_silence_tiers.py |
| 823 | TAGGED | TST-INT-712 | PENDING | test_dnd_defers_solicited_notification | tests/integration/test_silence_tiers.py |
| 824 | PENDING | -- | PENDING | test_fiduciary_event_pushes_through_dnd | tests/integration/test_silence_tiers.py |
| 825 | PENDING | -- | PENDING | test_no_dnd_pushes_solicited_normally | tests/integration/test_silence_tiers.py |
| 826 | PENDING | -- | PENDING | test_dnd_defers_engagement_too | tests/integration/test_silence_tiers.py |
| 827 | PENDING | -- | PENDING | test_dnd_toggle_mid_stream | tests/integration/test_silence_tiers.py |
| 828 | PENDING | -- | PENDING | test_multiple_deferred_during_dnd | tests/integration/test_silence_tiers.py |
| 829 | PENDING | -- | PENDING | test_dnd_does_not_lose_notifications | tests/integration/test_silence_tiers.py |
| 830 | TAGGED | TST-INT-710 | PENDING | test_fiduciary_wins_over_engagement_for_same_topic | tests/integration/test_silence_tiers.py |
| 831 | PENDING | -- | PENDING | test_two_engagement_events_no_escalation | tests/integration/test_silence_tiers.py |
| 832 | PENDING | -- | PENDING | test_unrelated_topics_no_conflict | tests/integration/test_silence_tiers.py |
| 833 | PENDING | -- | PENDING | test_solicited_beats_engagement | tests/integration/test_silence_tiers.py |
| 834 | PENDING | -- | PENDING | test_fiduciary_beats_solicited | tests/integration/test_silence_tiers.py |
| 835 | PENDING | -- | PENDING | test_three_events_same_topic_highest_wins | tests/integration/test_silence_tiers.py |
| 836 | PENDING | -- | PENDING | test_single_event_no_conflict | tests/integration/test_silence_tiers.py |
| 837 | PENDING | -- | PENDING | test_same_tier_no_conflict | tests/integration/test_silence_tiers.py |
| 838 | PENDING | -- | PENDING | test_store_with_full_provenance | tests/integration/test_source_trust.py |
| 839 | PENDING | -- | PENDING | test_store_with_contradicts | tests/integration/test_source_trust.py |
| 840 | PENDING | -- | PENDING | test_default_search_excludes_quarantine_and_briefing | tests/integration/test_source_trust.py |
| 841 | PENDING | -- | PENDING | test_include_all_returns_everything | tests/integration/test_source_trust.py |
| 842 | PENDING | -- | PENDING | test_store_without_provenance_gets_defaults | tests/integration/test_source_trust.py |
| 843 | TAGGED | TST-INT-800 | PENDING | test_ingest_returns_staging_id | tests/integration/test_staging_pipeline.py |
| 844 | PENDING | -- | PENDING | test_dedup_same_source_id | tests/integration/test_staging_pipeline.py |
| 845 | PENDING | -- | PENDING | test_claim_resolve_stored | tests/integration/test_staging_pipeline.py |
| 846 | PENDING | -- | PENDING | test_connector_signed_ingest_succeeds | tests/integration/test_staging_pipeline.py |
| 847 | PENDING | -- | PENDING | test_connector_signed_vault_query_denied | tests/integration/test_staging_pipeline.py |
| 848 | TAGGED | TST-INT-801 | PENDING | test_connector_signed_staging_claim_denied | tests/integration/test_staging_pipeline.py |
| 849 | PENDING | -- | PENDING | test_unenriched_resolve_rejected | tests/integration/test_staging_pipeline.py |
| 850 | PENDING | -- | PENDING | test_enriched_resolve_succeeds | tests/integration/test_staging_pipeline.py |
| 851 | PENDING | -- | PENDING | test_enriched_multi_resolve_requires_all_ready | tests/integration/test_staging_pipeline.py |
| 852 | PENDING | -- | PENDING | test_ready_status_with_missing_fields_rejected | tests/integration/test_staging_pipeline.py |
| 853 | TAGGED | TST-INT-204 | PENDING | test_root_keypair_encrypted_at_rest | tests/integration/test_storage_tiers.py |
| 854 | TAGGED | TST-INT-182 | PENDING | test_bip39_recovery_mnemonic_exists | tests/integration/test_storage_tiers.py |
| 855 | TAGGED | TST-INT-197 | PENDING | test_bip32_derivation_produces_child_keys | tests/integration/test_storage_tiers.py |
| 856 | TAGGED | TST-INT-207 | PENDING | test_cryptographically_unlinkable_personas | tests/integration/test_storage_tiers.py |
| 857 | TAGGED | TST-INT-183 | PENDING | test_root_key_stored_in_tier_0 | tests/integration/test_storage_tiers.py |
| 858 | TAGGED | TST-INT-195 | PENDING | test_device_key_derivation | tests/integration/test_storage_tiers.py |
| 859 | TAGGED | TST-INT-190 | PENDING | test_encrypted_vault_has_no_sqlite_header | tests/integration/test_storage_tiers.py |
| 860 | TAGGED | TST-INT-201 | PENDING | test_all_persona_vaults_encrypted | tests/integration/test_storage_tiers.py |
| 861 | TAGGED | TST-INT-189 | PENDING | test_empty_vault_would_fail_check | tests/integration/test_storage_tiers.py |
| 862 | TAGGED | TST-INT-119 | PENDING | test_data_encrypted_with_persona_key | tests/integration/test_storage_tiers.py |
| 863 | TAGGED | TST-INT-188 | PENDING | test_fts5_search_returns_matching_keys | tests/integration/test_storage_tiers.py |
| 864 | TAGGED | TST-INT-217 | PENDING | test_fts5_search_case_insensitive | tests/integration/test_storage_tiers.py |
| 865 | TAGGED | TST-INT-198 | PENDING | test_per_persona_partition_isolation | tests/integration/test_storage_tiers.py |
| 866 | TAGGED | TST-INT-211 | PENDING | test_partition_returns_copy_not_reference | tests/integration/test_storage_tiers.py |
| 867 | TAGGED | TST-INT-187 | PENDING | test_multiple_entries_same_persona | tests/integration/test_storage_tiers.py |
| 868 | TAGGED | TST-INT-175 | PENDING | test_drafts_stored_in_staging | tests/integration/test_storage_tiers.py |
| 869 | TAGGED | TST-INT-213 | PENDING | test_auto_expire_72h | tests/integration/test_storage_tiers.py |
| 870 | TAGGED | TST-INT-206 | PENDING | test_payment_intents_stored | tests/integration/test_storage_tiers.py |
| 871 | TAGGED | TST-INT-561 | PENDING | test_payment_intent_also_expires | tests/integration/test_storage_tiers.py |
| 872 | TAGGED | TST-INT-562 | PENDING | test_multiple_items_in_staging | tests/integration/test_storage_tiers.py |
| 873 | TAGGED | TST-INT-563 | PENDING | test_staging_get_returns_none_for_missing | tests/integration/test_storage_tiers.py |
| 874 | TAGGED | TST-INT-216 | PENDING | test_encrypted_snapshots | tests/integration/test_storage_tiers.py |
| 875 | TAGGED | TST-INT-209 | PENDING | test_immutable_archive | tests/integration/test_storage_tiers.py |
| 876 | TAGGED | TST-INT-123 | PENDING | test_right_to_delete_still_works | tests/integration/test_storage_tiers.py |
| 877 | TAGGED | TST-INT-178 | PENDING | test_delete_nonexistent_returns_false | tests/integration/test_storage_tiers.py |
| 878 | TAGGED | TST-INT-208 | PENDING | test_delete_removes_from_all_partitions_and_fts | tests/integration/test_storage_tiers.py |
| 879 | TAGGED | TST-INT-184 | PENDING | test_snapshot_is_point_in_time | tests/integration/test_storage_tiers.py |
| 880 | TAGGED | TST-INT-125 | PENDING | test_archive_with_persona_encryption | tests/integration/test_storage_tiers.py |
| 881 | TAGGED | TST-INT-202 | PENDING | test_wal_mode_configured | tests/integration/test_storage_tiers.py |
| 882 | TAGGED | TST-INT-564 | PENDING | test_busy_timeout_configured | tests/integration/test_storage_tiers.py |
| 883 | TAGGED | TST-INT-122 | PENDING | test_synchronous_normal | tests/integration/test_storage_tiers.py |
| 884 | TAGGED | TST-INT-203 | PENDING | test_foreign_keys_on | tests/integration/test_storage_tiers.py |
| 885 | TAGGED | TST-INT-210 | PENDING | test_single_write_increments_tx_count | tests/integration/test_storage_tiers.py |
| 886 | TAGGED | TST-INT-199 | PENDING | test_reads_never_blocked_by_writes | tests/integration/test_storage_tiers.py |
| 887 | TAGGED | TST-INT-565 | PENDING | test_batch_store_one_transaction | tests/integration/test_storage_tiers.py |
| 888 | TAGGED | TST-INT-124 | PENDING | test_batch_store_emits_notification | tests/integration/test_storage_tiers.py |
| 889 | TAGGED | TST-INT-566 | PENDING | test_batch_data_readable_after_commit | tests/integration/test_storage_tiers.py |
| 890 | TAGGED | TST-INT-567 | PENDING | test_batch_size_is_100 | tests/integration/test_storage_tiers.py |
| 891 | TAGGED | TST-INT-218 | PENDING | test_connector_batch_ingest_uses_batches | tests/integration/test_storage_tiers.py |
| 892 | TAGGED | TST-INT-568 | PENDING | test_connector_batch_ingest_small_set | tests/integration/test_storage_tiers.py |
| 893 | TAGGED | TST-INT-569 | PENDING | test_initial_gmail_sync_transaction_count | tests/integration/test_storage_tiers.py |
| 894 | TAGGED | TST-INT-264 | PENDING | test_ingestion_brain_mcp_core | tests/integration/test_storage_tiers.py |
| 895 | TAGGED | TST-INT-269 | PENDING | test_batch_ingestion_5000_email_initial_sync | tests/integration/test_storage_tiers.py |
| 896 | TAGGED | TST-INT-270 | PENDING | test_batch_ingestion_concurrent_reads_unblocked | tests/integration/test_storage_tiers.py |
| 897 | TAGGED | TST-INT-271 | PENDING | test_draft_lifecycle_create_review_promote_discard | tests/integration/test_storage_tiers.py |
| 898 | TAGGED | TST-INT-272 | PENDING | test_staging_area_72_hour_expiry | tests/integration/test_storage_tiers.py |
| 899 | TAGGED | TST-INT-273 | PENDING | test_embedding_via_local_llama | tests/integration/test_storage_tiers.py |
| 900 | TAGGED | TST-INT-278 | PENDING | test_fts5_available_during_reindexing | tests/integration/test_storage_tiers.py |
| 901 | TAGGED | TST-INT-279 | PENDING | test_reindex_scale_100k_items | tests/integration/test_storage_tiers.py |
| 902 | TAGGED | TST-INT-283 | PENDING | test_agentic_multi_step_search | tests/integration/test_storage_tiers.py |
| 903 | TAGGED | TST-INT-284 | PENDING | test_fast_path_vs_brain_path_routing | tests/integration/test_storage_tiers.py |
| 904 | TAGGED | TST-INT-285 | PENDING | test_brain_never_opens_sqlite | tests/integration/test_storage_tiers.py |
| 905 | TAGGED | TST-INT-287 | PENDING | test_core_never_calls_external_apis | tests/integration/test_storage_tiers.py |
| 906 | TAGGED | TST-INT-288 | PENDING | test_brain_never_talks_to_clients_directly | tests/integration/test_storage_tiers.py |
| 907 | TAGGED | TST-INT-289 | PENDING | test_llama_is_stateless | tests/integration/test_storage_tiers.py |
| 908 | TAGGED | TST-INT-295 | PENDING | test_reminder_loop_missed_reminder_on_reboot | tests/integration/test_storage_tiers.py |
| 909 | PENDING | -- | PENDING | test_store_then_enrich | tests/integration/test_tiered_content.py |
| 910 | PENDING | -- | PENDING | test_unenriched_item_searchable_via_fts5 | tests/integration/test_tiered_content.py |
| 911 | PENDING | -- | PENDING | test_enrich_is_idempotent | tests/integration/test_tiered_content.py |
| 912 | PENDING | -- | PENDING | test_two_phase_full_lifecycle | tests/integration/test_tiered_content.py |
| 913 | TAGGED | TST-INT-297 | PENDING | test_review_becomes_attestation | tests/integration/test_trust_network.py |
| 914 | TAGGED | TST-INT-299 | PENDING | test_attestation_is_signed | tests/integration/test_trust_network.py |
| 915 | TAGGED | TST-INT-535 | PENDING | test_multiple_experts_same_product | tests/integration/test_trust_network.py |
| 916 | TAGGED | TST-INT-298 | PENDING | test_purchase_outcome_tracked | tests/integration/test_trust_network.py |
| 917 | TAGGED | TST-INT-307 | PENDING | test_outcome_anonymized | tests/integration/test_trust_network.py |
| 918 | TAGGED | TST-INT-312 | PENDING | test_gentle_outcome_query | tests/integration/test_trust_network.py |
| 919 | TAGGED | TST-INT-309 | PENDING | test_high_participation_rate_from_verified_users | tests/integration/test_trust_network.py |
| 920 | TAGGED | TST-INT-310 | PENDING | test_factual_not_opinion | tests/integration/test_trust_network.py |
| 921 | TAGGED | TST-INT-314 | PENDING | test_trust_tracked | tests/integration/test_trust_network.py |
| 922 | TAGGED | TST-INT-536 | PENDING | test_compromised_bot_drops_score | tests/integration/test_trust_network.py |
| 923 | TAGGED | TST-INT-537 | PENDING | test_auto_routes_to_better_bot | tests/integration/test_trust_network.py |
| 924 | TAGGED | TST-INT-311 | PENDING | test_trust_visible_to_user | tests/integration/test_trust_network.py |
| 925 | TAGGED | TST-INT-304 | PENDING | test_trust_score_capped_at_100 | tests/integration/test_trust_network.py |
| 926 | TAGGED | TST-INT-300 | PENDING | test_pds_cannot_forge_records | tests/integration/test_trust_network.py |
| 927 | TAGGED | TST-INT-301 | PENDING | test_bundled_pds_in_docker_compose | tests/integration/test_trust_network.py |
| 928 | TAGGED | TST-INT-302 | PENDING | test_external_pds_push | tests/integration/test_trust_network.py |
| 929 | TAGGED | TST-INT-303 | PENDING | test_custom_lexicon_validation | tests/integration/test_trust_network.py |
| 930 | TAGGED | TST-INT-305 | PENDING | test_author_deletes_own_review_signed_tombstone | tests/integration/test_trust_network.py |
| 931 | TAGGED | TST-INT-306 | PENDING | test_non_author_cannot_delete_review | tests/integration/test_trust_network.py |
| 932 | TAGGED | TST-INT-308 | PENDING | test_aggregate_scores_computed_not_stored | tests/integration/test_trust_network.py |
| 933 | TAGGED | TST-INT-316 | PENDING | test_pds_down_records_still_available_via_relay | tests/integration/test_trust_network.py |
| 934 | TAGGED | TST-INT-317 | PENDING | test_pds_migration_account_portability | tests/integration/test_trust_network.py |
| 935 | TAGGED | TST-INT-318 | PENDING | test_foundation_pds_stores_only_trust_data | tests/integration/test_trust_network.py |
| 936 | TAGGED | TST-INT-319 | PENDING | test_relay_crawls_pds_via_delta_sync | tests/integration/test_trust_network.py |
| 937 | TAGGED | TST-INT-320 | PENDING | test_discovery_to_pds_federation | tests/integration/test_trust_network.py |
| 938 | TAGGED | TST-INT-321 | PENDING | test_discovery_endpoint_available_unauthenticated | tests/integration/test_trust_network.py |
| 939 | TAGGED | TST-INT-322 | PENDING | test_discovery_returns_plain_text_did | tests/integration/test_trust_network.py |
| 940 | TAGGED | TST-INT-323 | PENDING | test_missing_discovery_pds_federation_fails | tests/integration/test_trust_network.py |
| 941 | TAGGED | TST-INT-718 | PENDING | test_sparse_conflicting_transparent_split | tests/integration/test_trust_network.py |
| 942 | PENDING | -- | PENDING | test_all_positive_no_conflict | tests/integration/test_trust_network.py |
| 943 | PENDING | -- | PENDING | test_all_negative_no_conflict | tests/integration/test_trust_network.py |
| 944 | PENDING | -- | PENDING | test_single_review_low_confidence | tests/integration/test_trust_network.py |
| 945 | PENDING | -- | PENDING | test_zero_reviews_no_confidence | tests/integration/test_trust_network.py |
| 946 | PENDING | -- | PENDING | test_two_positive_one_neutral_no_conflict | tests/integration/test_trust_network.py |
| 947 | PENDING | -- | PENDING | test_equal_split_one_positive_one_negative | tests/integration/test_trust_network.py |
| 948 | PENDING | -- | PENDING | test_all_unverified_mentions_unverified | tests/integration/test_trust_network.py |
| 949 | TAGGED | TST-INT-717 | PENDING | test_single_review_honest_uncertainty | tests/integration/test_trust_network.py |
| 950 | TAGGED | TST-INT-717 | PENDING | test_single_negative_review_reports_caution | tests/integration/test_trust_network.py |
| 951 | PENDING | -- | PENDING | test_single_neutral_review_neither_recommends_nor_cautions | tests/integration/test_trust_network.py |
| 952 | PENDING | -- | PENDING | test_single_unverified_review_disclosed | tests/integration/test_trust_network.py |
| 953 | PENDING | -- | PENDING | test_single_review_never_says_consensus | tests/integration/test_trust_network.py |
| 954 | TAGGED | TST-INT-717 | PENDING | test_single_review_boundary_rating_70 | tests/integration/test_trust_network.py |
| 955 | PENDING | -- | PENDING | test_single_review_boundary_rating_30 | tests/integration/test_trust_network.py |
| 956 | TAGGED | TST-INT-716 | PENDING | test_zero_trust_data_graceful_absence | tests/integration/test_trust_network.py |
| 957 | TAGGED | TST-INT-716 | PENDING | test_zero_data_does_not_hallucinate_score | tests/integration/test_trust_network.py |
| 958 | PENDING | -- | PENDING | test_zero_data_does_not_claim_consensus | tests/integration/test_trust_network.py |
| 959 | PENDING | -- | PENDING | test_zero_data_with_outcomes_still_no_reviews | tests/integration/test_trust_network.py |
| 960 | TAGGED | TST-INT-716 | PENDING | test_zero_data_result_is_complete_dict | tests/integration/test_trust_network.py |
| 961 | PENDING | -- | PENDING | test_none_attestations_handled_or_empty_equivalent | tests/integration/test_trust_network.py |
| 962 | TAGGED | TST-INT-722 | PENDING | test_reviews_with_no_outcomes_discloses_gap | tests/integration/test_trust_network.py |
| 963 | PENDING | -- | PENDING | test_reviews_with_outcomes_no_gap | tests/integration/test_trust_network.py |
| 964 | PENDING | -- | PENDING | test_no_reviews_no_outcomes_no_gap | tests/integration/test_trust_network.py |
| 965 | PENDING | -- | PENDING | test_outcome_presence_does_not_inflate_review_count | tests/integration/test_trust_network.py |
| 966 | PENDING | -- | PENDING | test_single_review_no_outcomes | tests/integration/test_trust_network.py |
| 967 | PENDING | -- | PENDING | test_reviews_with_none_outcomes_parameter | tests/integration/test_trust_network.py |
| 968 | PENDING | -- | PENDING | test_many_reviews_no_outcomes_still_discloses | tests/integration/test_trust_network.py |
| 969 | TAGGED | TST-INT-721 | PENDING | test_mixed_ring_levels_weighting_visible | tests/integration/test_trust_network.py |
| 970 | TAGGED | TST-INT-721 | PENDING | test_all_same_ring_no_weighting_distinction | tests/integration/test_trust_network.py |
| 971 | PENDING | -- | PENDING | test_both_rings_agree_positive | tests/integration/test_trust_network.py |
| 972 | PENDING | -- | PENDING | test_verified_positive_unverified_negative | tests/integration/test_trust_network.py |
| 973 | PENDING | -- | PENDING | test_summary_never_treats_unverified_equal_to_verified | tests/integration/test_trust_network.py |
| 974 | TAGGED | TST-INT-721 | PENDING | test_single_verified_vs_many_unverified | tests/integration/test_trust_network.py |
| 975 | PENDING | -- | PENDING | test_all_unverified_no_verified_section | tests/integration/test_trust_network.py |
| 976 | TAGGED | TST-INT-720 | PENDING | test_stale_reviews_recency_disclosure | tests/integration/test_trust_network.py |
| 977 | TAGGED | TST-INT-720 | PENDING | test_fresh_reviews_no_staleness_disclosure | tests/integration/test_trust_network.py |
| 978 | PENDING | -- | PENDING | test_mixed_fresh_and_stale_reviews | tests/integration/test_trust_network.py |
| 979 | PENDING | -- | PENDING | test_stale_reviews_still_counted | tests/integration/test_trust_network.py |
| 980 | TAGGED | TST-INT-720 | PENDING | test_exactly_365_days_old_not_stale | tests/integration/test_trust_network.py |
| 981 | PENDING | -- | PENDING | test_366_days_old_is_stale | tests/integration/test_trust_network.py |
| 982 | PENDING | -- | PENDING | test_single_stale_review | tests/integration/test_trust_network.py |
| 983 | PENDING | -- | PENDING | test_very_old_reviews_extreme | tests/integration/test_trust_network.py |
| 984 | TAGGED | TST-INT-719 | PENDING | test_dense_consensus_earned_confidence | tests/integration/test_trust_network.py |
| 985 | TAGGED | TST-INT-719 | PENDING | test_dense_but_split_no_consensus_language | tests/integration/test_trust_network.py |
| 986 | PENDING | -- | PENDING | test_few_reviews_cannot_earn_high_confidence | tests/integration/test_trust_network.py |
| 987 | PENDING | -- | PENDING | test_dense_all_unverified_mentions_unverified | tests/integration/test_trust_network.py |
| 988 | TAGGED | TST-INT-719 | PENDING | test_exactly_50_reviews_90_percent_agreement | tests/integration/test_trust_network.py |
| 989 | PENDING | -- | PENDING | test_dense_unanimous_positive | tests/integration/test_trust_network.py |
| 990 | PENDING | -- | PENDING | test_dense_with_neutral_reviews | tests/integration/test_trust_network.py |
| 991 | TAGGED | TST-INT-313 | PENDING | test_created_without_id | tests/integration/test_trust_rings.py |
| 992 | TAGGED | TST-INT-570 | PENDING | test_limited_transactions | tests/integration/test_trust_rings.py |
| 993 | TAGGED | TST-INT-571 | PENDING | test_low_trust_weight | tests/integration/test_trust_rings.py |
| 994 | TAGGED | TST-INT-572 | PENDING | test_polite_but_cautious | tests/integration/test_trust_rings.py |
| 995 | TAGGED | TST-INT-573 | PENDING | test_unverified_attestation_has_low_impact | tests/integration/test_trust_rings.py |
| 996 | TAGGED | TST-INT-574 | PENDING | test_zkp_proves_unique_person | tests/integration/test_trust_rings.py |
| 997 | TAGGED | TST-INT-575 | PENDING | test_higher_trust_than_ring_1 | tests/integration/test_trust_rings.py |
| 998 | TAGGED | TST-INT-315 | PENDING | test_no_identity_revealed | tests/integration/test_trust_rings.py |
| 999 | TAGGED | TST-INT-576 | PENDING | test_larger_transactions_allowed | tests/integration/test_trust_rings.py |
| 1000 | TAGGED | TST-INT-577 | PENDING | test_linkedin_anchor | tests/integration/test_trust_rings.py |
| 1001 | TAGGED | TST-INT-578 | PENDING | test_business_registration | tests/integration/test_trust_rings.py |
| 1002 | TAGGED | TST-INT-579 | PENDING | test_transaction_history | tests/integration/test_trust_rings.py |
| 1003 | TAGGED | TST-INT-312 | PENDING | test_peer_attestation | tests/integration/test_trust_rings.py |
| 1004 | TAGGED | TST-INT-580 | PENDING | test_time_factor | tests/integration/test_trust_rings.py |
| 1005 | TAGGED | TST-INT-581 | PENDING | test_ring3_base_higher_than_ring2 | tests/integration/test_trust_rings.py |
| 1006 | TAGGED | TST-INT-582 | PENDING | test_composite_calculation | tests/integration/test_trust_rings.py |
| 1007 | TAGGED | TST-INT-583 | PENDING | test_all_factors_contribute | tests/integration/test_trust_rings.py |
| 1008 | TAGGED | TST-INT-584 | PENDING | test_rug_pull_assessment | tests/integration/test_trust_rings.py |
| 1009 | TAGGED | TST-INT-314 | PENDING | test_trust_degrades_with_bad_behavior | tests/integration/test_trust_rings.py |
| 1010 | TAGGED | TST-INT-585 | PENDING | test_trust_score_capped_at_100 | tests/integration/test_trust_rings.py |
| 1011 | TAGGED | TST-INT-311 | PENDING | test_trust_score_floor_at_zero | tests/integration/test_trust_rings.py |
| 1012 | TAGGED | TST-INT-586 | PENDING | test_outcome_reports_from_different_rings | tests/integration/test_trust_rings.py |
| 1013 | TAGGED | TST-INT-587 | PENDING | test_signed_tombstone_only_by_author | tests/integration/test_trust_rings.py |
| 1014 | TAGGED | TST-INT-588 | PENDING | test_telegram_conversation_context | tests/integration/test_whisper.py |
| 1015 | TAGGED | TST-INT-589 | PENDING | test_meeting_preparation | tests/integration/test_whisper.py |
| 1016 | TAGGED | TST-INT-021 | PENDING | test_whisper_delivered_as_overlay | tests/integration/test_whisper.py |
| 1017 | TAGGED | TST-INT-022 | PENDING | test_whisper_respects_silence_tier | tests/integration/test_whisper.py |
| 1018 | TAGGED | TST-INT-024 | PENDING | test_detects_interrupted_conversation | tests/integration/test_whisper.py |
| 1019 | TAGGED | TST-INT-018 | PENDING | test_social_cue_awareness | tests/integration/test_whisper.py |

## E2E (120/132 tagged -- 90%)

| # | Status | Current Tag | Name Status | Test Function | File |
|---|--------|------------|-------------|---------------|------|
| 1 | PENDING | -- | PENDING | test_e2e_create_all_tiers | tests/e2e/test_persona_tiers_e2e.py |
| 2 | PENDING | -- | PENDING | test_e2e_general_persona_queryable | tests/e2e/test_persona_tiers_e2e.py |
| 3 | PENDING | -- | PENDING | test_e2e_session_lifecycle | tests/e2e/test_persona_tiers_e2e.py |
| 4 | PENDING | -- | PENDING | test_e2e_locked_persona_denied | tests/e2e/test_persona_tiers_e2e.py |
| 5 | PENDING | -- | PENDING | test_e2e_sensitive_unlock_query_lock | tests/e2e/test_persona_tiers_e2e.py |
| 6 | PENDING | -- | PENDING | test_e2e_approval_list | tests/e2e/test_persona_tiers_e2e.py |
| 7 | TAGGED | TST-E2E-001 | PENDING | test_complete_first_run_setup | tests/e2e/test_suite_01_onboarding.py |
| 8 | TAGGED | TST-E2E-002 | PENDING | test_device_pairing_phone | tests/e2e/test_suite_01_onboarding.py |
| 9 | TAGGED | TST-E2E-003 | PENDING | test_second_device_pairing_laptop_ws_push | tests/e2e/test_suite_01_onboarding.py |
| 10 | TAGGED | TST-E2E-004 | PENDING | test_progressive_disclosure_day_7 | tests/e2e/test_suite_01_onboarding.py |
| 11 | TAGGED | TST-E2E-005 | PENDING | test_bip39_recovery_same_mnemonic_same_did | tests/e2e/test_suite_01_onboarding.py |
| 12 | TAGGED | TST-E2E-006 | PENDING | test_exactly_one_root_identity | tests/e2e/test_suite_01_onboarding.py |
| 13 | TAGGED | TST-E2E-007 | PENDING | test_complete_9_step_arrival_flow | tests/e2e/test_suite_02_sancho_moment.py |
| 14 | TAGGED | TST-E2E-008 | PENDING | test_sharing_policy_blocks_context | tests/e2e/test_suite_02_sancho_moment.py |
| 15 | TAGGED | TST-E2E-009 | PENDING | test_dnd_context_queues_for_briefing | tests/e2e/test_suite_02_sancho_moment.py |
| 16 | TAGGED | TST-E2E-010 | PENDING | test_vault_locked_dead_drop | tests/e2e/test_suite_02_sancho_moment.py |
| 17 | TAGGED | TST-E2E-011 | PENDING | test_bidirectional_d2d | tests/e2e/test_suite_02_sancho_moment.py |
| 18 | TAGGED | TST-E2E-012 | PENDING | test_egress_audit_trail | tests/e2e/test_suite_02_sancho_moment.py |
| 19 | TAGGED | TST-E2E-013 | PENDING | test_product_research_via_reviewbot | tests/e2e/test_suite_03_product_research.py |
| 20 | TAGGED | TST-E2E-014 | PENDING | test_trust_network_check | tests/e2e/test_suite_03_product_research.py |
| 21 | TAGGED | TST-E2E-015 | PENDING | test_cart_handover | tests/e2e/test_suite_03_product_research.py |
| 22 | TAGGED | TST-E2E-016 | PENDING | test_d2d_commerce_persona_gating | tests/e2e/test_suite_03_product_research.py |
| 23 | TAGGED | TST-E2E-017 | PENDING | test_cold_start_web_search | tests/e2e/test_suite_03_product_research.py |
| 24 | TAGGED | TST-E2E-018 | PENDING | test_outcome_reporting | tests/e2e/test_suite_03_product_research.py |
| 25 | TAGGED | TST-E2E-019 | PENDING | test_hybrid_search_fts5_plus_vector | tests/e2e/test_suite_04_memory_recall.py |
| 26 | TAGGED | TST-E2E-020 | PENDING | test_emotional_recall | tests/e2e/test_suite_04_memory_recall.py |
| 27 | TAGGED | TST-E2E-021 | PENDING | test_offline_recall_rich_client_cache | tests/e2e/test_suite_04_memory_recall.py |
| 28 | TAGGED | TST-E2E-022 | PENDING | test_cross_persona_search_isolation | tests/e2e/test_suite_04_memory_recall.py |
| 29 | TAGGED | TST-E2E-023 | PENDING | test_gmail_two_pass_triage | tests/e2e/test_suite_05_ingestion.py |
| 30 | TAGGED | TST-E2E-024 | PENDING | test_telegram_ingestion | tests/e2e/test_suite_05_ingestion.py |
| 31 | TAGGED | TST-E2E-025 | PENDING | test_calendar_sync | tests/e2e/test_suite_05_ingestion.py |
| 32 | TAGGED | TST-E2E-026 | PENDING | test_cursor_continuity | tests/e2e/test_suite_05_ingestion.py |
| 33 | TAGGED | TST-E2E-027 | PENDING | test_oauth_refresh_isolation | tests/e2e/test_suite_05_ingestion.py |
| 34 | TAGGED | TST-E2E-028 | PENDING | test_startup_fast_sync_plus_background_backfill | tests/e2e/test_suite_05_ingestion.py |
| 35 | TAGGED | TST-E2E-029 | PENDING | test_license_renewal_delegation | tests/e2e/test_suite_06_agent_safety.py |
| 36 | TAGGED | TST-E2E-030 | PENDING | test_draft_dont_send_email | tests/e2e/test_suite_06_agent_safety.py |
| 37 | TAGGED | TST-E2E-031 | PENDING | test_malicious_bot_blocking | tests/e2e/test_suite_06_agent_safety.py |
| 38 | TAGGED | TST-E2E-032 | PENDING | test_agent_intent_verification | tests/e2e/test_suite_06_agent_safety.py |
| 39 | TAGGED | TST-E2E-033 | PENDING | test_task_queue_crash_recovery | tests/e2e/test_suite_06_agent_safety.py |
| 40 | TAGGED | TST-E2E-034 | PENDING | test_dead_letter_notification | tests/e2e/test_suite_06_agent_safety.py |
| 41 | TAGGED | TST-E2E-035 | PENDING | test_full_3_tier_pii_pipeline | tests/e2e/test_suite_07_privacy_pii.py |
| 42 | TAGGED | TST-E2E-036 | PENDING | test_entity_vault_lifecycle | tests/e2e/test_suite_07_privacy_pii.py |
| 43 | TAGGED | TST-E2E-037 | PENDING | test_prompt_injection_neutralisation | tests/e2e/test_suite_07_privacy_pii.py |
| 44 | TAGGED | TST-E2E-038 | PENDING | test_pii_scrubbing_always_local | tests/e2e/test_suite_07_privacy_pii.py |
| 45 | TAGGED | TST-E2E-039 | PENDING | test_health_entity_vault | tests/e2e/test_suite_08_sensitive_personas.py |
| 46 | TAGGED | TST-E2E-040 | PENDING | test_financial_persona_lock_unlock_ttl | tests/e2e/test_suite_08_sensitive_personas.py |
| 47 | TAGGED | TST-E2E-041 | PENDING | test_cross_persona_isolation | tests/e2e/test_suite_08_sensitive_personas.py |
| 48 | TAGGED | TST-E2E-042 | PENDING | test_cloud_llm_consent_for_sensitive_personas | tests/e2e/test_suite_08_sensitive_personas.py |
| 49 | TAGGED | TST-E2E-043 | PENDING | test_sss_custodian_recovery | tests/e2e/test_suite_09_digital_estate.py |
| 50 | TAGGED | TST-E2E-044 | PENDING | test_beneficiary_key_delivery | tests/e2e/test_suite_09_digital_estate.py |
| 51 | TAGGED | TST-E2E-045 | PENDING | test_destruction_gated_on_delivery | tests/e2e/test_suite_09_digital_estate.py |
| 52 | TAGGED | TST-E2E-046 | PENDING | test_sss_recovery_with_physical_shares | tests/e2e/test_suite_09_digital_estate.py |
| 53 | TAGGED | TST-E2E-047 | PENDING | test_brain_crash_scratchpad_resume | tests/e2e/test_suite_10_resilience.py |
| 54 | TAGGED | TST-E2E-048 | PENDING | test_core_wal_recovery_after_power_loss | tests/e2e/test_suite_10_resilience.py |
| 55 | TAGGED | TST-E2E-049 | PENDING | test_full_stack_power_loss | tests/e2e/test_suite_10_resilience.py |
| 56 | TAGGED | TST-E2E-050 | PENDING | test_dead_letter_queue | tests/e2e/test_suite_10_resilience.py |
| 57 | TAGGED | TST-E2E-051 | PENDING | test_disk_full_scenario | tests/e2e/test_suite_10_resilience.py |
| 58 | TAGGED | TST-E2E-052 | PENDING | test_batch_ingestion_atomicity | tests/e2e/test_suite_10_resilience.py |
| 59 | TAGGED | TST-E2E-053 | PENDING | test_realtime_multi_device_push | tests/e2e/test_suite_11_multi_device.py |
| 60 | TAGGED | TST-E2E-054 | PENDING | test_offline_sync_reconciliation | tests/e2e/test_suite_11_multi_device.py |
| 61 | TAGGED | TST-E2E-055 | PENDING | test_thin_client_no_local_storage | tests/e2e/test_suite_11_multi_device.py |
| 62 | TAGGED | TST-E2E-056 | PENDING | test_rich_client_offline_operations | tests/e2e/test_suite_11_multi_device.py |
| 63 | TAGGED | TST-E2E-057 | PENDING | test_cache_corruption_recovery | tests/e2e/test_suite_11_multi_device.py |
| 64 | TAGGED | TST-E2E-058 | PENDING | test_heartbeat_stale_connection_cleanup | tests/e2e/test_suite_11_multi_device.py |
| 65 | TAGGED | TST-E2E-059 | PENDING | test_expert_attestation_publish_relay_query | tests/e2e/test_suite_12_trust.py |
| 66 | TAGGED | TST-E2E-060 | PENDING | test_bot_trust_degradation | tests/e2e/test_suite_12_trust.py |
| 67 | TAGGED | TST-E2E-061 | PENDING | test_signed_tombstone_deletion | tests/e2e/test_suite_12_trust.py |
| 68 | TAGGED | TST-E2E-062 | PENDING | test_trust_score_computation | tests/e2e/test_suite_12_trust.py |
| 69 | TAGGED | TST-E2E-063 | PENDING | test_at_protocol_discovery | tests/e2e/test_suite_12_trust.py |
| 70 | TAGGED | TST-E2E-064 | PENDING | test_appview_determinism_censorship_alert | tests/e2e/test_suite_12_trust.py |
| 71 | TAGGED | TST-E2E-065 | PENDING | test_ddos_rate_limiting | tests/e2e/test_suite_13_security.py |
| 72 | TAGGED | TST-E2E-066 | PENDING | test_dead_drop_abuse_prevention | tests/e2e/test_suite_13_security.py |
| 73 | TAGGED | TST-E2E-067 | PENDING | test_replay_attack_prevention | tests/e2e/test_suite_13_security.py |
| 74 | TAGGED | TST-E2E-068 | PENDING | test_cross_persona_violation | tests/e2e/test_suite_13_security.py |
| 75 | TAGGED | TST-E2E-069 | PENDING | test_oversized_payload_rejection | tests/e2e/test_suite_13_security.py |
| 76 | TAGGED | TST-E2E-070 | PENDING | test_log_exfiltration_prevention | tests/e2e/test_suite_13_security.py |
| 77 | TAGGED | TST-E2E-071 | PENDING | test_token_brute_force | tests/e2e/test_suite_13_security.py |
| 78 | TAGGED | TST-E2E-072 | PENDING | test_did_spoofing | tests/e2e/test_suite_13_security.py |
| 79 | TAGGED | TST-E2E-073 | PENDING | test_relay_cannot_read_content | tests/e2e/test_suite_13_security.py |
| 80 | TAGGED | TST-E2E-074 | PENDING | test_data_sovereignty_on_disk | tests/e2e/test_suite_13_security.py |
| 81 | TAGGED | TST-E2E-075 | PENDING | test_llm_available_in_docker | tests/e2e/test_suite_14_agentic.py |
| 82 | TAGGED | TST-E2E-076 | PENDING | test_bank_fraud_always_interrupts | tests/e2e/test_suite_14_agentic.py |
| 83 | TAGGED | TST-E2E-077 | PENDING | test_youtube_recommendation_never_interrupts | tests/e2e/test_suite_14_agentic.py |
| 84 | TAGGED | TST-E2E-078 | PENDING | test_transfer_money_always_high_risk | tests/e2e/test_suite_14_agentic.py |
| 85 | TAGGED | TST-E2E-079 | PENDING | test_search_always_safe | tests/e2e/test_suite_14_agentic.py |
| 86 | TAGGED | TST-E2E-080 | PENDING | test_pii_detected_by_scrubber | tests/e2e/test_suite_14_agentic.py |
| 87 | TAGGED | TST-E2E-081 | PENDING | test_unknown_action_gets_valid_risk | tests/e2e/test_suite_14_agentic.py |
| 88 | TAGGED | TST-E2E-082 | PENDING | test_llm_reason_returns_metadata | tests/e2e/test_suite_14_agentic.py |
| 89 | PENDING | -- | PENDING | test_openrouter_reason_returns_metadata | tests/e2e/test_suite_14_agentic.py |
| 90 | TAGGED | TST-E2E-084 | PENDING | test_15_cli_generates_keypair_and_did_format | tests/e2e/test_suite_15_cli_signing.py |
| 91 | TAGGED | TST-E2E-085 | PENDING | test_15_cli_pairs_with_core_via_multibase | tests/e2e/test_suite_15_cli_signing.py |
| 92 | TAGGED | TST-E2E-086 | PENDING | test_15_signed_vault_query_returns_403 | tests/e2e/test_suite_15_cli_signing.py |
| 93 | TAGGED | TST-E2E-087 | PENDING | test_15_signed_staging_ingest_returns_201 | tests/e2e/test_suite_15_cli_signing.py |
| 94 | TAGGED | TST-E2E-088 | PENDING | test_15_tampered_signature_returns_401 | tests/e2e/test_suite_15_cli_signing.py |
| 95 | TAGGED | TST-E2E-089 | PENDING | test_15_expired_timestamp_returns_401 | tests/e2e/test_suite_15_cli_signing.py |
| 96 | TAGGED | TST-E2E-090 | PENDING | test_15_unpaired_did_returns_401 | tests/e2e/test_suite_15_cli_signing.py |
| 97 | TAGGED | TST-E2E-091 | PENDING | test_15_bearer_token_fallback_still_works | tests/e2e/test_suite_15_cli_signing.py |
| 98 | TAGGED | TST-E2E-092 | PENDING | test_16_pds_container_health | tests/e2e/test_suite_16_at_protocol_pds.py |
| 99 | TAGGED | TST-E2E-093 | PENDING | test_16_pds_server_description | tests/e2e/test_suite_16_at_protocol_pds.py |
| 100 | TAGGED | TST-E2E-094 | PENDING | test_16_did_registration_via_core | tests/e2e/test_suite_16_at_protocol_pds.py |
| 101 | TAGGED | TST-E2E-095 | PENDING | test_16_well_known_atproto_did | tests/e2e/test_suite_16_at_protocol_pds.py |
| 102 | TAGGED | TST-E2E-096 | PENDING | test_16_pds_handle_resolution | tests/e2e/test_suite_16_at_protocol_pds.py |
| 103 | TAGGED | TST-E2E-097 | PENDING | test_16_idempotent_did_creation | tests/e2e/test_suite_16_at_protocol_pds.py |
| 104 | TAGGED | TST-E2E-098 | PENDING | test_16_core_logs_pds_configuration | tests/e2e/test_suite_16_at_protocol_pds.py |
| 105 | TAGGED | TST-E2E-099 | PENDING | test_mixed_tier_interrupt_notify_queue | tests/e2e/test_suite_17_quiet_dina.py |
| 106 | TAGGED | TST-E2E-100 | PENDING | test_daily_briefing_summarizes_queued | tests/e2e/test_suite_17_quiet_dina.py |
| 107 | TAGGED | TST-E2E-101 | PENDING | test_briefing_regenerates_after_crash | tests/e2e/test_suite_17_quiet_dina.py |
| 108 | TAGGED | TST-E2E-102 | PENDING | test_export_import_restores_data | tests/e2e/test_suite_18_move_machine.py |
| 109 | TAGGED | TST-E2E-103 | PENDING | test_mnemonic_recovery_identity_only | tests/e2e/test_suite_18_move_machine.py |
| 110 | TAGGED | TST-E2E-104 | PENDING | test_import_requires_device_repairing | tests/e2e/test_suite_18_move_machine.py |
| 111 | TAGGED | TST-E2E-105 | PENDING | test_openclaw_outage_degrades_recovers | tests/e2e/test_suite_19_connector_failure.py |
| 112 | TAGGED | TST-E2E-106 | PENDING | test_telegram_credential_expiry | tests/e2e/test_suite_19_connector_failure.py |
| 113 | TAGGED | TST-E2E-107 | PENDING | test_fast_sync_backfill_resume | tests/e2e/test_suite_19_connector_failure.py |
| 114 | TAGGED | TST-E2E-108 | PENDING | test_rerun_install_no_identity_rotation | tests/e2e/test_suite_20_operator_upgrade.py |
| 115 | TAGGED | TST-E2E-109 | PENDING | test_locked_node_admin_journey | tests/e2e/test_suite_20_operator_upgrade.py |
| 116 | TAGGED | TST-E2E-110 | PENDING | test_verified_upgrade_requires_operator_action | tests/e2e/test_suite_20_operator_upgrade.py |
| 117 | TAGGED | TST-E2E-111 | PENDING | test_neglected_contact_nudge_in_daily_briefing | tests/e2e/test_suite_21_anti_her.py |
| 118 | PENDING | -- | PENDING | test_life_event_follow_up_nudge | tests/e2e/test_suite_21_anti_her.py |
| 119 | PENDING | -- | PENDING | test_social_isolation_warning | tests/e2e/test_suite_21_anti_her.py |
| 120 | TAGGED | TST-E2E-113 | PENDING | test_promise_accountability | tests/e2e/test_suite_21_anti_her.py |
| 121 | PENDING | -- | PENDING | test_emotional_dependency_escalation | tests/e2e/test_suite_21_anti_her.py |
| 122 | TAGGED | TST-E2E-116 | PENDING | test_product_research_zero_trust_data | tests/e2e/test_suite_22_verified_truth.py |
| 123 | TAGGED | TST-E2E-117 | PENDING | test_product_research_sparse_conflicting_data | tests/e2e/test_suite_22_verified_truth.py |
| 124 | TAGGED | TST-E2E-118 | PENDING | test_product_research_dense_trust_data_consensus | tests/e2e/test_suite_22_verified_truth.py |
| 125 | PENDING | -- | PENDING | test_product_research_stale_reviews | tests/e2e/test_suite_22_verified_truth.py |
| 126 | PENDING | -- | PENDING | test_product_research_ring_level_weighting | tests/e2e/test_suite_22_verified_truth.py |
| 127 | TAGGED | TST-E2E-121 | PENDING | test_notification_storm_only_fiduciary_interrupts | tests/e2e/test_suite_23_silence_stress.py |
| 128 | TAGGED | TST-E2E-122 | PENDING | test_ambiguous_urgency_from_untrusted_source | tests/e2e/test_suite_23_silence_stress.py |
| 129 | TAGGED | TST-E2E-123 | PENDING | test_dnd_respects_hierarchy | tests/e2e/test_suite_23_silence_stress.py |
| 130 | TAGGED | TST-E2E-124 | PENDING | test_malicious_agent_cannot_access_health_persona | tests/e2e/test_suite_24_agent_sandbox.py |
| 131 | TAGGED | TST-E2E-125 | PENDING | test_agent_revocation_takes_immediate_effect | tests/e2e/test_suite_24_agent_sandbox.py |
| 132 | TAGGED | TST-E2E-126 | PENDING | test_agent_cannot_impersonate_user_in_d2d | tests/e2e/test_suite_24_agent_sandbox.py |

## INST (0/102 tagged -- 0%)

| # | Status | Current Tag | Name Status | Test Function | File |
|---|--------|------------|-------------|---------------|------|
| 1 | PENDING | -- | PENDING | test_install_containers_healthy | tests/install/test_install_blackbox.py |
| 2 | PENDING | -- | PENDING | test_install_did_reachable | tests/install/test_install_blackbox.py |
| 3 | PENDING | -- | PENDING | test_full_lifecycle | tests/install/test_install_blackbox.py |
| 4 | PENDING | -- | PENDING | test_paired_device_auth_survives_restart | tests/install/test_install_blackbox.py |
| 5 | PENDING | -- | PENDING | test_rerun_preserves_did | tests/install/test_install_blackbox.py |
| 6 | PENDING | -- | PENDING | test_rerun_preserves_secrets | tests/install/test_install_blackbox.py |
| 7 | PENDING | -- | PENDING | test_install_multi_provider_skip | tests/install/test_install_blackbox.py |
| 8 | PENDING | -- | PENDING | test_inaccessible_secrets_detected | tests/install/test_install_failures.py |
| 9 | PENDING | -- | PENDING | test_run_without_install_shows_missing | tests/install/test_install_failures.py |
| 10 | PENDING | -- | PENDING | test_run_shows_specific_missing_artifacts | tests/install/test_install_failures.py |
| 11 | PENDING | -- | PENDING | test_corrupt_wrapped_seed_fails_closed | tests/install/test_install_failures.py |
| 12 | PENDING | -- | PENDING | test_install_no_docker_fails_early | tests/install/test_install_failures.py |
| 13 | PENDING | -- | PENDING | test_install_docker_daemon_unavailable | tests/install/test_install_failures.py |
| 14 | PENDING | -- | PENDING | test_bare_shows_usage | tests/install/test_install_functional.py |
| 15 | PENDING | -- | PENDING | test_unknown_flag_rejected | tests/install/test_install_functional.py |
| 16 | PENDING | -- | PENDING | test_status_shows_healthy | tests/install/test_install_functional.py |
| 17 | PENDING | -- | PENDING | test_status_shows_did | tests/install/test_install_functional.py |
| 18 | PENDING | -- | PENDING | test_persona_list | tests/install/test_install_functional.py |
| 19 | PENDING | -- | PENDING | test_device_list | tests/install/test_install_functional.py |
| 20 | PENDING | -- | PENDING | test_approvals_list | tests/install/test_install_functional.py |
| 21 | PENDING | -- | PENDING | test_model_list | tests/install/test_install_functional.py |
| 22 | PENDING | -- | PENDING | test_no_telegram_in_env_when_skipped | tests/install/test_install_functional.py |
| 23 | PENDING | -- | PENDING | test_required_fields_from_wrapper | tests/install/test_install_functional.py |
| 24 | PENDING | -- | PENDING | test_no_secrets_in_env_from_wrapper | tests/install/test_install_functional.py |
| 25 | PENDING | -- | PENDING | test_invalid_identity_choice | tests/install/test_install_functional.py |
| 26 | PENDING | -- | PENDING | test_api_key_at_llm_menu | tests/install/test_install_functional.py |
| 27 | PENDING | -- | PENDING | test_invalid_security_mode | tests/install/test_install_functional.py |
| 28 | PENDING | -- | PENDING | test_invalid_telegram_choice | tests/install/test_install_functional.py |
| 29 | PENDING | -- | PENDING | test_creates_wrapped_seed | tests/install/test_installer_core.py |
| 30 | PENDING | -- | PENDING | test_creates_salt | tests/install/test_installer_core.py |
| 31 | PENDING | -- | PENDING | test_returns_24_word_recovery_phrase | tests/install/test_installer_core.py |
| 32 | PENDING | -- | PENDING | test_provisions_service_keys | tests/install/test_installer_core.py |
| 33 | PENDING | -- | PENDING | test_creates_env_file | tests/install/test_installer_core.py |
| 34 | PENDING | -- | PENDING | test_env_does_not_contain_seed | tests/install/test_installer_core.py |
| 35 | PENDING | -- | PENDING | test_creates_session_id | tests/install/test_installer_core.py |
| 36 | PENDING | -- | PENDING | test_restore_from_mnemonic_produces_same_keys | tests/install/test_installer_core.py |
| 37 | PENDING | -- | PENDING | test_restore_returns_no_recovery_phrase | tests/install/test_installer_core.py |
| 38 | PENDING | -- | PENDING | test_restore_from_hex | tests/install/test_installer_core.py |
| 39 | PENDING | -- | PENDING | test_server_mode_password_persists | tests/install/test_installer_core.py |
| 40 | PENDING | -- | PENDING | test_maximum_mode_password_written_for_first_boot | tests/install/test_installer_core.py |
| 41 | PENDING | -- | PENDING | test_maximum_mode_password_clearable | tests/install/test_installer_core.py |
| 42 | PENDING | -- | PENDING | test_rerun_preserves_wrapped_seed | tests/install/test_installer_core.py |
| 43 | PENDING | -- | PENDING | test_rerun_preserves_session_id | tests/install/test_installer_core.py |
| 44 | PENDING | -- | PENDING | test_rerun_preserves_service_keys | tests/install/test_installer_core.py |
| 45 | PENDING | -- | PENDING | test_rerun_preserves_salt | tests/install/test_installer_core.py |
| 46 | PENDING | -- | PENDING | test_rerun_preserves_env | tests/install/test_installer_core.py |
| 47 | PENDING | -- | PENDING | test_secrets_dir_0700 | tests/install/test_installer_core.py |
| 48 | PENDING | -- | PENDING | test_wrapped_seed_0600 | tests/install/test_installer_core.py |
| 49 | PENDING | -- | PENDING | test_env_file_0600 | tests/install/test_installer_core.py |
| 50 | PENDING | -- | PENDING | test_gitignore_includes_secrets | tests/install/test_installer_core.py |
| 51 | PENDING | -- | PENDING | test_llm_providers_written | tests/install/test_installer_core.py |
| 52 | PENDING | -- | PENDING | test_telegram_written | tests/install/test_installer_core.py |
| 53 | PENDING | -- | PENDING | test_owner_name_written | tests/install/test_installer_core.py |
| 54 | PENDING | -- | PENDING | test_short_passphrase_rejected | tests/install/test_installer_core.py |
| 55 | PENDING | -- | PENDING | test_invalid_hex_seed_rejected | tests/install/test_installer_core.py |
| 56 | PENDING | -- | PENDING | test_wrong_length_hex_rejected | tests/install/test_installer_core.py |
| 57 | PENDING | -- | PENDING | test_wrong_mnemonic_word_count_rejected | tests/install/test_installer_core.py |
| 58 | PENDING | -- | PENDING | test_all_steps_recorded | tests/install/test_installer_core.py |
| 59 | PENDING | -- | PENDING | test_all_steps_succeeded | tests/install/test_installer_core.py |
| 60 | PENDING | -- | PENDING | test_new_identity_full_flow | tests/install/test_installer_wizard.py |
| 61 | PENDING | -- | PENDING | test_maximum_security_mode | tests/install/test_installer_wizard.py |
| 62 | PENDING | -- | PENDING | test_restore_mnemonic | tests/install/test_installer_wizard.py |
| 63 | PENDING | -- | PENDING | test_short_passphrase_reprompts | tests/install/test_installer_wizard.py |
| 64 | PENDING | -- | PENDING | test_passphrase_mismatch_reprompts | tests/install/test_installer_wizard.py |
| 65 | PENDING | -- | PENDING | test_rerun_skips_identity | tests/install/test_installer_wizard.py |
| 66 | PENDING | -- | PENDING | test_gemini_key_written_to_env | tests/install/test_installer_wizard.py |
| 67 | PENDING | -- | PENDING | test_wizard_waits_for_verification_done | tests/install/test_installer_wizard.py |
| 68 | PENDING | -- | PENDING | test_rerun_skips_owner_and_telegram | tests/install/test_installer_wizard.py |
| 69 | PENDING | -- | PENDING | test_set_lite | tests/install/test_model_set.py |
| 70 | PENDING | -- | PENDING | test_set_primary | tests/install/test_model_set.py |
| 71 | PENDING | -- | PENDING | test_set_heavy | tests/install/test_model_set.py |
| 72 | PENDING | -- | PENDING | test_set_invalid_role | tests/install/test_model_set.py |
| 73 | PENDING | -- | PENDING | test_set_preserves_other_roles | tests/install/test_model_set.py |
| 74 | PENDING | -- | PENDING | test_set_unknown_model_warns | tests/install/test_model_set.py |
| 75 | PENDING | -- | PENDING | test_interactive_set_by_number | tests/install/test_model_set.py |
| 76 | PENDING | -- | PENDING | test_interactive_set_by_paste | tests/install/test_model_set.py |
| 77 | PENDING | -- | PENDING | test_interactive_keep_all | tests/install/test_model_set.py |
| 78 | PENDING | -- | PENDING | test_interactive_missing_key_prompts | tests/install/test_model_set.py |
| 79 | PENDING | -- | PENDING | test_interactive_change_all_three | tests/install/test_model_set.py |
| 80 | PENDING | -- | PENDING | test_four_personas_exist | tests/install/test_post_install.py |
| 81 | PENDING | -- | PENDING | test_general_open | tests/install/test_post_install.py |
| 82 | PENDING | -- | PENDING | test_work_open | tests/install/test_post_install.py |
| 83 | PENDING | -- | PENDING | test_health_auto_opens | tests/install/test_post_install.py |
| 84 | PENDING | -- | PENDING | test_finance_auto_opens | tests/install/test_post_install.py |
| 85 | PENDING | -- | PENDING | test_store_and_query | tests/install/test_post_install.py |
| 86 | PENDING | -- | PENDING | test_reason_returns_error_code_or_content | tests/install/test_post_install.py |
| 87 | PENDING | -- | PENDING | test_error_code_classified | tests/install/test_post_install.py |
| 88 | PENDING | -- | PENDING | test_error_has_message | tests/install/test_post_install.py |
| 89 | PENDING | -- | PENDING | test_did_available | tests/install/test_post_install.py |
| 90 | PENDING | -- | PENDING | test_no_auth_401 | tests/install/test_post_install.py |
| 91 | PENDING | -- | PENDING | test_bad_token_401 | tests/install/test_post_install.py |
| 92 | PENDING | -- | PENDING | test_healthz_no_auth | tests/install/test_post_install.py |
| 93 | PENDING | -- | PENDING | test_list_empty | tests/install/test_post_install.py |
| 94 | PENDING | -- | PENDING | test_deny_unknown_404 | tests/install/test_post_install.py |
| 95 | PENDING | -- | PENDING | test_reason_status_404_for_unknown | tests/install/test_post_install.py |
| 96 | PENDING | -- | PENDING | test_reason_endpoint_exists | tests/install/test_post_install.py |
| 97 | PENDING | -- | PENDING | test_round_trip | tests/install/test_post_install.py |
| 98 | PENDING | -- | PENDING | test_scrub_phone | tests/install/test_post_install.py |
| 99 | PENDING | -- | PENDING | test_brain_healthz_accepts_owner_name | tests/install/test_post_install.py |
| 100 | PENDING | -- | PENDING | test_create_extra_persona_no_duplicates | tests/install/test_post_install.py |
| 101 | PENDING | -- | PENDING | test_auto_start_run_no_prompt | tests/install/test_startup_modes.py |
| 102 | PENDING | -- | PENDING | test_manual_start_run_prompts_and_clears | tests/install/test_startup_modes.py |

## REL (135/141 tagged -- 95%)

| # | Status | Current Tag | Name Status | Test Function | File |
|---|--------|------------|-------------|---------------|------|
| 1 | TAGGED | REL-001 | PENDING | test_rel_001_install_script_exists_and_executable | tests/release/test_rel_001_fresh_install.py |
| 2 | TAGGED | REL-001 | PENDING | test_rel_001_run_script_exists | tests/release/test_rel_001_fresh_install.py |
| 3 | TAGGED | REL-001 | PENDING | test_rel_001_docker_compose_valid | tests/release/test_rel_001_fresh_install.py |
| 4 | TAGGED | REL-001 | PENDING | test_rel_001_core_healthy_after_start | tests/release/test_rel_001_fresh_install.py |
| 5 | TAGGED | REL-001 | PENDING | test_rel_001_brain_healthy_after_start | tests/release/test_rel_001_fresh_install.py |
| 6 | TAGGED | REL-001 | PENDING | test_rel_001_did_generated_on_first_boot | tests/release/test_rel_001_fresh_install.py |
| 7 | TAGGED | REL-002 | PENDING | test_rel_002_brain_reachable_from_core | tests/release/test_rel_002_first_conversation.py |
| 8 | TAGGED | REL-002 | PENDING | test_rel_002_vault_store_simulates_remember | tests/release/test_rel_002_first_conversation.py |
| 9 | TAGGED | REL-002 | PENDING | test_rel_002_vault_recall_uses_context | tests/release/test_rel_002_first_conversation.py |
| 10 | TAGGED | REL-002 | PENDING | test_rel_002_brain_process_accepts_signed_request | tests/release/test_rel_002_first_conversation.py |
| 11 | TAGGED | REL-003 | PENDING | test_rel_003_data_persists_via_api | tests/release/test_rel_003_vault_persistence.py |
| 12 | TAGGED | REL-003 | PENDING | test_rel_003_fts_retrieval_works | tests/release/test_rel_003_vault_persistence.py |
| 13 | TAGGED | REL-003 | PENDING | test_rel_003_no_duplicate_on_re_store | tests/release/test_rel_003_vault_persistence.py |
| 14 | TAGGED | REL-003 | PENDING | test_rel_003_healthz_returns_ok | tests/release/test_rel_003_vault_persistence.py |
| 15 | TAGGED | REL-004 | PENDING | test_rel_004_locked_persona_returns_403 | tests/release/test_rel_004_locked_state.py |
| 16 | TAGGED | REL-004 | PENDING | test_rel_004_unlock_resumes_access | tests/release/test_rel_004_locked_state.py |
| 17 | TAGGED | REL-004 | PENDING | test_rel_004_no_data_in_locked_error | tests/release/test_rel_004_locked_state.py |
| 18 | TAGGED | REL-004 | PENDING | test_rel_004_wrong_passphrase_rejected | tests/release/test_rel_004_locked_state.py |
| 19 | TAGGED | REL-005 | PENDING | test_rel_005_did_is_stable | tests/release/test_rel_005_recovery.py |
| 20 | TAGGED | REL-005 | PENDING | test_rel_005_did_consistent_across_calls | tests/release/test_rel_005_recovery.py |
| 21 | TAGGED | REL-005 | PENDING | test_rel_005_did_sign_and_verify | tests/release/test_rel_005_recovery.py |
| 22 | TAGGED | REL-005 | PENDING | test_rel_005_well_known_atproto_did | tests/release/test_rel_005_recovery.py |
| 23 | TAGGED | REL-006 | PENDING | test_rel_006_node_b_healthy | tests/release/test_rel_006_two_dinas.py |
| 24 | TAGGED | REL-006 | PENDING | test_rel_006_send_message_a_to_b | tests/release/test_rel_006_two_dinas.py |
| 25 | TAGGED | REL-006 | PENDING | test_rel_006_message_arrives_in_b_inbox | tests/release/test_rel_006_two_dinas.py |
| 26 | TAGGED | REL-006 | PENDING | test_rel_006_send_message_b_to_a | tests/release/test_rel_006_two_dinas.py |
| 27 | TAGGED | REL-007 | PENDING | test_rel_007_trust_resolve_endpoint_exists | tests/release/test_rel_007_trust_network.py |
| 28 | TAGGED | REL-007 | PENDING | test_rel_007_trust_resolve_requires_did_param | tests/release/test_rel_007_trust_network.py |
| 29 | TAGGED | REL-007 | PENDING | test_rel_007_trust_cache_endpoint | tests/release/test_rel_007_trust_network.py |
| 30 | TAGGED | REL-007 | PENDING | test_rel_007_trust_stats_endpoint | tests/release/test_rel_007_trust_network.py |
| 31 | TAGGED | REL-007 | PENDING | test_rel_007_trust_sync_endpoint | tests/release/test_rel_007_trust_network.py |
| 32 | TAGGED | REL-007 | PENDING | test_rel_007_appview_accessible_from_core | tests/release/test_rel_007_trust_network.py |
| 33 | TAGGED | REL-008 | PENDING | test_rel_008_pairing_initiate_returns_code | tests/release/test_rel_008_agent_gateway.py |
| 34 | TAGGED | REL-008 | PENDING | test_rel_008_pairing_complete_registers_device | tests/release/test_rel_008_agent_gateway.py |
| 35 | TAGGED | REL-008 | PENDING | test_rel_008_devices_list_shows_paired | tests/release/test_rel_008_agent_gateway.py |
| 36 | TAGGED | REL-008 | PENDING | test_rel_008_unapproved_agent_blocked | tests/release/test_rel_008_agent_gateway.py |
| 37 | TAGGED | REL-009 | PENDING | test_rel_009_cross_persona_data_isolated | tests/release/test_rel_009_persona_wall.py |
| 38 | TAGGED | REL-009 | PENDING | test_rel_009_pii_scrubbed_via_api | tests/release/test_rel_009_persona_wall.py |
| 39 | TAGGED | REL-009 | PENDING | test_rel_009_restricted_persona_requires_unlock | tests/release/test_rel_009_persona_wall.py |
| 40 | TAGGED | REL-009 | PENDING | test_rel_009_persona_list_returns_all | tests/release/test_rel_009_persona_wall.py |
| 41 | TAGGED | REL-010 | PENDING | test_rel_010_send_to_nonexistent_peer_fails_gracefully | tests/release/test_rel_010_hostile_network.py |
| 42 | TAGGED | REL-010 | PENDING | test_rel_010_core_healthy_after_failed_send | tests/release/test_rel_010_hostile_network.py |
| 43 | TAGGED | REL-010 | PENDING | test_rel_010_invalid_did_rejected | tests/release/test_rel_010_hostile_network.py |
| 44 | TAGGED | REL-010 | PENDING | test_rel_010_empty_body_handled_without_crash | tests/release/test_rel_010_hostile_network.py |
| 45 | TAGGED | REL-010 | PENDING | test_rel_010_node_b_healthy_after_fault_tests | tests/release/test_rel_010_hostile_network.py |
| 46 | TAGGED | REL-011 | PENDING | test_rel_011_wrong_token_returns_401 | tests/release/test_rel_011_failure_handling.py |
| 47 | TAGGED | REL-011 | PENDING | test_rel_011_no_token_returns_401 | tests/release/test_rel_011_failure_handling.py |
| 48 | TAGGED | REL-011 | PENDING | test_rel_011_brain_healthz_reachable | tests/release/test_rel_011_failure_handling.py |
| 49 | TAGGED | REL-011 | PENDING | test_rel_011_core_healthz_includes_brain | tests/release/test_rel_011_failure_handling.py |
| 50 | TAGGED | REL-011 | PENDING | test_rel_011_vault_store_and_verify | tests/release/test_rel_011_failure_handling.py |
| 51 | TAGGED | REL-011 | PENDING | test_rel_011_concurrent_stores_succeed | tests/release/test_rel_011_failure_handling.py |
| 52 | TAGGED | REL-011 | PENDING | test_rel_011_agent_validate_resilient | tests/release/test_rel_011_failure_handling.py |
| 53 | TAGGED | REL-011 | PENDING | test_rel_011_error_messages_human_readable | tests/release/test_rel_011_failure_handling.py |
| 54 | TAGGED | REL-012 | PENDING | test_rel_012_core_docs_exist | tests/release/test_rel_012_doc_claims.py |
| 55 | TAGGED | REL-012 | PENDING | test_rel_012_architecture_docs_exist | tests/release/test_rel_012_doc_claims.py |
| 56 | TAGGED | REL-012 | PENDING | test_rel_012_walkthrough_docs_exist | tests/release/test_rel_012_doc_claims.py |
| 57 | TAGGED | REL-012 | PENDING | test_rel_012_install_script_exists | tests/release/test_rel_012_doc_claims.py |
| 58 | TAGGED | REL-012 | PENDING | test_rel_012_run_script_exists | tests/release/test_rel_012_doc_claims.py |
| 59 | TAGGED | REL-012 | PENDING | test_rel_012_docker_compose_exists | tests/release/test_rel_012_doc_claims.py |
| 60 | TAGGED | REL-012 | PENDING | test_rel_012_provision_scripts_exist | tests/release/test_rel_012_doc_claims.py |
| 61 | TAGGED | REL-012 | PENDING | test_rel_012_readme_internal_links | tests/release/test_rel_012_doc_claims.py |
| 62 | TAGGED | REL-012 | PENDING | test_rel_012_test_plan_references | tests/release/test_rel_012_doc_claims.py |
| 63 | TAGGED | REL-015 | PENDING | test_rel_015_did_stable_across_requests | tests/release/test_rel_015_install_rerun.py |
| 64 | TAGGED | REL-015 | PENDING | test_rel_015_persona_recreate_idempotent | tests/release/test_rel_015_install_rerun.py |
| 65 | TAGGED | REL-015 | PENDING | test_rel_015_healthz_stable | tests/release/test_rel_015_install_rerun.py |
| 66 | TAGGED | REL-015 | PENDING | test_rel_015_vault_data_survives_re_unlock | tests/release/test_rel_015_install_rerun.py |
| 67 | TAGGED | REL-016 | PENDING | test_rel_016_no_auto_update_service | tests/release/test_rel_016_upgrade.py |
| 68 | TAGGED | REL-016 | PENDING | test_rel_016_no_watchtower_or_ouroboros | tests/release/test_rel_016_upgrade.py |
| 69 | TAGGED | REL-016 | PENDING | test_rel_016_healthz_consistent_across_calls | tests/release/test_rel_016_upgrade.py |
| 70 | TAGGED | REL-017 | PENDING | test_rel_017_wrong_token_rejected | tests/release/test_rel_017_admin_lifecycle.py |
| 71 | TAGGED | REL-017 | PENDING | test_rel_017_valid_token_accepted | tests/release/test_rel_017_admin_lifecycle.py |
| 72 | TAGGED | REL-017 | PENDING | test_rel_017_admin_persona_create | tests/release/test_rel_017_admin_lifecycle.py |
| 73 | TAGGED | REL-017 | PENDING | test_rel_017_device_pairing_requires_auth | tests/release/test_rel_017_admin_lifecycle.py |
| 74 | TAGGED | REL-018 | PENDING | test_rel_018_core_usable_without_brain_features | tests/release/test_rel_018_connector_outage.py |
| 75 | TAGGED | REL-018 | PENDING | test_rel_018_healthz_reports_service_status | tests/release/test_rel_018_connector_outage.py |
| 76 | TAGGED | REL-018 | PENDING | test_rel_018_error_on_brain_failure_is_clear | tests/release/test_rel_018_connector_outage.py |
| 77 | TAGGED | REL-018 | PENDING | test_rel_018_did_works_independently | tests/release/test_rel_018_connector_outage.py |
| 78 | TAGGED | REL-019 | PENDING | test_rel_019_fiduciary_event_classified | tests/release/test_rel_019_silence_briefing.py |
| 79 | TAGGED | REL-019 | PENDING | test_rel_019_safe_action_auto_approved | tests/release/test_rel_019_silence_briefing.py |
| 80 | TAGGED | REL-019 | PENDING | test_rel_019_risky_action_requires_approval | tests/release/test_rel_019_silence_briefing.py |
| 81 | TAGGED | REL-019 | PENDING | test_rel_019_agent_validate_returns_structured | tests/release/test_rel_019_silence_briefing.py |
| 82 | TAGGED | REL-020 | PENDING | test_rel_020_email_draft_stored_not_sent | tests/release/test_rel_020_cart_handover.py |
| 83 | TAGGED | REL-020 | PENDING | test_rel_020_purchase_intent_stored_not_executed | tests/release/test_rel_020_cart_handover.py |
| 84 | TAGGED | REL-020 | PENDING | test_rel_020_transfer_money_requires_approval | tests/release/test_rel_020_cart_handover.py |
| 85 | TAGGED | REL-020 | PENDING | test_rel_020_vault_tracks_draft_type | tests/release/test_rel_020_cart_handover.py |
| 86 | TAGGED | REL-021 | PENDING | test_rel_021_vault_has_data_to_export | tests/release/test_rel_021_export_import.py |
| 87 | TAGGED | REL-021 | PENDING | test_rel_021_export_endpoint_exists | tests/release/test_rel_021_export_import.py |
| 88 | TAGGED | REL-021 | PENDING | test_rel_021_did_signature_verifiable | tests/release/test_rel_021_export_import.py |
| 89 | TAGGED | REL-021 | PENDING | test_rel_021_kv_store_for_metadata | tests/release/test_rel_021_export_import.py |
| 90 | TAGGED | REL-022 | PENDING | test_rel_022_only_core_port_exposed | tests/release/test_rel_022_exposure_audit.py |
| 91 | TAGGED | REL-022 | PENDING | test_rel_022_healthz_no_secrets | tests/release/test_rel_022_exposure_audit.py |
| 92 | TAGGED | REL-022 | PENDING | test_rel_022_brain_not_directly_accessible_without_auth | tests/release/test_rel_022_exposure_audit.py |
| 93 | TAGGED | REL-022 | PENDING | test_rel_022_no_debug_endpoints | tests/release/test_rel_022_exposure_audit.py |
| 94 | TAGGED | REL-022 | PENDING | test_rel_022_container_runs_non_root | tests/release/test_rel_022_exposure_audit.py |
| 95 | TAGGED | REL-023 | PENDING | test_rel_023_agent_can_store_data | tests/release/test_rel_023_cli_agent.py |
| 96 | TAGGED | REL-023 | PENDING | test_rel_023_agent_can_ask_data | tests/release/test_rel_023_cli_agent.py |
| 97 | TAGGED | REL-023 | PENDING | test_rel_023_agent_validates_safe_action | tests/release/test_rel_023_cli_agent.py |
| 98 | TAGGED | REL-023 | PENDING | test_rel_023_agent_validates_risky_action | tests/release/test_rel_023_cli_agent.py |
| 99 | TAGGED | REL-023 | PENDING | test_rel_023_agent_can_scrub_pii | tests/release/test_rel_023_cli_agent.py |
| 100 | TAGGED | REL-023 | PENDING | test_rel_023_agent_can_stage_draft | tests/release/test_rel_023_cli_agent.py |
| 101 | TAGGED | REL-023 | PENDING | test_rel_023_agent_can_sign_data | tests/release/test_rel_023_cli_agent.py |
| 102 | TAGGED | REL-023 | PENDING | test_rel_023_agent_can_view_audit | tests/release/test_rel_023_cli_agent.py |
| 103 | TAGGED | REL-023 | PENDING | test_rel_023_agent_validate_status_polling | tests/release/test_rel_023_cli_agent.py |
| 104 | TAGGED | REL-023 | PENDING | test_rel_023_unpaired_agent_rejected | tests/release/test_rel_023_cli_agent.py |
| 105 | TAGGED | REL-024 | PENDING | test_rel_024_dense_data_earned_confidence | tests/release/test_rel_024_recommendation_integrity.py |
| 106 | TAGGED | REL-024 | PENDING | test_rel_024_zero_data_honest_absence | tests/release/test_rel_024_recommendation_integrity.py |
| 107 | TAGGED | REL-024 | PENDING | test_rel_024_sparse_conflicting_transparent_split | tests/release/test_rel_024_recommendation_integrity.py |
| 108 | TAGGED | REL-024 | PENDING | test_rel_024_attribution_includes_deep_link | tests/release/test_rel_024_recommendation_integrity.py |
| 109 | TAGGED | REL-024 | PENDING | test_rel_024_no_unsolicited_product_discovery | tests/release/test_rel_024_recommendation_integrity.py |
| 110 | TAGGED | REL-024 | PENDING | test_rel_024_sponsorship_cannot_distort_ranking | tests/release/test_rel_024_recommendation_integrity.py |
| 111 | TAGGED | REL-024 | PENDING | test_rel_024_ranking_rationale_explainable | tests/release/test_rel_024_recommendation_integrity.py |
| 112 | TAGGED | REL-025 | PENDING | test_rel_025_emotional_dependency_detection | tests/release/test_rel_025_anti_her.py |
| 113 | TAGGED | REL-025 | PENDING | test_rel_025_loneliness_redirects_to_humans | tests/release/test_rel_025_anti_her.py |
| 114 | TAGGED | REL-025 | PENDING | test_rel_025_neglected_contacts_with_context | tests/release/test_rel_025_anti_her.py |
| 115 | TAGGED | REL-025 | PENDING | test_rel_025_birthday_nudge_contextual | tests/release/test_rel_025_anti_her.py |
| 116 | TAGGED | REL-025 | PENDING | test_rel_025_promise_followup_nudge | tests/release/test_rel_025_anti_her.py |
| 117 | TAGGED | REL-025 | PENDING | test_rel_025_direct_loneliness_redirect | tests/release/test_rel_025_anti_her.py |
| 118 | TAGGED | REL-025 | PENDING | test_rel_025_factual_emotion_not_blocked | tests/release/test_rel_025_anti_her.py |
| 119 | TAGGED | REL-025 | PENDING | test_rel_025_depressed_user_gets_redirect | tests/release/test_rel_025_anti_her.py |
| 120 | TAGGED | REL-025 | PENDING | test_rel_025_no_anthropomorphic_language | tests/release/test_rel_025_anti_her.py |
| 121 | TAGGED | REL-025 | PENDING | test_rel_025_no_engagement_hooks_after_completion | tests/release/test_rel_025_anti_her.py |
| 122 | PENDING | -- | PENDING | test_rel_025_vault_recall_not_blocked_by_anti_her | tests/release/test_rel_025_anti_her.py |
| 123 | PENDING | -- | PENDING | test_rel_025_ingest_stores_received | tests/release/test_rel_025_staging_pipeline.py |
| 124 | PENDING | -- | PENDING | test_rel_025_dedup_returns_original_id | tests/release/test_rel_025_staging_pipeline.py |
| 125 | PENDING | -- | PENDING | test_rel_025_claim_resolve_vault_persistence | tests/release/test_rel_025_staging_pipeline.py |
| 126 | PENDING | -- | PENDING | test_rel_025_brain_service_key_claim_resolve | tests/release/test_rel_025_staging_pipeline.py |
| 127 | PENDING | -- | PENDING | test_rel_025_locked_persona_pending_unlock_drain | tests/release/test_rel_025_staging_pipeline.py |
| 128 | TAGGED | REL-026 | PENDING | test_rel_026_high_volume_engagement_silent | tests/release/test_rel_026_silence_stress.py |
| 129 | TAGGED | REL-026 | PENDING | test_rel_026_fiduciary_in_batch_interrupts | tests/release/test_rel_026_silence_stress.py |
| 130 | TAGGED | REL-026 | PENDING | test_rel_026_untrusted_urgent_not_fiduciary | tests/release/test_rel_026_silence_stress.py |
| 131 | TAGGED | REL-026 | PENDING | test_rel_026_trusted_urgent_is_fiduciary | tests/release/test_rel_026_silence_stress.py |
| 132 | TAGGED | REL-026 | PENDING | test_rel_026_engagement_events_saved_for_briefing | tests/release/test_rel_026_silence_stress.py |
| 133 | TAGGED | REL-026 | PENDING | test_rel_026_empty_state_no_notification | tests/release/test_rel_026_silence_stress.py |
| 134 | TAGGED | REL-026 | PENDING | test_rel_026_trust_classification_asymmetry | tests/release/test_rel_026_silence_stress.py |
| 135 | TAGGED | REL-027 | PENDING | test_rel_027_send_downgraded_to_draft | tests/release/test_rel_027_action_integrity.py |
| 136 | TAGGED | REL-027 | PENDING | test_rel_027_ttl_by_risk_profile | tests/release/test_rel_027_action_integrity.py |
| 137 | TAGGED | REL-027 | PENDING | test_rel_027_pending_actions_listed_individually | tests/release/test_rel_027_action_integrity.py |
| 138 | TAGGED | REL-027 | PENDING | test_rel_027_payload_mutation_invalidates_approval | tests/release/test_rel_027_action_integrity.py |
| 139 | TAGGED | REL-027 | PENDING | test_rel_027_approval_survives_crash | tests/release/test_rel_027_action_integrity.py |
| 140 | TAGGED | REL-027 | PENDING | test_rel_027_independent_approval_tokens | tests/release/test_rel_027_action_integrity.py |
| 141 | TAGGED | REL-028 | PENDING | test_rel_028_full_lifecycle | tests/release/test_rel_028_install_lifecycle.py |

## SYSTEM (0/151 tagged -- 0%)

| # | Status | Current Tag | Name Status | Test Function | File |
|---|--------|------------|-------------|---------------|------|
| 1 | PENDING | -- | PENDING | test_core_alonso_healthy | tests/system/check_sanity/test_sanity.py |
| 2 | PENDING | -- | PENDING | test_core_sancho_healthy | tests/system/check_sanity/test_sanity.py |
| 3 | PENDING | -- | PENDING | test_brain_alonso_healthy | tests/system/check_sanity/test_sanity.py |
| 4 | PENDING | -- | PENDING | test_brain_sancho_healthy | tests/system/check_sanity/test_sanity.py |
| 5 | PENDING | -- | PENDING | test_appview_healthy | tests/system/check_sanity/test_sanity.py |
| 6 | PENDING | -- | PENDING | test_appview_db_connected | tests/system/check_sanity/test_sanity.py |
| 7 | PENDING | -- | PENDING | test_get_did | tests/system/check_sanity/test_sanity.py |
| 8 | PENDING | -- | PENDING | test_sign_verify_roundtrip | tests/system/check_sanity/test_sanity.py |
| 9 | PENDING | -- | PENDING | test_cross_node_verify | tests/system/check_sanity/test_sanity.py |
| 10 | PENDING | -- | PENDING | test_tampered_signature_rejected | tests/system/check_sanity/test_sanity.py |
| 11 | PENDING | -- | PENDING | test_store_and_fts_query | tests/system/check_sanity/test_sanity.py |
| 12 | PENDING | -- | PENDING | test_store_batch | tests/system/check_sanity/test_sanity.py |
| 13 | PENDING | -- | PENDING | test_cross_persona_isolation | tests/system/check_sanity/test_sanity.py |
| 14 | PENDING | -- | PENDING | test_kv_put_get | tests/system/check_sanity/test_sanity.py |
| 15 | PENDING | -- | PENDING | test_send_alonso_to_sancho | tests/system/check_sanity/test_sanity.py |
| 16 | PENDING | -- | PENDING | test_send_sancho_to_alonso | tests/system/check_sanity/test_sanity.py |
| 17 | PENDING | -- | PENDING | test_unknown_did_graceful | tests/system/check_sanity/test_sanity.py |
| 18 | PENDING | -- | PENDING | test_scrub_email | tests/system/check_sanity/test_sanity.py |
| 19 | PENDING | -- | PENDING | test_scrub_credit_card | tests/system/check_sanity/test_sanity.py |
| 20 | PENDING | -- | PENDING | test_brain_pii_ner | tests/system/check_sanity/test_sanity.py |
| 21 | PENDING | -- | PENDING | test_clean_text_passthrough | tests/system/check_sanity/test_sanity.py |
| 22 | PENDING | -- | PENDING | test_initiate_pairing | tests/system/check_sanity/test_sanity.py |
| 23 | PENDING | -- | PENDING | test_complete_pairing | tests/system/check_sanity/test_sanity.py |
| 24 | PENDING | -- | PENDING | test_invalid_code_rejected | tests/system/check_sanity/test_sanity.py |
| 25 | PENDING | -- | PENDING | test_add_contact | tests/system/check_sanity/test_sanity.py |
| 26 | PENDING | -- | PENDING | test_list_contacts | tests/system/check_sanity/test_sanity.py |
| 27 | PENDING | -- | PENDING | test_set_sharing_policy | tests/system/check_sanity/test_sanity.py |
| 28 | PENDING | -- | PENDING | test_delete_contact | tests/system/check_sanity/test_sanity.py |
| 29 | PENDING | -- | PENDING | test_no_token_rejected | tests/system/check_sanity/test_sanity.py |
| 30 | PENDING | -- | PENDING | test_wrong_token_rejected | tests/system/check_sanity/test_sanity.py |
| 31 | PENDING | -- | PENDING | test_brain_no_token_rejected | tests/system/check_sanity/test_sanity.py |
| 32 | PENDING | -- | PENDING | test_admin_requires_client_token | tests/system/check_sanity/test_sanity.py |
| 33 | PENDING | -- | PENDING | test_appview_no_auth_needed | tests/system/check_sanity/test_sanity.py |
| 34 | PENDING | -- | PENDING | test_resolve_did | tests/system/check_sanity/test_sanity.py |
| 35 | PENDING | -- | PENDING | test_search_attestations | tests/system/check_sanity/test_sanity.py |
| 36 | PENDING | -- | PENDING | test_get_profile | tests/system/check_sanity/test_sanity.py |
| 37 | PENDING | -- | PENDING | test_get_attestations | tests/system/check_sanity/test_sanity.py |
| 38 | PENDING | -- | PENDING | test_admin_health | tests/system/check_sanity/test_sanity.py |
| 39 | PENDING | -- | PENDING | test_admin_login | tests/system/check_sanity/test_sanity.py |
| 40 | PENDING | -- | PENDING | test_admin_settings_read | tests/system/check_sanity/test_sanity.py |
| 41 | PENDING | -- | PENDING | test_pds_healthy | tests/system/check_sanity/test_sanity.py |
| 42 | PENDING | -- | PENDING | test_create_pds_account | tests/system/check_sanity/test_sanity.py |
| 43 | PENDING | -- | PENDING | test_create_attestation_on_pds | tests/system/check_sanity/test_sanity.py |
| 44 | PENDING | -- | PENDING | test_attestation_ingested_into_postgres | tests/system/check_sanity/test_sanity.py |
| 45 | PENDING | -- | PENDING | test_trust_edge_created_for_did_attestation | tests/system/check_sanity/test_sanity.py |
| 46 | PENDING | -- | PENDING | test_00_five_dinas_with_distinct_identities_and_trust_edges | tests/system/user_stories/test_01_purchase_journey.py |
| 47 | PENDING | -- | PENDING | test_01_alice_reviews_chairs | tests/system/user_stories/test_01_purchase_journey.py |
| 48 | PENDING | -- | PENDING | test_02_bob_reviews_chairs | tests/system/user_stories/test_01_purchase_journey.py |
| 49 | PENDING | -- | PENDING | test_03_diana_reviews_chairs | tests/system/user_stories/test_01_purchase_journey.py |
| 50 | PENDING | -- | PENDING | test_04_unverified_dinas_pump_positive_cheapchair | tests/system/user_stories/test_01_purchase_journey.py |
| 51 | PENDING | -- | PENDING | test_05_all_attestations_ingested | tests/system/user_stories/test_01_purchase_journey.py |
| 52 | PENDING | -- | PENDING | test_06_trust_rings_established | tests/system/user_stories/test_01_purchase_journey.py |
| 53 | PENDING | -- | PENDING | test_07_verified_negatives_for_cheapchair | tests/system/user_stories/test_01_purchase_journey.py |
| 54 | PENDING | -- | PENDING | test_08_verified_positives_for_ergomax | tests/system/user_stories/test_01_purchase_journey.py |
| 55 | PENDING | -- | PENDING | test_09_store_personal_context_in_vault | tests/system/user_stories/test_01_purchase_journey.py |
| 56 | PENDING | -- | PENDING | test_10_store_purchase_decision_in_vault | tests/system/user_stories/test_01_purchase_journey.py |
| 57 | PENDING | -- | PENDING | test_11_dina_gives_personalized_purchase_advice | tests/system/user_stories/test_01_purchase_journey.py |
| 58 | PENDING | -- | PENDING | test_12_five_words_to_personalized_advice | tests/system/user_stories/test_01_purchase_journey.py |
| 59 | PENDING | -- | PENDING | test_00_previous_conversation_stored_in_vault | tests/system/user_stories/test_02_sancho_moment.py |
| 60 | PENDING | -- | PENDING | test_01_sancho_sends_d2d_arrival_message | tests/system/user_stories/test_02_sancho_moment.py |
| 61 | PENDING | -- | PENDING | test_02_alonso_receives_decrypted_d2d_message | tests/system/user_stories/test_02_sancho_moment.py |
| 62 | PENDING | -- | PENDING | test_03_brain_processes_didcomm_arrival | tests/system/user_stories/test_02_sancho_moment.py |
| 63 | PENDING | -- | PENDING | test_04_nudge_was_assembled | tests/system/user_stories/test_02_sancho_moment.py |
| 64 | PENDING | -- | PENDING | test_05_nudge_contains_vault_context | tests/system/user_stories/test_02_sancho_moment.py |
| 65 | PENDING | -- | PENDING | test_06_llm_generates_human_quality_nudge | tests/system/user_stories/test_02_sancho_moment.py |
| 66 | PENDING | -- | PENDING | test_00_seed_creator_profiles | tests/system/user_stories/test_03_dead_internet_filter.py |
| 67 | PENDING | -- | PENDING | test_01_appview_returns_trusted_creator | tests/system/user_stories/test_03_dead_internet_filter.py |
| 68 | PENDING | -- | PENDING | test_02_appview_returns_untrusted_creator | tests/system/user_stories/test_03_dead_internet_filter.py |
| 69 | PENDING | -- | PENDING | test_03_core_resolves_trusted_creator | tests/system/user_stories/test_03_dead_internet_filter.py |
| 70 | PENDING | -- | PENDING | test_04_core_resolves_untrusted_creator | tests/system/user_stories/test_03_dead_internet_filter.py |
| 71 | PENDING | -- | PENDING | test_05_brain_confirms_trusted_creator | tests/system/user_stories/test_03_dead_internet_filter.py |
| 72 | PENDING | -- | PENDING | test_06_brain_flags_untrusted_creator | tests/system/user_stories/test_03_dead_internet_filter.py |
| 73 | PENDING | -- | PENDING | test_07_side_by_side_trust_comparison | tests/system/user_stories/test_03_dead_internet_filter.py |
| 74 | PENDING | -- | PENDING | test_00_seed_health_persona_vault | tests/system/user_stories/test_04_persona_wall.py |
| 75 | PENDING | -- | PENDING | test_01_store_shopping_context | tests/system/user_stories/test_04_persona_wall.py |
| 76 | PENDING | -- | PENDING | test_02_cross_persona_request_blocked | tests/system/user_stories/test_04_persona_wall.py |
| 77 | PENDING | -- | PENDING | test_03_verify_automatic_disclosure_blocked | tests/system/user_stories/test_04_persona_wall.py |
| 78 | PENDING | -- | PENDING | test_04_verify_disclosure_proposal_exists | tests/system/user_stories/test_04_persona_wall.py |
| 79 | PENDING | -- | PENDING | test_05_verify_diagnosis_withheld | tests/system/user_stories/test_04_persona_wall.py |
| 80 | PENDING | -- | PENDING | test_06_verify_proposal_is_useful | tests/system/user_stories/test_04_persona_wall.py |
| 81 | PENDING | -- | PENDING | test_07_approve_disclosure | tests/system/user_stories/test_04_persona_wall.py |
| 82 | PENDING | -- | PENDING | test_08_verify_shared_text_matches_approved | tests/system/user_stories/test_04_persona_wall.py |
| 83 | PENDING | -- | PENDING | test_09_verify_no_diagnosis_in_shared_response | tests/system/user_stories/test_04_persona_wall.py |
| 84 | PENDING | -- | PENDING | test_10_verify_pii_check_clean | tests/system/user_stories/test_04_persona_wall.py |
| 85 | PENDING | -- | PENDING | test_00_register_agent_via_pairing | tests/system/user_stories/test_05_agent_gateway.py |
| 86 | PENDING | -- | PENDING | test_01_verify_agent_in_device_list | tests/system/user_stories/test_05_agent_gateway.py |
| 87 | PENDING | -- | PENDING | test_02_safe_intent_auto_approved | tests/system/user_stories/test_05_agent_gateway.py |
| 88 | PENDING | -- | PENDING | test_03_moderate_intent_flagged | tests/system/user_stories/test_05_agent_gateway.py |
| 89 | PENDING | -- | PENDING | test_04_high_risk_intent_flagged | tests/system/user_stories/test_05_agent_gateway.py |
| 90 | PENDING | -- | PENDING | test_05_unauthenticated_agent_rejected | tests/system/user_stories/test_05_agent_gateway.py |
| 91 | PENDING | -- | PENDING | test_06_blocked_action_denied | tests/system/user_stories/test_05_agent_gateway.py |
| 92 | PENDING | -- | PENDING | test_07_export_data_blocked | tests/system/user_stories/test_05_agent_gateway.py |
| 93 | PENDING | -- | PENDING | test_08_agent_cannot_cross_personas | tests/system/user_stories/test_05_agent_gateway.py |
| 94 | PENDING | -- | PENDING | test_09_revoke_agent_device | tests/system/user_stories/test_05_agent_gateway.py |
| 95 | PENDING | -- | PENDING | test_00_store_personal_context | tests/system/user_stories/test_06_license_renewal.py |
| 96 | PENDING | -- | PENDING | test_01_brain_extracts_license_data | tests/system/user_stories/test_06_license_renewal.py |
| 97 | PENDING | -- | PENDING | test_02_verify_vault_entries | tests/system/user_stories/test_06_license_renewal.py |
| 98 | PENDING | -- | PENDING | test_03_verify_confidence_scores | tests/system/user_stories/test_06_license_renewal.py |
| 99 | PENDING | -- | PENDING | test_04_verify_pii_not_in_searchable_fields | tests/system/user_stories/test_06_license_renewal.py |
| 100 | PENDING | -- | PENDING | test_05_store_and_verify_reminder | tests/system/user_stories/test_06_license_renewal.py |
| 101 | PENDING | -- | PENDING | test_06_reminder_fires_contextual_notification | tests/system/user_stories/test_06_license_renewal.py |
| 102 | PENDING | -- | PENDING | test_07_verify_notification_context | tests/system/user_stories/test_06_license_renewal.py |
| 103 | PENDING | -- | PENDING | test_08_delegation_request_with_enforcement | tests/system/user_stories/test_06_license_renewal.py |
| 104 | PENDING | -- | PENDING | test_09_guardian_reviews_delegation | tests/system/user_stories/test_06_license_renewal.py |
| 105 | PENDING | -- | PENDING | test_00_store_context_for_briefing | tests/system/user_stories/test_07_daily_briefing.py |
| 106 | PENDING | -- | PENDING | test_01_fiduciary_event_interrupts | tests/system/user_stories/test_07_daily_briefing.py |
| 107 | PENDING | -- | PENDING | test_02_engagement_event_queued | tests/system/user_stories/test_07_daily_briefing.py |
| 108 | PENDING | -- | PENDING | test_03_briefing_retrieves_queued_items | tests/system/user_stories/test_07_daily_briefing.py |
| 109 | PENDING | -- | PENDING | test_04_briefing_clear_after_delivery | tests/system/user_stories/test_07_daily_briefing.py |
| 110 | PENDING | -- | PENDING | test_00_store_data_on_node_a | tests/system/user_stories/test_08_move_to_new_machine.py |
| 111 | PENDING | -- | PENDING | test_01_record_identity | tests/system/user_stories/test_08_move_to_new_machine.py |
| 112 | PENDING | -- | PENDING | test_02_data_exportable | tests/system/user_stories/test_08_move_to_new_machine.py |
| 113 | PENDING | -- | PENDING | test_03_node_b_has_same_identity_scheme | tests/system/user_stories/test_08_move_to_new_machine.py |
| 114 | PENDING | -- | PENDING | test_04_vault_operations_work_on_node_b | tests/system/user_stories/test_08_move_to_new_machine.py |
| 115 | PENDING | -- | PENDING | test_05_seed_based_did_derivation | tests/system/user_stories/test_08_move_to_new_machine.py |
| 116 | PENDING | -- | PENDING | test_06_export_creates_archive | tests/system/user_stories/test_08_move_to_new_machine.py |
| 117 | PENDING | -- | PENDING | test_07_migration_roundtrip | tests/system/user_stories/test_08_move_to_new_machine.py |
| 118 | PENDING | -- | PENDING | test_00_core_healthy_baseline | tests/system/user_stories/test_09_connector_expiry.py |
| 119 | PENDING | -- | PENDING | test_01_vault_works_without_brain | tests/system/user_stories/test_09_connector_expiry.py |
| 120 | PENDING | -- | PENDING | test_02_brain_down_error_clear | tests/system/user_stories/test_09_connector_expiry.py |
| 121 | PENDING | -- | PENDING | test_03_recovery_after_outage | tests/system/user_stories/test_09_connector_expiry.py |
| 122 | PENDING | -- | PENDING | test_04_did_works_independently | tests/system/user_stories/test_09_connector_expiry.py |
| 123 | PENDING | -- | PENDING | test_00_record_baseline_did | tests/system/user_stories/test_10_operator_journey.py |
| 124 | PENDING | -- | PENDING | test_01_did_stable_across_requests | tests/system/user_stories/test_10_operator_journey.py |
| 125 | PENDING | -- | PENDING | test_02_persona_recreate_idempotent | tests/system/user_stories/test_10_operator_journey.py |
| 126 | PENDING | -- | PENDING | test_03_healthz_stable | tests/system/user_stories/test_10_operator_journey.py |
| 127 | PENDING | -- | PENDING | test_04_locked_persona_clear_error | tests/system/user_stories/test_10_operator_journey.py |
| 128 | PENDING | -- | PENDING | test_00_store_relationship_context | tests/system/user_stories/test_11_anti_her.py |
| 129 | PENDING | -- | PENDING | test_01_neglected_contact_nudge_in_briefing | tests/system/user_stories/test_11_anti_her.py |
| 130 | PENDING | -- | PENDING | test_02_life_event_followup_via_d2d | tests/system/user_stories/test_11_anti_her.py |
| 131 | PENDING | -- | PENDING | test_03_anti_her_filter_strips_anthropomorphic_language | tests/system/user_stories/test_11_anti_her.py |
| 132 | PENDING | -- | PENDING | test_04_dina_suggests_humans_not_herself | tests/system/user_stories/test_11_anti_her.py |
| 133 | PENDING | -- | PENDING | test_05_direct_loneliness_gets_human_redirect | tests/system/user_stories/test_11_anti_her.py |
| 134 | PENDING | -- | PENDING | test_06_reject_emotional_companion_role | tests/system/user_stories/test_11_anti_her.py |
| 135 | PENDING | -- | PENDING | test_07_factual_emotion_question_not_blocked | tests/system/user_stories/test_11_anti_her.py |
| 136 | PENDING | -- | PENDING | test_00_trust_data_seeded | tests/system/user_stories/test_12_verified_truth.py |
| 137 | PENDING | -- | PENDING | test_01_trust_resolve_via_appview | tests/system/user_stories/test_12_verified_truth.py |
| 138 | PENDING | -- | PENDING | test_02_zero_trust_data_honest_uncertainty | tests/system/user_stories/test_12_verified_truth.py |
| 139 | PENDING | -- | PENDING | test_03_conflicting_trust_attestations_stored | tests/system/user_stories/test_12_verified_truth.py |
| 140 | PENDING | -- | PENDING | test_04_vault_query_returns_sources | tests/system/user_stories/test_12_verified_truth.py |
| 141 | PENDING | -- | PENDING | test_05_sparse_attestations_conflict_acknowledged | tests/system/user_stories/test_12_verified_truth.py |
| 142 | PENDING | -- | PENDING | test_06_seed_dense_trust_attestations | tests/system/user_stories/test_12_verified_truth.py |
| 143 | PENDING | -- | PENDING | test_07_dense_data_confident_with_attribution | tests/system/user_stories/test_12_verified_truth.py |
| 144 | PENDING | -- | PENDING | test_08_vault_preserves_reviewer_attribution | tests/system/user_stories/test_12_verified_truth.py |
| 145 | PENDING | -- | PENDING | test_00_fiduciary_from_trusted_source_interrupts | tests/system/user_stories/test_13_silence_stress.py |
| 146 | PENDING | -- | PENDING | test_01_urgent_from_unknown_is_engagement | tests/system/user_stories/test_13_silence_stress.py |
| 147 | PENDING | -- | PENDING | test_02_dnd_hierarchy_enforced | tests/system/user_stories/test_13_silence_stress.py |
| 148 | PENDING | -- | PENDING | test_00_unauthenticated_agent_blocked | tests/system/user_stories/test_14_agent_sandbox.py |
| 149 | PENDING | -- | PENDING | test_01_revoked_agent_blocked_immediately | tests/system/user_stories/test_14_agent_sandbox.py |
| 150 | PENDING | -- | PENDING | test_02_blocked_actions_categorically_denied | tests/system/user_stories/test_14_agent_sandbox.py |
| 151 | PENDING | -- | PENDING | test_03_caller_supplied_agent_did_ignored | tests/system/user_stories/test_14_agent_sandbox.py |

## CORE (1166/2163 tagged -- 53%)

| # | Status | Current Tag | Name Status | Test Function | File |
|---|--------|------------|-------------|---------------|------|
| 1 | TAGGED | TST-CORE-541 | PENDING | TestAdminProxy_12_1_ProxyToBrainAdminUI | core/test/adminproxy_test.go |
| 2 | TAGGED | TST-CORE-542 | PENDING | TestAdminProxy_12_2_AuthRequired | core/test/adminproxy_test.go |
| 3 | TAGGED | TST-CORE-543 | PENDING | TestAdminProxy_12_3_StaticAssetProxying | core/test/adminproxy_test.go |
| 4 | TAGGED | TST-CORE-544 | PENDING | TestAdminProxy_12_4_WebSocketUpgradeProxy | core/test/adminproxy_test.go |
| 5 | TAGGED | TST-CORE-897 | PENDING | TestAdminProxy_12_5_CSRFTokenInjectedInResponse | core/test/adminproxy_test.go |
| 6 | TAGGED | TST-CORE-639 | PENDING | TestAPIContract_18_1_VaultQueryExposed | core/test/apicontract_test.go |
| 7 | TAGGED | TST-CORE-640 | PENDING | TestAPIContract_18_2_VaultStoreExposed | core/test/apicontract_test.go |
| 8 | TAGGED | TST-CORE-641 | PENDING | TestAPIContract_18_3_DIDSignAdminOnly | core/test/apicontract_test.go |
| 9 | TAGGED | TST-CORE-642 | PENDING | TestAPIContract_18_4_DIDVerifyExposed | core/test/apicontract_test.go |
| 10 | TAGGED | TST-CORE-643 | PENDING | TestAPIContract_18_5_PIIScrubExposed | core/test/apicontract_test.go |
| 11 | TAGGED | TST-CORE-644 | PENDING | TestAPIContract_18_6_NotifyExposed | core/test/apicontract_test.go |
| 12 | TAGGED | TST-CORE-645 | PENDING | TestAPIContract_18_7_AllBrainEndpointsAcceptToken | core/test/apicontract_test.go |
| 13 | TAGGED | TST-CORE-646 | PENDING | TestAPIContract_18_8_ExactAPIServiceMatch | core/test/apicontract_test.go |
| 14 | TAGGED | TST-CORE-647 | PENDING | TestAPIContract_18_9_MsgSendExposed | core/test/apicontract_test.go |
| 15 | TAGGED | TST-CORE-648 | PENDING | TestAPIContract_18_10_TrustQueryExposed | core/test/apicontract_test.go |
| 16 | TAGGED | TST-CORE-906 | PENDING | TestAPIContract_18_11_VaultCrashMissingFieldsRejected | core/test/apicontract_test.go |
| 17 | TAGGED | TST-CORE-907 | PENDING | TestAPIContract_18_12_VaultQueryResponseSchema | core/test/apicontract_test.go |
| 18 | TAGGED | TST-CORE-908 | PENDING | TestAPIContract_18_13_VaultStoreResponseIDFormat | core/test/apicontract_test.go |
| 19 | TAGGED | TST-CORE-909 | PENDING | TestAPIContract_18_14_VaultQueryMissingPersonaField | core/test/apicontract_test.go |
| 20 | TAGGED | TST-CORE-910 | PENDING | TestAPIContract_18_15_CoreCallsOnlyDocumentedBrainEndpoints | core/test/apicontract_test.go |
| 21 | TAGGED | TST-CORE-1016 | PENDING | TestCI_30_8_ContractCoreBrainStage | core/test/apicontract_test.go |
| 22 | PENDING | -- | PENDING | TestCI_30_8_ContractCoreBrainStage/all_brain_callable_endpoints_accept_brain_token | core/test/apicontract_test.go |
| 23 | PENDING | -- | PENDING | TestCI_30_8_ContractCoreBrainStage/all_admin_endpoints_reject_brain_token | core/test/apicontract_test.go |
| 24 | PENDING | -- | PENDING | TestCI_30_8_ContractCoreBrainStage/registered_endpoint_list_is_comprehensive | core/test/apicontract_test.go |
| 25 | PENDING | -- | PENDING | TestCI_30_8_ContractCoreBrainStage/brain_callable_and_admin_only_are_disjoint | core/test/apicontract_test.go |
| 26 | PENDING | -- | PENDING | TestCI_30_8_ContractCoreBrainStage/health_endpoints_are_brain_callable | core/test/apicontract_test.go |
| 27 | PENDING | -- | PENDING | TestCI_30_8_ContractCoreBrainStage/contract_delegates_to_real_auth_checker | core/test/apicontract_test.go |
| 28 | TAGGED | TST-CORE-910 | PENDING | TestApproval_PreviewContainsSummary | core/test/approval_preview_test.go |
| 29 | TAGGED | TST-CORE-911 | PENDING | TestApproval_PreviewContainsQueryText | core/test/approval_preview_test.go |
| 30 | TAGGED | TST-CORE-912 | PENDING | TestApproval_PreviewNotInGrant | core/test/approval_preview_test.go |
| 31 | TAGGED | TST-CORE-913 | PENDING | TestApproval_PreviewTruncation | core/test/approval_preview_test.go |
| 32 | TAGGED | TST-CORE-001 | PENDING | TestAuth_1_1_ServiceKeyAuth | core/test/auth_test.go |
| 33 | PENDING | -- | PENDING | TestAuth_1_1_ServiceKeyAuth/1_ValidSignature | core/test/auth_test.go |
| 34 | PENDING | -- | PENDING | TestAuth_1_1_ServiceKeyAuth/2_WrongSignature | core/test/auth_test.go |
| 35 | PENDING | -- | PENDING | TestAuth_1_1_ServiceKeyAuth/3_UnknownDID | core/test/auth_test.go |
| 36 | PENDING | -- | PENDING | TestAuth_1_1_ServiceKeyAuth/4_ExpiredTimestamp | core/test/auth_test.go |
| 37 | PENDING | -- | PENDING | TestAuth_1_1_ServiceKeyAuth/5_BearerTokenNoLongerReturnsService | core/test/auth_test.go |
| 38 | TAGGED | TST-CORE-005 | PENDING | TestAuth_1_1_ServiceKeyAuth/6_EmptyBearerValue | core/test/auth_test.go |
| 39 | PENDING | -- | PENDING | TestAuth_1_1_ServiceKeyAuth/7_WhitespaceOnlyBearerValue | core/test/auth_test.go |
| 40 | TAGGED | TST-CORE-007 | PENDING | TestAuth_1_1_7_MissingTokenFileIgnored | core/test/auth_test.go |
| 41 | TAGGED | TST-CORE-008 | PENDING | TestAuth_1_1_8_EmptyTokenFileIgnored | core/test/auth_test.go |
| 42 | TAGGED | TST-CORE-009 | PENDING | TestAuth_1_1_9_TimingAttackResistance | core/test/auth_test.go |
| 43 | TAGGED | TST-CORE-010 | PENDING | TestAuth_1_2_ClientToken | core/test/auth_test.go |
| 44 | TAGGED | TST-CORE-013 | PENDING | TestAuth_1_2_4_ClientTokenOnBrainEndpoint | core/test/auth_test.go |
| 45 | TAGGED | TST-CORE-014 | PENDING | TestAuth_1_2_5_UnknownTokenRejected | core/test/auth_test.go |
| 46 | TAGGED | TST-CORE-015 | PENDING | TestAuth_1_2_6_ConcurrentDeviceSessions | core/test/auth_test.go |
| 47 | TAGGED | TST-CORE-016 | PENDING | TestAuth_1_2_7_ClientTokenConstantTime | core/test/auth_test.go |
| 48 | TAGGED | TST-CORE-017 | PENDING | TestAuth_1_3_BrowserSession | core/test/auth_test.go |
| 49 | TAGGED | TST-CORE-017 | PENDING | TestAuth_1_3_BrowserSession/1_LoginCorrectPassphrase | core/test/auth_test.go |
| 50 | TAGGED | TST-CORE-018 | PENDING | TestAuth_1_3_BrowserSession/2_LoginWrongPassphrase | core/test/auth_test.go |
| 51 | TAGGED | TST-CORE-019 | PENDING | TestAuth_1_3_BrowserSession/3_SessionCookieBearerTranslation | core/test/auth_test.go |
| 52 | TAGGED | TST-CORE-020 | PENDING | TestAuth_1_3_BrowserSession/4_ExpiredSessionCookie | core/test/auth_test.go |
| 53 | TAGGED | TST-CORE-021 | PENDING | TestAuth_1_3_BrowserSession/5_CSRFMissingHeader | core/test/auth_test.go |
| 54 | TAGGED | TST-CORE-022 | PENDING | TestAuth_1_3_BrowserSession/6_CSRFMismatch | core/test/auth_test.go |
| 55 | TAGGED | TST-CORE-023 | PENDING | TestAuth_1_3_BrowserSession/7_SessionFixationResistance | core/test/auth_test.go |
| 56 | TAGGED | TST-CORE-024 | PENDING | TestAuth_1_3_BrowserSession/8_ConcurrentBrowserSessions | core/test/auth_test.go |
| 57 | TAGGED | TST-CORE-025 | PENDING | TestAuth_1_3_BrowserSession/9_Logout | core/test/auth_test.go |
| 58 | TAGGED | TST-CORE-026 | PENDING | TestAuth_1_3_BrowserSession/10_CookieAttributes | core/test/auth_test.go |
| 59 | TAGGED | TST-CORE-027 | PENDING | TestAuth_1_3_BrowserSession/11_LoginRateLimit5PerMinPerIP | core/test/auth_test.go |
| 60 | TAGGED | TST-CORE-028 | PENDING | TestAuth_1_3_BrowserSession/12_SessionStorageInMemory | core/test/auth_test.go |
| 61 | TAGGED | TST-CORE-029 | PENDING | TestAuth_1_3_BrowserSession/13_SessionTTLConfigurable | core/test/auth_test.go |
| 62 | TAGGED | TST-CORE-030 | PENDING | TestAuth_1_3_BrowserSession/14_SessionIDGeneration | core/test/auth_test.go |
| 63 | TAGGED | TST-CORE-031 | PENDING | TestAuth_1_3_BrowserSession/15_CookieMaxAgeMatchesTTL | core/test/auth_test.go |
| 64 | TAGGED | TST-CORE-032 | PENDING | TestAuth_1_3_BrowserSession/16_SuccessfulLogin302 | core/test/auth_test.go |
| 65 | TAGGED | TST-CORE-033 | PENDING | TestAuth_1_3_BrowserSession/17_LoginPageGoEmbed | core/test/auth_test.go |
| 66 | TAGGED | TST-CORE-034 | PENDING | TestAuth_1_3_BrowserSession/18_DeviceAppBearerPassthrough | core/test/auth_test.go |
| 67 | TAGGED | TST-CORE-035 | PENDING | TestAuth_1_3_BrowserSession/19_NoCookieShowsLoginPage | core/test/auth_test.go |
| 68 | TAGGED | TST-CORE-036 | PENDING | TestAuth_1_3_BrowserSession/20_ConvenienceModeAdminPassphrase | core/test/auth_test.go |
| 69 | TAGGED | TST-CORE-037 | PENDING | TestAuth_1_3_BrowserSession/21_BrainNeverSeesCookies | core/test/auth_test.go |
| 70 | TAGGED | TST-CORE-038 | PENDING | TestAuth_1_4_AuthSurface | core/test/auth_test.go |
| 71 | TAGGED | TST-CORE-038 | PENDING | TestAuth_1_4_AuthSurface/1_NoThirdAuthMechanism | core/test/auth_test.go |
| 72 | TAGGED | TST-CORE-039 | PENDING | TestAuth_1_4_AuthSurface/2_UnknownAuthSchemeIgnored | core/test/auth_test.go |
| 73 | TAGGED | TST-CORE-040 | PENDING | TestAuth_1_4_AuthSurface/3_ExternalJWTRejected | core/test/auth_test.go |
| 74 | TAGGED | TST-CORE-041 | PENDING | TestAuth_1_4_AuthSurface/4_NoPluginEndpoints | core/test/auth_test.go |
| 75 | TAGGED | TST-CORE-042 | PENDING | TestAuth_1_4_AuthSurface/5_UnregisteredTokenRejected | core/test/auth_test.go |
| 76 | TAGGED | TST-CORE-043 | PENDING | TestAuth_1_4_AuthSurface/6_ClientTokenIdentified | core/test/auth_test.go |
| 77 | TAGGED | TST-CORE-044 | PENDING | TestAuth_1_4_AuthSurface/7_RandomTokenRejected | core/test/auth_test.go |
| 78 | TAGGED | TST-CORE-045 | PENDING | TestAuth_1_4_AuthSurface/8_ClientTokenFullAccess | core/test/auth_test.go |
| 79 | TAGGED | TST-CORE-046 | PENDING | TestAuth_1_4_AuthSurface/9_CoreNeverCallsExternalAPIs | core/test/auth_test.go |
| 80 | TAGGED | TST-CORE-047 | PENDING | TestAuth_1_5_CompromisedBrain | core/test/auth_test.go |
| 81 | TAGGED | TST-CORE-047 | PENDING | TestAuth_1_5_CompromisedBrain/1_BrainAccessesOpenPersona | core/test/auth_test.go |
| 82 | TAGGED | TST-CORE-048 | PENDING | TestAuth_1_5_CompromisedBrain/2_BrainCannotAccessLocked | core/test/auth_test.go |
| 83 | TAGGED | TST-CORE-049 | PENDING | TestAuth_1_5_CompromisedBrain/3_RestrictedCreatesAuditTrail | core/test/auth_test.go |
| 84 | TAGGED | TST-CORE-050 | PENDING | TestAuth_1_5_CompromisedBrain/4_BrainCannotCallDIDSign | core/test/auth_test.go |
| 85 | TAGGED | TST-CORE-051 | PENDING | TestAuth_1_5_CompromisedBrain/5_BrainCannotCallDIDRotate | core/test/auth_test.go |
| 86 | TAGGED | TST-CORE-052 | PENDING | TestAuth_1_5_CompromisedBrain/6_BrainCannotCallVaultBackup | core/test/auth_test.go |
| 87 | TAGGED | TST-CORE-053 | PENDING | TestAuth_1_5_CompromisedBrain/7_BrainCannotCallPersonaUnlock | core/test/auth_test.go |
| 88 | TAGGED | TST-CORE-054 | PENDING | TestAuth_1_5_CompromisedBrain/8_BrainCannotBypassPIIScrubber | core/test/auth_test.go |
| 89 | TAGGED | TST-CORE-055 | PENDING | TestAuth_1_5_CompromisedBrain/9_BrainCannotAccessRawVaultFiles | core/test/auth_test.go |
| 90 | TAGGED | TST-CORE-017 | PENDING | TestAuth_1_3_1_LoginCorrectPassphrase | core/test/auth_test.go |
| 91 | TAGGED | TST-CORE-018 | PENDING | TestAuth_1_3_2_LoginWrongPassphrase | core/test/auth_test.go |
| 92 | TAGGED | TST-CORE-019 | PENDING | TestAuth_1_3_3_SessionCookieToBearerTranslation | core/test/auth_test.go |
| 93 | TAGGED | TST-CORE-020 | PENDING | TestAuth_1_3_4_ExpiredSessionCookie | core/test/auth_test.go |
| 94 | TAGGED | TST-CORE-021 | PENDING | TestAuth_1_3_5_CSRFMissingHeader | core/test/auth_test.go |
| 95 | TAGGED | TST-CORE-022 | PENDING | TestAuth_1_3_6_CSRFMismatch | core/test/auth_test.go |
| 96 | TAGGED | TST-CORE-023 | PENDING | TestAuth_1_3_7_SessionFixationResistance | core/test/auth_test.go |
| 97 | TAGGED | TST-CORE-024 | PENDING | TestAuth_1_3_8_ConcurrentBrowserSessions | core/test/auth_test.go |
| 98 | TAGGED | TST-CORE-025 | PENDING | TestAuth_1_3_9_Logout | core/test/auth_test.go |
| 99 | TAGGED | TST-CORE-026 | PENDING | TestAuth_1_3_10_CookieAttributes | core/test/auth_test.go |
| 100 | TAGGED | TST-CORE-027 | PENDING | TestAuth_1_3_11_LoginRateLimit | core/test/auth_test.go |
| 101 | TAGGED | TST-CORE-028 | PENDING | TestAuth_1_3_12_SessionStorageLostOnRestart | core/test/auth_test.go |
| 102 | TAGGED | TST-CORE-029 | PENDING | TestAuth_1_3_13_SessionTTLConfigurable | core/test/auth_test.go |
| 103 | TAGGED | TST-CORE-030 | PENDING | TestAuth_1_3_14_SessionIDGeneration | core/test/auth_test.go |
| 104 | TAGGED | TST-CORE-031 | PENDING | TestAuth_1_3_15_CookieMaxAgeMatchesTTL | core/test/auth_test.go |
| 105 | TAGGED | TST-CORE-032 | PENDING | TestAuth_1_3_16_SuccessfulLogin302Redirect | core/test/auth_test.go |
| 106 | TAGGED | TST-CORE-033 | PENDING | TestAuth_1_3_17_LoginPageGoEmbed | core/test/auth_test.go |
| 107 | TAGGED | TST-CORE-034 | PENDING | TestAuth_1_3_18_DeviceBearerPassthrough | core/test/auth_test.go |
| 108 | TAGGED | TST-CORE-035 | PENDING | TestAuth_1_3_19_NoCookieShowsLoginPage | core/test/auth_test.go |
| 109 | TAGGED | TST-CORE-036 | PENDING | TestAuth_1_3_20_ConvenienceModeAdminPassphrase | core/test/auth_test.go |
| 110 | TAGGED | TST-CORE-037 | PENDING | TestAuth_1_3_21_BrainNeverSeesCookies | core/test/auth_test.go |
| 111 | TAGGED | TST-CORE-038 | PENDING | TestAuth_1_4_1_NoThirdAuthMechanism | core/test/auth_test.go |
| 112 | TAGGED | TST-CORE-039 | PENDING | TestAuth_1_4_2_UnknownSchemeIgnored | core/test/auth_test.go |
| 113 | TAGGED | TST-CORE-040 | PENDING | TestAuth_1_4_3_ExternalJWTRejected | core/test/auth_test.go |
| 114 | TAGGED | TST-CORE-041 | PENDING | TestAuth_1_4_4_NoPluginEndpoints | core/test/auth_test.go |
| 115 | TAGGED | TST-CORE-042 | PENDING | TestAuth_1_4_5_UnregisteredTokenRejected | core/test/auth_test.go |
| 116 | TAGGED | TST-CORE-043 | PENDING | TestAuth_1_4_6_IdentifyTokenFallback | core/test/auth_test.go |
| 117 | TAGGED | TST-CORE-044 | PENDING | TestAuth_1_4_7_IsAdminEndpointAllowlist | core/test/auth_test.go |
| 118 | TAGGED | TST-CORE-045 | PENDING | TestAuth_1_4_8_ClientTokenFullAccess | core/test/auth_test.go |
| 119 | PENDING | -- | PENDING | TestAuth_1_4_9_DeviceScopedBlockedFromVault | core/test/auth_test.go |
| 120 | PENDING | -- | PENDING | TestAuth_1_4_10_AdminStillAccessesVault | core/test/auth_test.go |
| 121 | PENDING | -- | PENDING | TestAuth_1_5_1_BrainServiceAllowlist | core/test/auth_test.go |
| 122 | PENDING | -- | PENDING | TestAuth_1_5_2_AdminServiceAllowlist | core/test/auth_test.go |
| 123 | PENDING | -- | PENDING | TestAuth_1_5_3_ConnectorServiceAllowlist | core/test/auth_test.go |
| 124 | PENDING | -- | PENDING | TestAuth_1_5_4_UnknownServiceDenied | core/test/auth_test.go |
| 125 | PENDING | -- | PENDING | TestAuth_1_5_5_ServiceIsolationCrossCheck | core/test/auth_test.go |
| 126 | PENDING | -- | PENDING | TestAuth_1_5_6_RuntimeServiceKeyIsolation | core/test/auth_test.go |
| 127 | TAGGED | TST-CORE-046 | PENDING | TestAuth_1_4_9_CoreNeverCallsExternalAPIs | core/test/auth_test.go |
| 128 | TAGGED | TST-CORE-047 | PENDING | TestAuth_1_5_1_BrainAccessesOpenPersona | core/test/auth_test.go |
| 129 | TAGGED | TST-CORE-048 | PENDING | TestAuth_1_5_2_BrainCannotAccessLocked | core/test/auth_test.go |
| 130 | TAGGED | TST-CORE-049 | PENDING | TestAuth_1_5_3_RestrictedCreatesDetectionTrail | core/test/auth_test.go |
| 131 | TAGGED | TST-CORE-050 | PENDING | TestAuth_1_5_4_BrainCannotCallDIDSign | core/test/auth_test.go |
| 132 | TAGGED | TST-CORE-051 | PENDING | TestAuth_1_5_5_BrainCannotCallDIDRotate | core/test/auth_test.go |
| 133 | TAGGED | TST-CORE-052 | PENDING | TestAuth_1_5_6_BrainCannotCallVaultBackup | core/test/auth_test.go |
| 134 | TAGGED | TST-CORE-053 | PENDING | TestAuth_1_5_7_BrainCannotCallPersonaUnlock | core/test/auth_test.go |
| 135 | TAGGED | TST-CORE-054 | PENDING | TestAuth_1_5_8_BrainCannotBypassPIIScrubber | core/test/auth_test.go |
| 136 | TAGGED | TST-CORE-055 | PENDING | TestAuth_1_5_9_BrainCannotAccessRawVaultFiles | core/test/auth_test.go |
| 137 | PENDING | -- | PENDING | TestAuth_1_6_9_ConcurrentTokenValidation | core/test/auth_test.go |
| 138 | PENDING | -- | PENDING | TestAuth_1_1_5_ConcurrentTokenValidationThreadSafe | core/test/auth_test.go |
| 139 | PENDING | -- | PENDING | TestAuth_1_1_5_ConcurrentTokenValidationThreadSafe/100_goroutines_validate_same_valid_token_all_succeed | core/test/auth_test.go |
| 140 | PENDING | -- | PENDING | TestAuth_1_1_5_ConcurrentTokenValidationThreadSafe/100_goroutines_validate_invalid_token_all_reject | core/test/auth_test.go |
| 141 | PENDING | -- | PENDING | TestAuth_1_1_5_ConcurrentTokenValidationThreadSafe/concurrent_mixed_valid_and_invalid_tokens | core/test/auth_test.go |
| 142 | PENDING | -- | PENDING | TestAuth_1_1_5_ConcurrentTokenValidationThreadSafe/concurrent_registration_and_validation | core/test/auth_test.go |
| 143 | PENDING | -- | PENDING | TestAuth_1_1_5_ConcurrentTokenValidationThreadSafe/positive_control_sequential_validation_works | core/test/auth_test.go |
| 144 | TAGGED | TST-CORE-1097 | PENDING | TestAuthz_1_6_1_BrainServiceKeyOnDIDSign_Forbidden | core/test/authz_test.go |
| 145 | TAGGED | TST-CORE-1098 | PENDING | TestAuthz_1_6_2_ClientTokenOnDIDSign_Allowed | core/test/authz_test.go |
| 146 | TAGGED | TST-CORE-1099 | PENDING | TestAuthz_1_6_3_BrainServiceKeyOnVaultQuery_Allowed | core/test/authz_test.go |
| 147 | TAGGED | TST-CORE-1100 | PENDING | TestAuthz_1_6_4_BrainServiceKeyOnAdminEndpoints_Forbidden | core/test/authz_test.go |
| 148 | TAGGED | TST-CORE-1101 | PENDING | TestAuthz_1_6_5_ClientTokenOnAllEndpoints_Allowed | core/test/authz_test.go |
| 149 | TAGGED | TST-CORE-1102 | PENDING | TestAuthz_1_6_6_BrainServiceKeyOnAllowedPaths_OK | core/test/authz_test.go |
| 150 | TAGGED | TST-CORE-1103 | PENDING | TestAuthz_1_6_7_UnauthenticatedPublicPaths_PassThrough | core/test/authz_test.go |
| 151 | TAGGED | TST-CORE-1104 | PENDING | TestAuthz_1_6_8_ExplicitContextTokenKind | core/test/authz_test.go |
| 152 | PENDING | -- | PENDING | TestAuthz_1_6_8_ExplicitContextTokenKind/brain_on_admin_path | core/test/authz_test.go |
| 153 | PENDING | -- | PENDING | TestAuthz_1_6_8_ExplicitContextTokenKind/client_on_admin_path | core/test/authz_test.go |
| 154 | PENDING | -- | PENDING | TestAuthz_1_6_8_ExplicitContextTokenKind/brain_on_vault_query | core/test/authz_test.go |
| 155 | PENDING | -- | PENDING | TestAuthz_1_6_8_ExplicitContextTokenKind/unknown_kind_on_any_path | core/test/authz_test.go |
| 156 | TAGGED | TST-CORE-990 | PENDING | TestAuthz_30_2_MatrixEveryAdminEndpointRejectsServiceSigAuth | core/test/authz_test.go |
| 157 | PENDING | -- | PENDING | TestAuthz_30_2_MatrixEveryAdminEndpointRejectsServiceSigAuth/positive_control_ | core/test/authz_test.go |
| 158 | PENDING | -- | PENDING | TestAuth_1_1_MissingAndMalformedAuthorizationHeader | core/test/authz_test.go |
| 159 | PENDING | -- | PENDING | TestAuth_1_1_MissingAndMalformedAuthorizationHeader/missing_Authorization_header_returns_401 | core/test/authz_test.go |
| 160 | PENDING | -- | PENDING | TestAuth_1_1_MissingAndMalformedAuthorizationHeader/malformed_header_Basic_instead_of_Bearer_returns_401 | core/test/authz_test.go |
| 161 | PENDING | -- | PENDING | TestAuth_1_1_MissingAndMalformedAuthorizationHeader/wrong_Bearer_token_value_returns_401 | core/test/authz_test.go |
| 162 | PENDING | -- | PENDING | TestAuth_1_1_MissingAndMalformedAuthorizationHeader/empty_Bearer_value_returns_401 | core/test/authz_test.go |
| 163 | PENDING | -- | PENDING | TestAuth_1_1_MissingAndMalformedAuthorizationHeader/Bearer_with_leading_trailing_whitespace_returns_401 | core/test/authz_test.go |
| 164 | PENDING | -- | PENDING | TestAuth_1_1_MissingAndMalformedAuthorizationHeader/positive_control_valid_client_token_accepted | core/test/authz_test.go |
| 165 | PENDING | -- | PENDING | TestAuth_1_1_MissingAndMalformedAuthorizationHeader/positive_control_public_path_no_header_accepted | core/test/authz_test.go |
| 166 | TAGGED | TST-CORE-858 | PENDING | TestBotInterface_25_1_QuerySanitizationNoDIDNoMedical | core/test/bot_test.go |
| 167 | TAGGED | TST-CORE-859 | PENDING | TestBotInterface_25_2_QueryProtocolSchema | core/test/bot_test.go |
| 168 | TAGGED | TST-CORE-860 | PENDING | TestBotInterface_25_3_LocalBotScoreTracking | core/test/bot_test.go |
| 169 | TAGGED | TST-CORE-861 | PENDING | TestBotInterface_25_4_DeepLinkAttributionValidation | core/test/bot_test.go |
| 170 | TAGGED | TST-CORE-1118 | PENDING | TestBotInterface_33_1_BotResponseWithoutAttributionRejectedAtIngestion | core/test/bot_test.go |
| 171 | PENDING | -- | PENDING | TestBotInterface_33_1_BotResponseWithoutAttributionRejectedAtIngestion/empty_attribution_rejected | core/test/bot_test.go |
| 172 | PENDING | -- | PENDING | TestBotInterface_33_1_BotResponseWithoutAttributionRejectedAtIngestion/non_url_attribution_rejected | core/test/bot_test.go |
| 173 | PENDING | -- | PENDING | TestBotInterface_33_1_BotResponseWithoutAttributionRejectedAtIngestion/whitespace_only_attribution_rejected | core/test/bot_test.go |
| 174 | PENDING | -- | PENDING | TestBotInterface_33_1_BotResponseWithoutAttributionRejectedAtIngestion/protocol_relative_url_rejected | core/test/bot_test.go |
| 175 | PENDING | -- | PENDING | TestBotInterface_33_1_BotResponseWithoutAttributionRejectedAtIngestion/positive_control_https_url_accepted | core/test/bot_test.go |
| 176 | PENDING | -- | PENDING | TestBotInterface_33_1_BotResponseWithoutAttributionRejectedAtIngestion/positive_control_http_url_accepted | core/test/bot_test.go |
| 177 | PENDING | -- | PENDING | TestBotInterface_33_1_BotResponseWithoutAttributionRejectedAtIngestion/trust_penalty_for_stripped_attribution | core/test/bot_test.go |
| 178 | TAGGED | TST-CORE-531 | PENDING | TestBrainClient_11_1_1_HealthyBrain | core/test/brainclient_test.go |
| 179 | TAGGED | TST-CORE-532 | PENDING | TestBrainClient_11_1_2_BrainTimeout | core/test/brainclient_test.go |
| 180 | TAGGED | TST-CORE-533 | PENDING | TestBrainClient_11_1_3_CircuitBreakerOpens | core/test/brainclient_test.go |
| 181 | TAGGED | TST-CORE-534 | PENDING | TestBrainClient_11_1_4_CircuitBreakerHalfOpen | core/test/brainclient_test.go |
| 182 | TAGGED | TST-CORE-535 | PENDING | TestBrainClient_11_1_5_CircuitBreakerCloses | core/test/brainclient_test.go |
| 183 | TAGGED | TST-CORE-536 | PENDING | TestBrainClient_11_1_6_BrainCrashRecovery | core/test/brainclient_test.go |
| 184 | TAGGED | TST-CORE-537 | PENDING | TestBrainClient_11_2_1_BrainHealthy | core/test/brainclient_test.go |
| 185 | TAGGED | TST-CORE-538 | PENDING | TestBrainClient_11_2_2_BrainUnhealthy | core/test/brainclient_test.go |
| 186 | TAGGED | TST-CORE-539 | PENDING | TestBrainClient_11_2_3_BrainRecovery | core/test/brainclient_test.go |
| 187 | TAGGED | TST-CORE-540 | PENDING | TestBrainClient_11_2_4_WatchdogInterval | core/test/brainclient_test.go |
| 188 | TAGGED | TST-CORE-843 | PENDING | TestBrainClient_11_3_1_SendEventToBrain | core/test/brainclient_test.go |
| 189 | TAGGED | TST-CORE-844 | PENDING | TestBrainClient_11_3_2_BrainReturnsError | core/test/brainclient_test.go |
| 190 | TAGGED | TST-CORE-845 | PENDING | TestBrainClient_11_1_7_BrainReturnsMalformedJSON | core/test/brainclient_test.go |
| 191 | TAGGED | TST-CORE-846 | PENDING | TestBrainClient_11_1_8_ConcurrentRequests | core/test/brainclient_test.go |
| 192 | TAGGED | TST-CORE-847 | PENDING | TestBrainClient_11_1_9_EmptyURLReturnsError | core/test/brainclient_test.go |
| 193 | TAGGED | TST-CORE-848 | PENDING | TestBrainClient_11_1_10_ConnectionPooling | core/test/brainclient_test.go |
| 194 | TAGGED | TST-CORE-849 | PENDING | TestBrainClient_11_1_11_MockHealthSuccess | core/test/brainclient_test.go |
| 195 | TAGGED | TST-CORE-850 | PENDING | TestBrainClient_11_1_12_MockHealthFailure | core/test/brainclient_test.go |
| 196 | TAGGED | TST-CORE-531 | PENDING | TestBrainClient_11_Overview | core/test/brainclient_test.go |
| 197 | PENDING | -- | PENDING | TestBrainClient_11_Overview/healthy | core/test/brainclient_test.go |
| 198 | PENDING | -- | PENDING | TestBrainClient_11_Overview/timeout | core/test/brainclient_test.go |
| 199 | PENDING | -- | PENDING | TestBrainClient_11_Overview/cb_open | core/test/brainclient_test.go |
| 200 | PENDING | -- | PENDING | TestBrainClient_11_Overview/cb_half_open | core/test/brainclient_test.go |
| 201 | PENDING | -- | PENDING | TestBrainClient_11_Overview/cb_close | core/test/brainclient_test.go |
| 202 | PENDING | -- | PENDING | TestBrainClient_11_Overview/crash_recovery | core/test/brainclient_test.go |
| 203 | TAGGED | TST-CORE-994 | PENDING | TestContract_30_3_4_ProcessAcceptsSnakeCaseFields | core/test/brainclient_test.go |
| 204 | PENDING | -- | PENDING | TestContract_30_3_4_ProcessAcceptsSnakeCaseFields/json_serialization_snake_case | core/test/brainclient_test.go |
| 205 | PENDING | -- | PENDING | TestContract_30_3_4_ProcessAcceptsSnakeCaseFields/json_deserialization_round_trip | core/test/brainclient_test.go |
| 206 | PENDING | -- | PENDING | TestContract_30_3_4_ProcessAcceptsSnakeCaseFields/brain_accepts_process_event | core/test/brainclient_test.go |
| 207 | TAGGED | TST-CORE-1006 | PENDING | TestContract_30_5_2_MockBrainServesHealthz | core/test/brainclient_test.go |
| 208 | TAGGED | TST-CORE-1006 | PENDING | TestContract_30_5_2_MockBrainServesHealthz/healthz_returns_200 | core/test/brainclient_test.go |
| 209 | PENDING | -- | PENDING | TestContract_30_5_2_MockBrainServesHealthz/old_v1_health_endpoint_rejected | core/test/brainclient_test.go |
| 210 | PENDING | -- | PENDING | TestContract_30_5_2_MockBrainServesHealthz/brain_unhealthy_returns_error | core/test/brainclient_test.go |
| 211 | PENDING | -- | PENDING | TestContract_30_5_2_MockBrainServesHealthz/mock_brain_contract_completeness | core/test/brainclient_test.go |
| 212 | PENDING | -- | PENDING | TestContract_30_2_4_ClientTokenDeniedOnBrainInternalEndpoints | core/test/brainclient_test.go |
| 213 | PENDING | -- | PENDING | TestContract_30_2_4_ClientTokenDeniedOnBrainInternalEndpoints/signed_brainclient_sends_ed25519_headers | core/test/brainclient_test.go |
| 214 | PENDING | -- | PENDING | TestContract_30_2_4_ClientTokenDeniedOnBrainInternalEndpoints/signed_brainclient_never_sends_bearer_token | core/test/brainclient_test.go |
| 215 | PENDING | -- | PENDING | TestContract_30_2_4_ClientTokenDeniedOnBrainInternalEndpoints/bearer_token_rejected_by_brain_policy | core/test/brainclient_test.go |
| 216 | PENDING | -- | PENDING | TestContract_30_2_4_ClientTokenDeniedOnBrainInternalEndpoints/unsigned_brainclient_rejected_by_brain_policy | core/test/brainclient_test.go |
| 217 | PENDING | -- | PENDING | TestContract_30_2_4_ClientTokenDeniedOnBrainInternalEndpoints/ed25519_did_matches_service_identity | core/test/brainclient_test.go |
| 218 | PENDING | -- | PENDING | TestContract_30_3_2_RealBrainFastAPIAppContract | core/test/brainclient_test.go |
| 219 | PENDING | -- | PENDING | TestContract_30_3_2_RealBrainFastAPIAppContract/create_app_returns_fastapi_with_sub_mounts | core/test/brainclient_test.go |
| 220 | PENDING | -- | PENDING | TestContract_30_3_2_RealBrainFastAPIAppContract/healthz_endpoint_unauthenticated | core/test/brainclient_test.go |
| 221 | PENDING | -- | PENDING | TestContract_30_3_2_RealBrainFastAPIAppContract/process_endpoint_contract | core/test/brainclient_test.go |
| 222 | PENDING | -- | PENDING | TestContract_30_3_2_RealBrainFastAPIAppContract/reason_endpoint_contract | core/test/brainclient_test.go |
| 223 | PENDING | -- | PENDING | TestContract_30_3_2_RealBrainFastAPIAppContract/pii_scrub_endpoint_contract | core/test/brainclient_test.go |
| 224 | PENDING | -- | PENDING | TestContract_30_3_2_RealBrainFastAPIAppContract/brain_api_sub_app_requires_ed25519_auth | core/test/brainclient_test.go |
| 225 | PENDING | -- | PENDING | TestContract_30_3_2_RealBrainFastAPIAppContract/brain_module_isolation_enforced | core/test/brainclient_test.go |
| 226 | PENDING | -- | PENDING | TestContract_30_3_2_RealBrainFastAPIAppContract/process_response_includes_decision_fields | core/test/brainclient_test.go |
| 227 | PENDING | -- | PENDING | TestContract_30_3_2_RealBrainFastAPIAppContract/docs_disabled_in_production | core/test/brainclient_test.go |
| 228 | PENDING | -- | PENDING | TestContract_30_3_2_RealBrainFastAPIAppContract/brain_never_touches_sqlite | core/test/brainclient_test.go |
| 229 | TAGGED | TST-CORE-551 | PENDING | TestConfig_14_1_1_LoadFromEnvVars | core/test/config_test.go |
| 230 | TAGGED | TST-CORE-851 | PENDING | TestConfig_14_7_PartialEnvVars | core/test/config_test.go |
| 231 | TAGGED | TST-CORE-852 | PENDING | TestConfig_14_8_EnvVarTypeParsing | core/test/config_test.go |
| 232 | TAGGED | TST-CORE-554 | PENDING | TestConfig_14_2_1_DefaultValues | core/test/config_test.go |
| 233 | TAGGED | TST-CORE-853 | PENDING | TestConfig_14_9_DefaultSecurityMode | core/test/config_test.go |
| 234 | TAGGED | TST-CORE-553 | PENDING | TestConfig_14_3_1_EmptyClientTokenAccepted | core/test/config_test.go |
| 235 | TAGGED | TST-CORE-555 | PENDING | TestConfig_14_3_2_InvalidSecurityMode | core/test/config_test.go |
| 236 | TAGGED | TST-CORE-854 | PENDING | TestConfig_14_10_NegativeSessionTTL | core/test/config_test.go |
| 237 | TAGGED | TST-CORE-855 | PENDING | TestConfig_14_11_LoadFromConfigJSON | core/test/config_test.go |
| 238 | TAGGED | TST-CORE-552 | PENDING | TestConfig_14_5_1_LoadClientTokenFromDockerSecret | core/test/config_test.go |
| 239 | TAGGED | TST-CORE-856 | PENDING | TestConfig_14_12_EnvOverridesConfigJSON | core/test/config_test.go |
| 240 | TAGGED | TST-CORE-857 | PENDING | TestConfig_14_13_DockerSecretOverridesEnvToken | core/test/config_test.go |
| 241 | TAGGED | TST-CORE-556 | PENDING | TestConfig_14_6_3_SpoolMaxEnforcement | core/test/config_test.go |
| 242 | TAGGED | TST-CORE-898 | PENDING | TestConfig_14_14_AuditLogRetentionConfigurable | core/test/config_test.go |
| 243 | TAGGED | TST-CORE-899 | PENDING | TestConfig_14_15_CloudLLMConsentFlag | core/test/config_test.go |
| 244 | TAGGED | TST-CORE-900 | PENDING | TestConfig_14_16_HistoryDaysDefault365 | core/test/config_test.go |
| 245 | TAGGED | TST-CORE-554 | PENDING | TestConfig_14_4_DefaultValues | core/test/config_test.go |
| 246 | TAGGED | TST-CORE-1035 | PENDING | TestConfig_14_1_4_OwnDIDLoadedFromEnvVar | core/test/config_test.go |
| 247 | PENDING | -- | PENDING | TestConfig_14_1_4_OwnDIDLoadedFromEnvVar/env_var_loaded_into_OwnDID | core/test/config_test.go |
| 248 | PENDING | -- | PENDING | TestConfig_14_1_4_OwnDIDLoadedFromEnvVar/default_OwnDID_empty_when_not_set | core/test/config_test.go |
| 249 | PENDING | -- | PENDING | TestConfig_14_1_4_OwnDIDLoadedFromEnvVar/positive_control_other_vars_work_alongside | core/test/config_test.go |
| 250 | PENDING | -- | PENDING | TestConfig_14_1_4_OwnDIDLoadedFromEnvVar/DID_format_preserved_exactly | core/test/config_test.go |
| 251 | PENDING | -- | PENDING | TestAdv_29_6_HKDFCrossPersona | core/test/crypto_adversarial_test.go |
| 252 | TAGGED | TST-CORE-965 | PENDING | TestAdv_29_6_HKDFUserSalt | core/test/crypto_adversarial_test.go |
| 253 | TAGGED | TST-CORE-966 | PENDING | TestAdv_29_6_HKDFDeterminism | core/test/crypto_adversarial_test.go |
| 254 | TAGGED | TST-CORE-969 | PENDING | TestAdv_29_7_SLIP0010NonHardened | core/test/crypto_adversarial_test.go |
| 255 | TAGGED | TST-CORE-970 | PENDING | TestAdv_29_7_SLIP0010BIP44Forbidden | core/test/crypto_adversarial_test.go |
| 256 | TAGGED | TST-CORE-971 | PENDING | TestAdv_29_7_SLIP0010SiblingUnlink | core/test/crypto_adversarial_test.go |
| 257 | PENDING | -- | PENDING | TestAdv_29_6_KeyDeriverPersonaDEK | core/test/crypto_adversarial_test.go |
| 258 | TAGGED | TST-CORE-968 | PENDING | TestAdv_29_6_KeyDeriverSigningKey | core/test/crypto_adversarial_test.go |
| 259 | TAGGED | TST-CORE-967 | PENDING | TestCrypto_29_6_4_KeyDeriverPersonaDEKIsolation | core/test/crypto_adversarial_test.go |
| 260 | PENDING | -- | PENDING | TestCrypto_29_6_4_KeyDeriverPersonaDEKIsolation/three_personas_all_pairs_distinct_and_32_bytes | core/test/crypto_adversarial_test.go |
| 261 | PENDING | -- | PENDING | TestCrypto_29_6_4_KeyDeriverPersonaDEKIsolation/determinism_same_seed_and_persona_yields_identical_DEK | core/test/crypto_adversarial_test.go |
| 262 | PENDING | -- | PENDING | TestCrypto_29_6_4_KeyDeriverPersonaDEKIsolation/version_isolation_v1_and_v2_produce_different_DEKs | core/test/crypto_adversarial_test.go |
| 263 | PENDING | -- | PENDING | TestCrypto_29_6_4_KeyDeriverPersonaDEKIsolation/empty_seed_returns_error | core/test/crypto_adversarial_test.go |
| 264 | PENDING | -- | PENDING | TestCrypto_29_6_4_KeyDeriverPersonaDEKIsolation/positive_control_different_seeds_produce_different_key_sets | core/test/crypto_adversarial_test.go |
| 265 | TAGGED | TST-CORE-066 | PENDING | TestCrypto_2_2_DeriveRootIdentityKey | core/test/crypto_test.go |
| 266 | TAGGED | TST-CORE-066 | PENDING | TestCrypto_2_2_DerivePersonaKey | core/test/crypto_test.go |
| 267 | TAGGED | TST-CORE-066 | PENDING | TestCrypto_2_2_Determinism | core/test/crypto_test.go |
| 268 | TAGGED | TST-CORE-066 | PENDING | TestCrypto_2_2_DifferentPathsDifferentKeys | core/test/crypto_test.go |
| 269 | TAGGED | TST-CORE-066 | PENDING | TestCrypto_2_2_HardenedOnlyEnforced | core/test/crypto_test.go |
| 270 | TAGGED | TST-CORE-066 | PENDING | TestCrypto_2_2_KnownTestVectors | core/test/crypto_test.go |
| 271 | TAGGED | TST-CORE-066 | PENDING | TestCrypto_2_2_PurposeIsolation | core/test/crypto_test.go |
| 272 | TAGGED | TST-CORE-066 | PENDING | TestCrypto_2_2_Purpose44Forbidden | core/test/crypto_test.go |
| 273 | TAGGED | TST-CORE-066 | PENDING | TestCrypto_2_2_SameMnemonicIndependentTrees | core/test/crypto_test.go |
| 274 | TAGGED | TST-CORE-066 | PENDING | TestCrypto_2_2_SiblingUnlinkability | core/test/crypto_test.go |
| 275 | TAGGED | TST-CORE-066 | PENDING | TestCrypto_2_2_GoImplementation | core/test/crypto_test.go |
| 276 | TAGGED | TST-CORE-066 | PENDING | TestCrypto_2_2_CanonicalPersonaIndexes | core/test/crypto_test.go |
| 277 | TAGGED | TST-CORE-066 | PENDING | TestCrypto_2_2_CustomPersonaIndex7Plus | core/test/crypto_test.go |
| 278 | TAGGED | TST-CORE-066 | PENDING | TestCrypto_2_2_DerivationIndexStored | core/test/crypto_test.go |
| 279 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_DerivePerPersonaDEK | core/test/crypto_test.go |
| 280 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_DifferentPersonasDifferentDEKs | core/test/crypto_test.go |
| 281 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_Determinism | core/test/crypto_test.go |
| 282 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_KnownHKDFTestVectors | core/test/crypto_test.go |
| 283 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_AllInfoStrings | core/test/crypto_test.go |
| 284 | PENDING | -- | PENDING | TestCrypto_2_3_AllInfoStrings/info_format/ | core/test/crypto_test.go |
| 285 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_CompromiseIsolation | core/test/crypto_test.go |
| 286 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_CustomPersonaInfoString | core/test/crypto_test.go |
| 287 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_BackupEncryptionKey | core/test/crypto_test.go |
| 288 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_ArchiveKey | core/test/crypto_test.go |
| 289 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_ArchiveSeparateFromBackup | core/test/crypto_test.go |
| 290 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_ClientSyncKey | core/test/crypto_test.go |
| 291 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_TrustSigningKey | core/test/crypto_test.go |
| 292 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_UserSaltRandom32Bytes | core/test/crypto_test.go |
| 293 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_UserSaltGeneratedOnce | core/test/crypto_test.go |
| 294 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_UserSaltPersistedAcrossReboots | core/test/crypto_test.go |
| 295 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_UserSaltInExport | core/test/crypto_test.go |
| 296 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_DifferentSaltDifferentDEKs | core/test/crypto_test.go |
| 297 | TAGGED | TST-CORE-080 | PENDING | TestCrypto_2_3_UserSaltAbsentStartupError | core/test/crypto_test.go |
| 298 | TAGGED | TST-CORE-098 | PENDING | TestCrypto_2_4_HashPassphrase | core/test/crypto_test.go |
| 299 | TAGGED | TST-CORE-098 | PENDING | TestCrypto_2_4_VerifyCorrect | core/test/crypto_test.go |
| 300 | TAGGED | TST-CORE-098 | PENDING | TestCrypto_2_4_VerifyWrong | core/test/crypto_test.go |
| 301 | TAGGED | TST-CORE-098 | PENDING | TestCrypto_2_4_DefaultParameters | core/test/crypto_test.go |
| 302 | TAGGED | TST-CORE-098 | PENDING | TestCrypto_2_4_UniqueSalts | core/test/crypto_test.go |
| 303 | TAGGED | TST-CORE-098 | PENDING | TestCrypto_2_4_ConfigurableParameters | core/test/crypto_test.go |
| 304 | TAGGED | TST-CORE-098 | PENDING | TestCrypto_2_4_RunsOnceNotPerRequest | core/test/crypto_test.go |
| 305 | TAGGED | TST-CORE-098 | PENDING | TestCrypto_2_4_PassphraseChangeReWrapOnly | core/test/crypto_test.go |
| 306 | TAGGED | TST-CORE-106 | PENDING | TestCrypto_2_5_SignMessage | core/test/crypto_test.go |
| 307 | TAGGED | TST-CORE-106 | PENDING | TestCrypto_2_5_VerifyValid | core/test/crypto_test.go |
| 308 | TAGGED | TST-CORE-106 | PENDING | TestCrypto_2_5_VerifyTampered | core/test/crypto_test.go |
| 309 | TAGGED | TST-CORE-106 | PENDING | TestCrypto_2_5_VerifyWrongKey | core/test/crypto_test.go |
| 310 | TAGGED | TST-CORE-106 | PENDING | TestCrypto_2_5_CanonicalJSON | core/test/crypto_test.go |
| 311 | TAGGED | TST-CORE-106 | PENDING | TestCrypto_2_5_EmptyMessage | core/test/crypto_test.go |
| 312 | TAGGED | TST-CORE-112 | PENDING | TestCrypto_2_6_ConvertPrivateKey | core/test/crypto_test.go |
| 313 | TAGGED | TST-CORE-112 | PENDING | TestCrypto_2_6_ConvertPublicKey | core/test/crypto_test.go |
| 314 | TAGGED | TST-CORE-112 | PENDING | TestCrypto_2_6_Roundtrip | core/test/crypto_test.go |
| 315 | TAGGED | TST-CORE-112 | PENDING | TestCrypto_2_6_OneWayProperty | core/test/crypto_test.go |
| 316 | TAGGED | TST-CORE-112 | PENDING | TestCrypto_2_6_EphemeralPerMessage | core/test/crypto_test.go |
| 317 | TAGGED | TST-CORE-112 | PENDING | TestCrypto_2_6_ConsciousReuse | core/test/crypto_test.go |
| 318 | TAGGED | TST-CORE-112 | PENDING | TestCrypto_2_6_EphemeralZeroed | core/test/crypto_test.go |
| 319 | TAGGED | TST-CORE-119 | PENDING | TestCrypto_2_7_SealMessage | core/test/crypto_test.go |
| 320 | TAGGED | TST-CORE-119 | PENDING | TestCrypto_2_7_OpenSealed | core/test/crypto_test.go |
| 321 | TAGGED | TST-CORE-119 | PENDING | TestCrypto_2_7_WrongRecipient | core/test/crypto_test.go |
| 322 | TAGGED | TST-CORE-119 | PENDING | TestCrypto_2_7_TamperedCiphertext | core/test/crypto_test.go |
| 323 | TAGGED | TST-CORE-119 | PENDING | TestCrypto_2_7_EmptyPlaintext | core/test/crypto_test.go |
| 324 | TAGGED | TST-CORE-119 | PENDING | TestCrypto_2_7_LargeMessage | core/test/crypto_test.go |
| 325 | TAGGED | TST-CORE-125 | PENDING | TestCrypto_2_8_WrapKey | core/test/crypto_test.go |
| 326 | TAGGED | TST-CORE-125 | PENDING | TestCrypto_2_8_UnwrapCorrect | core/test/crypto_test.go |
| 327 | TAGGED | TST-CORE-125 | PENDING | TestCrypto_2_8_UnwrapWrong | core/test/crypto_test.go |
| 328 | TAGGED | TST-CORE-125 | PENDING | TestCrypto_2_8_TamperedBlob | core/test/crypto_test.go |
| 329 | TAGGED | TST-CORE-125 | PENDING | TestCrypto_2_8_NonceUniqueness | core/test/crypto_test.go |
| 330 | TAGGED | TST-CORE-880 | PENDING | TestCrypto_2_8_6_KeyGenerationUsesSecureRandom | core/test/crypto_test.go |
| 331 | TAGGED | TST-CORE-881 | PENDING | TestCrypto_2_8_7_ArchiveKeySurvivesBackupKeyRotation | core/test/crypto_test.go |
| 332 | TAGGED | TST-CORE-882 | PENDING | TestCrypto_2_8_8_ClientSyncKeyUsedForSyncEncryption | core/test/crypto_test.go |
| 333 | PENDING | -- | PENDING | TestCrypto_2_9_DeriveK256Deterministic | core/test/crypto_test.go |
| 334 | PENDING | -- | PENDING | TestCrypto_2_9_K256DifferentFromEd25519 | core/test/crypto_test.go |
| 335 | PENDING | -- | PENDING | TestCrypto_2_9_K256DifferentPaths | core/test/crypto_test.go |
| 336 | PENDING | -- | PENDING | TestCrypto_2_9_K256EmptySeedRejected | core/test/crypto_test.go |
| 337 | PENDING | -- | PENDING | TestCrypto_2_9_K256BIP44Forbidden | core/test/crypto_test.go |
| 338 | PENDING | -- | PENDING | TestCrypto_2_9_K256ParseableByAtcrypto | core/test/crypto_test.go |
| 339 | PENDING | -- | PENDING | TestCrypto_2_9_K256ManagerWithSeed | core/test/crypto_test.go |
| 340 | PENDING | -- | PENDING | TestCrypto_2_9_K256ManagerBackwardCompat | core/test/crypto_test.go |
| 341 | PENDING | -- | PENDING | TestCrypto_2_9_K256ManagerExistingKeyPreferred | core/test/crypto_test.go |
| 342 | PENDING | -- | PENDING | TestCrypto_2_9_KeyDeriverRotationKey | core/test/crypto_test.go |
| 343 | PENDING | -- | PENDING | TestCrypto_2_10_1_DeriveServiceKeyDeterministic | core/test/crypto_test.go |
| 344 | PENDING | -- | PENDING | TestCrypto_2_10_2_DeriveServiceKeyDistinctIndexes | core/test/crypto_test.go |
| 345 | PENDING | -- | PENDING | TestCrypto_2_10_3_DeriveServiceKeyMatchesSLIP0010Path | core/test/crypto_test.go |
| 346 | PENDING | -- | PENDING | TestCrypto_2_10_4_DeriveServiceKeyCrossLanguage | core/test/crypto_test.go |
| 347 | TAGGED | TST-CORE-061 | PENDING | TestCrypto_2_1_6_MasterSeedIsTheDEK | core/test/crypto_test.go |
| 348 | PENDING | -- | PENDING | TestCrypto_2_1_6_MasterSeedIsTheDEK/seed_deterministic_derivation | core/test/crypto_test.go |
| 349 | PENDING | -- | PENDING | TestCrypto_2_1_6_MasterSeedIsTheDEK/different_seeds_different_DEKs | core/test/crypto_test.go |
| 350 | PENDING | -- | PENDING | TestCrypto_2_1_6_MasterSeedIsTheDEK/persona_isolation_from_same_seed | core/test/crypto_test.go |
| 351 | PENDING | -- | PENDING | TestCrypto_2_1_6_MasterSeedIsTheDEK/key_wrap_round_trip | core/test/crypto_test.go |
| 352 | PENDING | -- | PENDING | TestCrypto_2_1_6_MasterSeedIsTheDEK/wrapped_differs_from_raw | core/test/crypto_test.go |
| 353 | PENDING | -- | PENDING | TestCrypto_2_1_6_MasterSeedIsTheDEK/wrong_KEK_fails_unwrap | core/test/crypto_test.go |
| 354 | PENDING | -- | PENDING | TestCrypto_2_1_6_MasterSeedIsTheDEK/derived_DEK_encrypts_data | core/test/crypto_test.go |
| 355 | TAGGED | TST-CORE-964 | PENDING | TestCrypto_29_6_1_CrossPersonaDEKIsolation5Personas | core/test/crypto_test.go |
| 356 | PENDING | -- | PENDING | TestCrypto_29_6_1_CrossPersonaDEKIsolation5Personas/all_deks_are_32_bytes | core/test/crypto_test.go |
| 357 | PENDING | -- | PENDING | TestCrypto_29_6_1_CrossPersonaDEKIsolation5Personas/all_10_pairwise_combinations_distinct | core/test/crypto_test.go |
| 358 | PENDING | -- | PENDING | TestCrypto_29_6_1_CrossPersonaDEKIsolation5Personas/deterministic_re_derivation | core/test/crypto_test.go |
| 359 | PENDING | -- | PENDING | TestCrypto_29_6_1_CrossPersonaDEKIsolation5Personas/different_seed_produces_different_deks | core/test/crypto_test.go |
| 360 | PENDING | -- | PENDING | TestCrypto_29_6_1_CrossPersonaDEKIsolation5Personas/different_salt_produces_different_deks | core/test/crypto_test.go |
| 361 | PENDING | -- | PENDING | TestCrypto_30_11_4_CrossNodeEd25519ToX25519SealedBoxExchange | core/test/crypto_test.go |
| 362 | PENDING | -- | PENDING | TestCrypto_30_11_4_CrossNodeEd25519ToX25519SealedBoxExchange/node_A_seals_to_node_B_and_B_opens | core/test/crypto_test.go |
| 363 | PENDING | -- | PENDING | TestCrypto_30_11_4_CrossNodeEd25519ToX25519SealedBoxExchange/node_B_seals_to_node_A_and_A_opens | core/test/crypto_test.go |
| 364 | PENDING | -- | PENDING | TestCrypto_30_11_4_CrossNodeEd25519ToX25519SealedBoxExchange/cross_contamination_fails_wrong_private_key | core/test/crypto_test.go |
| 365 | PENDING | -- | PENDING | TestCrypto_30_11_4_CrossNodeEd25519ToX25519SealedBoxExchange/cross_contamination_fails_mismatched_pub_priv | core/test/crypto_test.go |
| 366 | PENDING | -- | PENDING | TestCrypto_30_11_4_CrossNodeEd25519ToX25519SealedBoxExchange/ed25519_signature_interop_across_nodes | core/test/crypto_test.go |
| 367 | PENDING | -- | PENDING | TestCrypto_30_11_4_CrossNodeEd25519ToX25519SealedBoxExchange/sign_seal_unseal_verify_full_cross_node_roundtrip | core/test/crypto_test.go |
| 368 | TAGGED | TST-CORE-1222 | PENDING | TestCrypto_30_11_1_RealCrossNodeD2DSignEncryptDecryptVerify | core/test/crypto_test.go |
| 369 | PENDING | -- | PENDING | TestCrypto_30_11_1_RealCrossNodeD2DSignEncryptDecryptVerify/node_a_to_node_b_full_d2d_pipeline | core/test/crypto_test.go |
| 370 | PENDING | -- | PENDING | TestCrypto_30_11_1_RealCrossNodeD2DSignEncryptDecryptVerify/bidirectional_exchange | core/test/crypto_test.go |
| 371 | PENDING | -- | PENDING | TestCrypto_30_11_1_RealCrossNodeD2DSignEncryptDecryptVerify/tampered_ciphertext_fails_verification | core/test/crypto_test.go |
| 372 | PENDING | -- | PENDING | TestCrypto_30_11_1_RealCrossNodeD2DSignEncryptDecryptVerify/forged_signature_detected | core/test/crypto_test.go |
| 373 | PENDING | -- | PENDING | TestCrypto_2_1_7_MnemonicRecoveryReDeriveEverything | core/test/crypto_test.go |
| 374 | PENDING | -- | PENDING | TestCrypto_2_1_7_MnemonicRecoveryReDeriveEverything/root_signing_key_deterministic | core/test/crypto_test.go |
| 375 | PENDING | -- | PENDING | TestCrypto_2_1_7_MnemonicRecoveryReDeriveEverything/all_persona_signing_keys_deterministic | core/test/crypto_test.go |
| 376 | PENDING | -- | PENDING | TestCrypto_2_1_7_MnemonicRecoveryReDeriveEverything/all_persona_vault_deks_deterministic | core/test/crypto_test.go |
| 377 | PENDING | -- | PENDING | TestCrypto_2_1_7_MnemonicRecoveryReDeriveEverything/service_keys_deterministic | core/test/crypto_test.go |
| 378 | PENDING | -- | PENDING | TestCrypto_2_1_7_MnemonicRecoveryReDeriveEverything/did_key_deterministic_from_root_pubkey | core/test/crypto_test.go |
| 379 | PENDING | -- | PENDING | TestCrypto_2_1_7_MnemonicRecoveryReDeriveEverything/cross_layer_isolation_preserved_after_recovery | core/test/crypto_test.go |
| 380 | PENDING | -- | PENDING | TestCrypto_2_1_9_LoseDeviceAndPaperIdentityGone | core/test/crypto_test.go |
| 381 | PENDING | -- | PENDING | TestCrypto_2_1_9_LoseDeviceAndPaperIdentityGone/root_key_irrecoverable | core/test/crypto_test.go |
| 382 | PENDING | -- | PENDING | TestCrypto_2_1_9_LoseDeviceAndPaperIdentityGone/did_irrecoverable | core/test/crypto_test.go |
| 383 | PENDING | -- | PENDING | TestCrypto_2_1_9_LoseDeviceAndPaperIdentityGone/all_persona_keys_irrecoverable | core/test/crypto_test.go |
| 384 | PENDING | -- | PENDING | TestCrypto_2_1_9_LoseDeviceAndPaperIdentityGone/vault_deks_irrecoverable | core/test/crypto_test.go |
| 385 | PENDING | -- | PENDING | TestCrypto_2_1_9_LoseDeviceAndPaperIdentityGone/service_keys_irrecoverable | core/test/crypto_test.go |
| 386 | PENDING | -- | PENDING | TestCrypto_2_1_9_LoseDeviceAndPaperIdentityGone/single_bit_change_still_irrecoverable | core/test/crypto_test.go |
| 387 | PENDING | -- | PENDING | TestCrypto_2_1_9_LoseDeviceAndPaperIdentityGone/no_server_side_recovery_possible | core/test/crypto_test.go |
| 388 | PENDING | -- | PENDING | TestCrypto_29_8_3_DeterministicSeedDerivation | core/test/crypto_test.go |
| 389 | PENDING | -- | PENDING | TestCrypto_29_8_3_DeterministicSeedDerivation/slip0010_determinism_all_paths | core/test/crypto_test.go |
| 390 | PENDING | -- | PENDING | TestCrypto_29_8_3_DeterministicSeedDerivation/hkdf_determinism_all_personas | core/test/crypto_test.go |
| 391 | PENDING | -- | PENDING | TestCrypto_29_8_3_DeterministicSeedDerivation/keyderiver_high_level_determinism | core/test/crypto_test.go |
| 392 | PENDING | -- | PENDING | TestCrypto_29_8_3_DeterministicSeedDerivation/independent_instances_same_output | core/test/crypto_test.go |
| 393 | PENDING | -- | PENDING | TestCrypto_2_1_2_MnemonicToSeedDerivation | core/test/crypto_test.go |
| 394 | PENDING | -- | PENDING | TestCrypto_2_1_2_MnemonicToSeedDerivation/go_test_vector_is_standard_bip39_512bit_seed | core/test/crypto_test.go |
| 395 | PENDING | -- | PENDING | TestCrypto_2_1_2_MnemonicToSeedDerivation/go_test_vector_matches_known_bip39_output | core/test/crypto_test.go |
| 396 | PENDING | -- | PENDING | TestCrypto_2_1_2_MnemonicToSeedDerivation/go_fixtures_document_pbkdf2_derivation | core/test/crypto_test.go |
| 397 | PENDING | -- | PENDING | TestCrypto_2_1_2_MnemonicToSeedDerivation/seed_feeds_slip0010_derivation_correctly | core/test/crypto_test.go |
| 398 | PENDING | -- | PENDING | TestCrypto_2_1_2_MnemonicToSeedDerivation/python_roundtrip_uses_to_mnemonic_and_to_entropy | core/test/crypto_test.go |
| 399 | PENDING | -- | PENDING | TestCrypto_2_1_2_MnemonicToSeedDerivation/seed_hkdf_derivation_uses_full_64_bytes | core/test/crypto_test.go |
| 400 | PENDING | -- | PENDING | TestScenarioPolicy_GetTier_DefaultDeny | core/test/d2d_phase2_test.go |
| 401 | PENDING | -- | PENDING | TestScenarioPolicy_SetGet_RoundTrip | core/test/d2d_phase2_test.go |
| 402 | PENDING | -- | PENDING | TestScenarioPolicy_ListPolicies_EmptyForUnknown | core/test/d2d_phase2_test.go |
| 403 | PENDING | -- | PENDING | TestScenarioPolicy_ListPolicies_AllPolicies | core/test/d2d_phase2_test.go |
| 404 | PENDING | -- | PENDING | TestScenarioPolicy_SetPolicy_Idempotent | core/test/d2d_phase2_test.go |
| 405 | PENDING | -- | PENDING | TestScenarioPolicy_SetDefaultPolicies_FiveDefaults | core/test/d2d_phase2_test.go |
| 406 | PENDING | -- | PENDING | TestScenarioPolicy_SetDefaultPolicies_NoOverwrite | core/test/d2d_phase2_test.go |
| 407 | PENDING | -- | PENDING | TestScenarioPolicy_MultipleContacts_Isolated | core/test/d2d_phase2_test.go |
| 408 | PENDING | -- | PENDING | TestD2DOutbox_Enqueue_ReturnsID | core/test/d2d_phase2_test.go |
| 409 | PENDING | -- | PENDING | TestD2DOutbox_Enqueue_Idempotent | core/test/d2d_phase2_test.go |
| 410 | PENDING | -- | PENDING | TestD2DOutbox_ListPending_ReturnsPendingMessages | core/test/d2d_phase2_test.go |
| 411 | PENDING | -- | PENDING | TestD2DOutbox_ListPending_ExcludesPendingApproval | core/test/d2d_phase2_test.go |
| 412 | PENDING | -- | PENDING | TestD2DOutbox_ListPending_ExcludesExhaustedRetries | core/test/d2d_phase2_test.go |
| 413 | PENDING | -- | PENDING | TestD2DOutbox_MarkDelivered | core/test/d2d_phase2_test.go |
| 414 | PENDING | -- | PENDING | TestD2DOutbox_MarkFailed_ExponentialBackoff | core/test/d2d_phase2_test.go |
| 415 | PENDING | -- | PENDING | TestD2DOutbox_Requeue_ResetsPendingState | core/test/d2d_phase2_test.go |
| 416 | PENDING | -- | PENDING | TestD2DOutbox_Requeue_ErrorForNonFailed | core/test/d2d_phase2_test.go |
| 417 | PENDING | -- | PENDING | TestD2DOutbox_PendingCount | core/test/d2d_phase2_test.go |
| 418 | PENDING | -- | PENDING | TestD2DOutbox_DeleteExpired_RemovesOldTerminalMessages | core/test/d2d_phase2_test.go |
| 419 | PENDING | -- | PENDING | TestD2DOutbox_DeleteExpired_PreservesPendingMessages | core/test/d2d_phase2_test.go |
| 420 | PENDING | -- | PENDING | TestD2DOutbox_ResumeAfterApproval | core/test/d2d_phase2_test.go |
| 421 | PENDING | -- | PENDING | TestD2DOutbox_ResumeAfterApproval_ErrorForWrongStatus | core/test/d2d_phase2_test.go |
| 422 | PENDING | -- | PENDING | TestV1MessageFamilies_ContainsExpectedTypes | core/test/d2d_v1_domain_test.go |
| 423 | PENDING | -- | PENDING | TestV1MessageFamilies_ExcludesLegacyTypes | core/test/d2d_v1_domain_test.go |
| 424 | PENDING | -- | PENDING | TestMsgTypeToScenario_KnownTypes | core/test/d2d_v1_domain_test.go |
| 425 | PENDING | -- | PENDING | TestMsgTypeToScenario_UnknownType_ReturnsEmpty | core/test/d2d_v1_domain_test.go |
| 426 | PENDING | -- | PENDING | TestD2DMemoryTypes_OnlyMemoryProducingTypes | core/test/d2d_v1_domain_test.go |
| 427 | PENDING | -- | PENDING | TestValidateV1Body_PresenceSignal_Valid | core/test/d2d_v1_domain_test.go |
| 428 | PENDING | -- | PENDING | TestValidateV1Body_PresenceSignal_WithOptionalFields | core/test/d2d_v1_domain_test.go |
| 429 | PENDING | -- | PENDING | TestValidateV1Body_SocialUpdate_Valid | core/test/d2d_v1_domain_test.go |
| 430 | PENDING | -- | PENDING | TestValidateV1Body_SafetyAlert_Valid | core/test/d2d_v1_domain_test.go |
| 431 | PENDING | -- | PENDING | TestValidateV1Body_TrustVouchRequest_Valid | core/test/d2d_v1_domain_test.go |
| 432 | PENDING | -- | PENDING | TestValidateV1Body_TrustVouchResponse_Valid | core/test/d2d_v1_domain_test.go |
| 433 | PENDING | -- | PENDING | TestValidateV1Body_CoordinationRequest_Valid | core/test/d2d_v1_domain_test.go |
| 434 | PENDING | -- | PENDING | TestValidateV1Body_CoordinationResponse_Valid | core/test/d2d_v1_domain_test.go |
| 435 | PENDING | -- | PENDING | TestValidateV1Body_UnknownType | core/test/d2d_v1_domain_test.go |
| 436 | PENDING | -- | PENDING | TestValidateV1Body_PresenceSignal_MissingStatus | core/test/d2d_v1_domain_test.go |
| 437 | PENDING | -- | PENDING | TestValidateV1Body_SocialUpdate_MissingText | core/test/d2d_v1_domain_test.go |
| 438 | PENDING | -- | PENDING | TestValidateV1Body_SafetyAlert_MissingMessage | core/test/d2d_v1_domain_test.go |
| 439 | PENDING | -- | PENDING | TestValidateV1Body_SafetyAlert_MissingSeverity | core/test/d2d_v1_domain_test.go |
| 440 | PENDING | -- | PENDING | TestValidateV1Body_SafetyAlert_InvalidSeverity | core/test/d2d_v1_domain_test.go |
| 441 | PENDING | -- | PENDING | TestValidateV1Body_TrustVouchRequest_MissingSubjectDID | core/test/d2d_v1_domain_test.go |
| 442 | PENDING | -- | PENDING | TestValidateV1Body_TrustVouchResponse_MissingSubjectDID | core/test/d2d_v1_domain_test.go |
| 443 | PENDING | -- | PENDING | TestValidateV1Body_TrustVouchResponse_InvalidVouch | core/test/d2d_v1_domain_test.go |
| 444 | PENDING | -- | PENDING | TestValidateV1Body_TrustVouchResponse_MissingVouch | core/test/d2d_v1_domain_test.go |
| 445 | PENDING | -- | PENDING | TestValidateV1Body_CoordinationRequest_MissingAction | core/test/d2d_v1_domain_test.go |
| 446 | PENDING | -- | PENDING | TestValidateV1Body_CoordinationRequest_MissingContext | core/test/d2d_v1_domain_test.go |
| 447 | PENDING | -- | PENDING | TestValidateV1Body_CoordinationResponse_MissingAction | core/test/d2d_v1_domain_test.go |
| 448 | PENDING | -- | PENDING | TestValidateV1Body_MalformedJSON | core/test/d2d_v1_domain_test.go |
| 449 | PENDING | -- | PENDING | TestOutboxStatusConstants | core/test/d2d_v1_domain_test.go |
| 450 | PENDING | -- | PENDING | TestScenarioTierConstants | core/test/d2d_v1_domain_test.go |
| 451 | PENDING | -- | PENDING | TestD2VSentinelErrors | core/test/d2d_v1_domain_test.go |
| 452 | PENDING | -- | PENDING | TestD2D_V1_IngressContactsOnly_ExplicitContactAccepted | core/test/d2d_v1_protocol_test.go |
| 453 | PENDING | -- | PENDING | TestD2D_V1_IngressContactsOnly_NonContactQuarantined | core/test/d2d_v1_protocol_test.go |
| 454 | PENDING | -- | PENDING | TestD2D_V1_IngressContactsOnly_BlockedContactDropped | core/test/d2d_v1_protocol_test.go |
| 455 | PENDING | -- | PENDING | TestD2D_V1_IngressContactsOnly_EmptyDIDQuarantined | core/test/d2d_v1_protocol_test.go |
| 456 | PENDING | -- | PENDING | TestD2D_V1_IngressContactsOnly_UnknownTrustLevelAccepted | core/test/d2d_v1_protocol_test.go |
| 457 | PENDING | -- | PENDING | TestD2D_V1_SendMessage_ContactGateBlocksNonContact | core/test/d2d_v1_protocol_test.go |
| 458 | PENDING | -- | PENDING | TestD2D_V1_SendMessage_ScenarioGateDenyByDefault | core/test/d2d_v1_protocol_test.go |
| 459 | PENDING | -- | PENDING | TestD2D_V1_SendMessage_ScenarioGateExplicitOnceBlocked | core/test/d2d_v1_protocol_test.go |
| 460 | PENDING | -- | PENDING | TestD2D_V1_SendMessage_StandingPolicyAllowed | core/test/d2d_v1_protocol_test.go |
| 461 | PENDING | -- | PENDING | TestD2D_V1_HandleSend_RejectsNonV1Type | core/test/d2d_v1_protocol_test.go |
| 462 | PENDING | -- | PENDING | TestD2D_V1_HandleSend_AcceptsV1Type | core/test/d2d_v1_protocol_test.go |
| 463 | PENDING | -- | PENDING | TestD2D_V1_SendMessage_NonV1TypeRejected | core/test/d2d_v1_protocol_test.go |
| 464 | PENDING | -- | PENDING | TestD2D_V1_MsgTypeToScenario_AllV1Covered | core/test/d2d_v1_protocol_test.go |
| 465 | PENDING | -- | PENDING | TestD2D_V1_MsgTypeToScenario_LegacyReturnsEmpty | core/test/d2d_v1_protocol_test.go |
| 466 | PENDING | -- | PENDING | TestD2D_V1_D2DMemoryTypes_OnlyRelationshipAndTrust | core/test/d2d_v1_protocol_test.go |
| 467 | PENDING | -- | PENDING | TestD2D_V1_ScenarioTier_Constants | core/test/d2d_v1_protocol_test.go |
| 468 | PENDING | -- | PENDING | TestD2D_V1_SafetyAlwaysPassesInbound | core/test/d2d_v1_protocol_test.go |
| 469 | TAGGED | TST-CORE-751 | PENDING | TestDeferred_24_1_1_Ring1UnverifiedDina | core/test/deferred_test.go |
| 470 | TAGGED | TST-CORE-752 | PENDING | TestDeferred_24_1_2_Ring2VerifiedHumanZKP | core/test/deferred_test.go |
| 471 | TAGGED | TST-CORE-753 | PENDING | TestDeferred_24_1_3_Ring2Phase1Compromise | core/test/deferred_test.go |
| 472 | TAGGED | TST-CORE-754 | PENDING | TestDeferred_24_1_4_Ring2OneIDOneVerifiedDina | core/test/deferred_test.go |
| 473 | TAGGED | TST-CORE-755 | PENDING | TestDeferred_24_1_5_Ring3SkinInTheGame | core/test/deferred_test.go |
| 474 | TAGGED | TST-CORE-756 | PENDING | TestDeferred_24_1_6_TrustScoreFormula | core/test/deferred_test.go |
| 475 | TAGGED | TST-CORE-757 | PENDING | TestDeferred_24_1_7_TrustLevelAffectsSharingRouting | core/test/deferred_test.go |
| 476 | TAGGED | TST-CORE-758 | PENDING | TestDeferred_24_2_1_SecureEnclaveIOS | core/test/deferred_test.go |
| 477 | TAGGED | TST-CORE-759 | PENDING | TestDeferred_24_2_2_StrongBoxAndroid | core/test/deferred_test.go |
| 478 | TAGGED | TST-CORE-760 | PENDING | TestDeferred_24_2_3_TPMDesktop | core/test/deferred_test.go |
| 479 | TAGGED | TST-CORE-761 | PENDING | TestDeferred_24_2_4_FallbackSoftwareEntropy | core/test/deferred_test.go |
| 480 | TAGGED | TST-CORE-762 | PENDING | TestDeferred_24_3_1_ArchiveEncryptedWithArchiveKey | core/test/deferred_test.go |
| 481 | TAGGED | TST-CORE-763 | PENDING | TestDeferred_24_3_2_ArchiveContainsCorrectTiers | core/test/deferred_test.go |
| 482 | TAGGED | TST-CORE-764 | PENDING | TestDeferred_24_3_3_WeeklyFrequencyConfigurable | core/test/deferred_test.go |
| 483 | TAGGED | TST-CORE-765 | PENDING | TestDeferred_24_3_4_S3GlacierComplianceModeLock | core/test/deferred_test.go |
| 484 | TAGGED | TST-CORE-766 | PENDING | TestDeferred_24_3_5_SovereignUSBLTOTape | core/test/deferred_test.go |
| 485 | TAGGED | TST-CORE-767 | PENDING | TestDeferred_24_3_6_ArchiveUselessWithoutKeys | core/test/deferred_test.go |
| 486 | TAGGED | TST-CORE-768 | PENDING | TestDeferred_24_4_1_AutoSnapshotEvery15Minutes | core/test/deferred_test.go |
| 487 | TAGGED | TST-CORE-769 | PENDING | TestDeferred_24_4_2_SnapshotRetentionPolicy | core/test/deferred_test.go |
| 488 | TAGGED | TST-CORE-770 | PENDING | TestDeferred_24_4_3_ZFSRollbackRecovery | core/test/deferred_test.go |
| 489 | TAGGED | TST-CORE-771 | PENDING | TestDeferred_24_4_4_ManagedHostingPerUserVolumes | core/test/deferred_test.go |
| 490 | TAGGED | TST-CORE-772 | PENDING | TestDeferred_24_5_1_PhoneRecent6MonthsCached | core/test/deferred_test.go |
| 491 | TAGGED | TST-CORE-773 | PENDING | TestDeferred_24_5_2_LaptopConfigurableCacheSize | core/test/deferred_test.go |
| 492 | TAGGED | TST-CORE-774 | PENDING | TestDeferred_24_5_3_ThinClientNoLocalCache | core/test/deferred_test.go |
| 493 | TAGGED | TST-CORE-775 | PENDING | TestDeferred_24_5_4_CacheEncryptedWithSyncKey | core/test/deferred_test.go |
| 494 | TAGGED | TST-CORE-931 | PENDING | TestDeferred_24_5_5_Tier5DeepArchive_EncryptedSnapshot | core/test/deferred_test.go |
| 495 | TAGGED | TST-CORE-601 | PENDING | TestErrors_16_1_MalformedJSON | core/test/errors_test.go |
| 496 | TAGGED | TST-CORE-602 | PENDING | TestErrors_16_2_RequestBodyTooLarge | core/test/errors_test.go |
| 497 | TAGGED | TST-CORE-603 | PENDING | TestErrors_16_3_UnknownEndpoint | core/test/errors_test.go |
| 498 | TAGGED | TST-CORE-604 | PENDING | TestErrors_16_4_MethodNotAllowed | core/test/errors_test.go |
| 499 | TAGGED | TST-CORE-605 | PENDING | TestErrors_16_5_ContentTypeEnforcement | core/test/errors_test.go |
| 500 | TAGGED | TST-CORE-606 | PENDING | TestErrors_16_6_ConcurrentVaultWrites | core/test/errors_test.go |
| 501 | TAGGED | TST-CORE-607 | PENDING | TestErrors_16_7_DiskFull | core/test/errors_test.go |
| 502 | TAGGED | TST-CORE-608 | PENDING | TestErrors_16_8_VaultFileCorruption | core/test/errors_test.go |
| 503 | TAGGED | TST-CORE-609 | PENDING | TestErrors_16_9_GracefulShutdown | core/test/errors_test.go |
| 504 | TAGGED | TST-CORE-610 | PENDING | TestErrors_16_10_PanicRecovery | core/test/errors_test.go |
| 505 | TAGGED | TST-CORE-869 | PENDING | TestEstate_27_1_PlanStoredInTier0 | core/test/estate_test.go |
| 506 | TAGGED | TST-CORE-870 | PENDING | TestEstate_27_2_Recovery_CustodianThresholdMet | core/test/estate_test.go |
| 507 | TAGGED | TST-CORE-871 | PENDING | TestEstate_27_3_NoDeadMansSwitch_NoTimerTrigger | core/test/estate_test.go |
| 508 | TAGGED | TST-CORE-872 | PENDING | TestEstate_27_4_ReadOnly90Days_Expires | core/test/estate_test.go |
| 509 | TAGGED | TST-CORE-873 | PENDING | TestEstate_27_5_DefaultAction_DestroyOrArchive | core/test/estate_test.go |
| 510 | TAGGED | TST-CORE-874 | PENDING | TestEstate_27_6_SSSSharesReusedFromIdentityRecovery | core/test/estate_test.go |
| 511 | TAGGED | TST-CORE-875 | PENDING | TestEstate_27_7_PlanJSONStructure_Validated | core/test/estate_test.go |
| 512 | TAGGED | TST-CORE-876 | PENDING | TestEstate_27_8_NotificationList_InformsOnActivation | core/test/estate_test.go |
| 513 | TAGGED | TST-CORE-877 | PENDING | TestEstate_27_9_Recovery_KeysDeliveredViaD2D | core/test/estate_test.go |
| 514 | TAGGED | TST-CORE-878 | PENDING | TestEstate_27_10_Recovery_NonAssignedDataDestroyed | core/test/estate_test.go |
| 515 | TAGGED | TST-CORE-879 | PENDING | TestEstate_27_11_NoTimerTriggerInCodebase | core/test/estate_test.go |
| 516 | TAGGED | TST-CORE-1058 | PENDING | TestSecFix_32_1_1_ReplaySignatureRejected | core/test/fix_verification_batch5_test.go |
| 517 | TAGGED | TST-CORE-1059 | PENDING | TestSecFix_32_1_2_DifferentSignaturesAccepted | core/test/fix_verification_batch5_test.go |
| 518 | TAGGED | TST-CORE-1060 | PENDING | TestSecFix_32_1_3_DoubleBufferRotation | core/test/fix_verification_batch5_test.go |
| 519 | TAGGED | TST-CORE-1061 | PENDING | TestSecFix_32_1_4_SafetyValveUnderLoad | core/test/fix_verification_batch5_test.go |
| 520 | TAGGED | TST-CORE-1062 | PENDING | TestSecFix_32_2_1_InboundCapEnforced | core/test/fix_verification_batch5_test.go |
| 521 | TAGGED | TST-CORE-1063 | PENDING | TestSecFix_32_2_2_InboundClearWorks | core/test/fix_verification_batch5_test.go |
| 522 | TAGGED | TST-CORE-1064 | PENDING | TestSecFix_32_3_1_PerDIDRateIsolation | core/test/fix_verification_batch5_test.go |
| 523 | TAGGED | TST-CORE-1065 | PENDING | TestSecFix_32_3_2_RateLimitResetAfterWindow | core/test/fix_verification_batch5_test.go |
| 524 | TAGGED | TST-CORE-1066 | PENDING | TestSecFix_32_4_1_HardCapEnforced | core/test/fix_verification_batch5_test.go |
| 525 | TAGGED | TST-CORE-1067 | PENDING | TestSecFix_32_4_2_CompletePairingFreesSlot | core/test/fix_verification_batch5_test.go |
| 526 | TAGGED | TST-CORE-1068 | PENDING | TestSecFix_32_4_3_PurgeExpiredCodesFreesSlots | core/test/fix_verification_batch5_test.go |
| 527 | TAGGED | TST-CORE-1069 | PENDING | TestSecFix_32_4_4_ImmediateCleanupOnUse | core/test/fix_verification_batch5_test.go |
| 528 | TAGGED | TST-CORE-1070 | PENDING | TestSecFix_32_5_1_WellKnownIdempotent | core/test/fix_verification_batch5_test.go |
| 529 | TAGGED | TST-CORE-1071 | PENDING | TestFixVerify_31_7_1_OnEnvelopeError_FallsBackToDeadDrop | core/test/fix_verification_batch8_test.go |
| 530 | TAGGED | TST-CORE-1072 | PENDING | TestFixVerify_31_7_2_ProcessPending_ReSpoolsOnError | core/test/fix_verification_batch8_test.go |
| 531 | TAGGED | TST-CORE-1073 | PENDING | TestFixVerify_31_7_3_Complete_RemovesInFlight | core/test/fix_verification_batch8_test.go |
| 532 | TAGGED | TST-CORE-1074 | PENDING | TestFixVerify_31_7_4_Sweeper_HasSetTransport | core/test/fix_verification_batch8_test.go |
| 533 | TAGGED | TST-CORE-1075 | PENDING | TestFixVerify_31_7_5_ErrorSanitization_NoInternalDetails | core/test/fix_verification_batch8_test.go |
| 534 | TAGGED | TST-CORE-1076 | PENDING | TestFixVerify_31_7_6_WS_Components_Constructable | core/test/fix_verification_batch8_test.go |
| 535 | TAGGED | TST-CORE-1077 | PENDING | TestFixVerify_31_7_7_DeleteExpired_PrunesSentIDs | core/test/fix_verification_batch8_test.go |
| 536 | TAGGED | TST-CORE-1078 | PENDING | TestFixVerify_31_7_8_VaultStore_RejectsOversizedItem | core/test/fix_verification_batch8_test.go |
| 537 | TAGGED | TST-CORE-1079 | PENDING | TestFixVerify_31_7_9_VaultStore_RejectsInvalidType | core/test/fix_verification_batch8_test.go |
| 538 | TAGGED | TST-CORE-1080 | PENDING | TestFixVerify_31_7_10_VaultStoreBatch_RejectsInvalidItem | core/test/fix_verification_batch8_test.go |
| 539 | TAGGED | TST-CORE-1081 | PENDING | TestFixVerify_31_7_11_VaultStore_AcceptsValidTypes | core/test/fix_verification_batch8_test.go |
| 540 | TAGGED | TST-CORE-1082 | PENDING | TestFixVerify_31_7_12_CORS_Wildcard_SetsStarNoCredentials | core/test/fix_verification_batch8_test.go |
| 541 | TAGGED | TST-CORE-1083 | PENDING | TestFixVerify_31_7_13_CORS_Whitelist_SetsCredentials | core/test/fix_verification_batch8_test.go |
| 542 | TAGGED | TST-CORE-1084 | PENDING | TestFixVerify_31_7_14_CORS_Wildcard_PreflightReturns204 | core/test/fix_verification_batch8_test.go |
| 543 | TAGGED | TST-CORE-1085 | PENDING | TestFixVerify_31_7_15_WS_DefaultUpgrader_SecureByDefault | core/test/fix_verification_batch8_test.go |
| 544 | TAGGED | TST-CORE-1086 | PENDING | TestFixVerify_31_7_16_WS_InsecureSkipVerify_Enabled | core/test/fix_verification_batch8_test.go |
| 545 | TAGGED | TST-CORE-1087 | PENDING | TestFixVerify_31_7_17_WS_WithOriginPatterns_Configurable | core/test/fix_verification_batch8_test.go |
| 546 | TAGGED | TST-CORE-945 | PENDING | TestTransport_29_2_9_QueueLimitEnforcedRejectWhenFull | core/test/fix_verification_batch8_test.go |
| 547 | PENDING | -- | PENDING | TestTransport_29_2_9_QueueLimitEnforcedRejectWhenFull/queue_full_returns_ErrOutboxFull | core/test/fix_verification_batch8_test.go |
| 548 | PENDING | -- | PENDING | TestTransport_29_2_9_QueueLimitEnforcedRejectWhenFull/positive_control_below_limit_succeeds | core/test/fix_verification_batch8_test.go |
| 549 | PENDING | -- | PENDING | TestTransport_29_2_9_QueueLimitEnforcedRejectWhenFull/delivered_messages_dont_count_toward_limit | core/test/fix_verification_batch8_test.go |
| 550 | PENDING | -- | PENDING | TestTransport_29_2_9_QueueLimitEnforcedRejectWhenFull/failed_messages_dont_count_toward_limit | core/test/fix_verification_batch8_test.go |
| 551 | PENDING | -- | PENDING | TestTransport_29_2_9_QueueLimitEnforcedRejectWhenFull/default_queue_size_100_when_zero | core/test/fix_verification_batch8_test.go |
| 552 | TAGGED | TST-CORE-1031 | PENDING | TestFixVerify_31_1_1_DrainSpoolReturnsPayloads | core/test/fix_verification_test.go |
| 553 | TAGGED | TST-CORE-1032 | PENDING | TestFixVerify_31_1_2_DrainSpoolSkipsExpired | core/test/fix_verification_test.go |
| 554 | TAGGED | TST-CORE-1033 | PENDING | TestFixVerify_31_1_3_OnEnvelopeCallback | core/test/fix_verification_test.go |
| 555 | TAGGED | TST-CORE-1036 | PENDING | TestFixVerify_31_1_6_ImmediateDecrypt | core/test/fix_verification_test.go |
| 556 | TAGGED | TST-CORE-1037 | PENDING | TestFixVerify_31_1_7_CrossNodeD2D_AlonsoToSancho | core/test/fix_verification_test.go |
| 557 | TAGGED | TST-CORE-1038 | PENDING | TestFixVerify_31_1_8_CrossNodeD2D_SanchoToAlonso | core/test/fix_verification_test.go |
| 558 | TAGGED | TST-CORE-1039 | PENDING | TestFixVerify_31_1_9_CrossNodeD2D_Multicast | core/test/fix_verification_test.go |
| 559 | TAGGED | TST-CORE-1040 | PENDING | TestFixVerify_31_2_1_TaskEventSnakeCaseJSON | core/test/fix_verification_test.go |
| 560 | TAGGED | TST-CORE-1041 | PENDING | TestFixVerify_31_2_2_ProcessEventAcceptsTaskID | core/test/fix_verification_test.go |
| 561 | TAGGED | TST-CORE-1042 | PENDING | TestFixVerify_31_2_3_ReasonSendsPrompt | core/test/fix_verification_test.go |
| 562 | TAGGED | TST-CORE-1043 | PENDING | TestFixVerify_31_2_4_ReasonResultFields | core/test/fix_verification_test.go |
| 563 | TAGGED | TST-CORE-1201 | PENDING | TestFixVerify_34_3_ReasonApprovalPropagation | core/test/fix_verification_test.go |
| 564 | TAGGED | TST-CORE-1050 | PENDING | TestFixVerify_31_4_2_DegradationSignal | core/test/fix_verification_test.go |
| 565 | TAGGED | TST-CORE-1051 | PENDING | TestFixVerify_31_4_3_SemanticFallbackToFTS5 | core/test/fix_verification_test.go |
| 566 | TAGGED | TST-CORE-1052 | PENDING | TestFixVerify_31_5_1_UpdateContact | core/test/fix_verification_test.go |
| 567 | TAGGED | TST-CORE-1054 | PENDING | TestFixVerify_31_5_3_AdminUICallsCoreAPI | core/test/fix_verification_test.go |
| 568 | TAGGED | TST-CORE-1055 | PENDING | TestFixVerify_31_6_1_DefaultCoreURL | core/test/fix_verification_test.go |
| 569 | TAGGED | TST-CORE-1057 | PENDING | TestFixVerify_31_6_3_KnownPeersParsed | core/test/fix_verification_test.go |
| 570 | TAGGED | TST-CORE-975 | PENDING | TestAdv_29_9_LockedPersonaDenied | core/test/gatekeeper_adversarial_test.go |
| 571 | TAGGED | TST-CORE-976 | PENDING | TestAdv_29_9_LockedPersonaAudited | core/test/gatekeeper_adversarial_test.go |
| 572 | PENDING | -- | PENDING | TestAdv_29_9_EgressDeniedAudited | core/test/gatekeeper_adversarial_test.go |
| 573 | TAGGED | TST-CORE-978 | PENDING | TestAdv_29_10_MissingCategoryDenied | core/test/gatekeeper_adversarial_test.go |
| 574 | PENDING | -- | PENDING | TestAdv_29_10_TierNoneBlocks | core/test/gatekeeper_adversarial_test.go |
| 575 | PENDING | -- | PENDING | TestAdv_29_10_NoPolicyDefaultDeny | core/test/gatekeeper_adversarial_test.go |
| 576 | PENDING | -- | PENDING | TestAdv_29_10_MalformedPayloadDenied | core/test/gatekeeper_adversarial_test.go |
| 577 | TAGGED | TST-CORE-1124 | PENDING | TestAdv_34_2_AgentAttemptsToReadOtherAgentsData | core/test/gatekeeper_adversarial_test.go |
| 578 | PENDING | -- | PENDING | TestAdv_34_2_AgentAttemptsToReadOtherAgentsData/cross_persona_constraint_blocks_agent_B | core/test/gatekeeper_adversarial_test.go |
| 579 | PENDING | -- | PENDING | TestAdv_34_2_AgentAttemptsToReadOtherAgentsData/agent_A_allowed_on_own_persona | core/test/gatekeeper_adversarial_test.go |
| 580 | PENDING | -- | PENDING | TestAdv_34_2_AgentAttemptsToReadOtherAgentsData/two_agents_mutually_isolated | core/test/gatekeeper_adversarial_test.go |
| 581 | PENDING | -- | PENDING | TestAdv_34_2_AgentAttemptsToReadOtherAgentsData/untrusted_agent_denied_all_personas | core/test/gatekeeper_adversarial_test.go |
| 582 | PENDING | -- | PENDING | TestAdv_34_2_AgentAttemptsToReadOtherAgentsData/denial_audited_with_agent_identity | core/test/gatekeeper_adversarial_test.go |
| 583 | TAGGED | TST-CORE-985 | PENDING | TestInfra_30_1_MockSideEffectsDisabledInStrictReal | core/test/gatekeeper_adversarial_test.go |
| 584 | PENDING | -- | PENDING | TestInfra_30_1_MockSideEffectsDisabledInStrictReal/real_implementations_are_not_mock_wrappers | core/test/gatekeeper_adversarial_test.go |
| 585 | PENDING | -- | PENDING | TestInfra_30_1_MockSideEffectsDisabledInStrictReal/real_gatekeeper_independent_of_mock_state | core/test/gatekeeper_adversarial_test.go |
| 586 | PENDING | -- | PENDING | TestInfra_30_1_MockSideEffectsDisabledInStrictReal/real_sharing_policy_independent_of_mock | core/test/gatekeeper_adversarial_test.go |
| 587 | PENDING | -- | PENDING | TestInfra_30_1_MockSideEffectsDisabledInStrictReal/wiring_variables_typed_to_ports_not_mocks | core/test/gatekeeper_adversarial_test.go |
| 588 | PENDING | -- | PENDING | TestInfra_30_1_MockSideEffectsDisabledInStrictReal/real_pii_scrubber_independent_of_mock | core/test/gatekeeper_adversarial_test.go |
| 589 | TAGGED | TST-CORE-1128 | PENDING | TestAdv_34_2_AgentCredentialHarvestingViaErrors | core/test/gatekeeper_adversarial_test.go |
| 590 | PENDING | -- | PENDING | TestAdv_34_2_AgentCredentialHarvestingViaErrors/malformed_json_body_no_leak | core/test/gatekeeper_adversarial_test.go |
| 591 | PENDING | -- | PENDING | TestAdv_34_2_AgentCredentialHarvestingViaErrors/injection_payloads_no_echo_in_errors | core/test/gatekeeper_adversarial_test.go |
| 592 | PENDING | -- | PENDING | TestAdv_34_2_AgentCredentialHarvestingViaErrors/oversized_payload_no_leak | core/test/gatekeeper_adversarial_test.go |
| 593 | PENDING | -- | PENDING | TestAdv_34_2_AgentCredentialHarvestingViaErrors/unknown_endpoint_no_resource_discovery | core/test/gatekeeper_adversarial_test.go |
| 594 | PENDING | -- | PENDING | TestAdv_34_2_AgentCredentialHarvestingViaErrors/wrong_method_no_endpoint_enumeration | core/test/gatekeeper_adversarial_test.go |
| 595 | PENDING | -- | PENDING | TestAdv_34_2_AgentCredentialHarvestingViaErrors/missing_required_fields_generic_error | core/test/gatekeeper_adversarial_test.go |
| 596 | PENDING | -- | PENDING | TestAdv_34_2_AgentCredentialHarvestingViaErrors/wrong_content_type_no_leak | core/test/gatekeeper_adversarial_test.go |
| 597 | PENDING | -- | PENDING | TestAdv_34_2_AgentCredentialHarvestingViaErrors/error_responses_are_valid_json | core/test/gatekeeper_adversarial_test.go |
| 598 | PENDING | -- | PENDING | TestAdv_34_2_AgentCredentialHarvestingViaErrors/contrast_valid_request_returns_200 | core/test/gatekeeper_adversarial_test.go |
| 599 | TAGGED | TST-CORE-986 | PENDING | TestInfra_30_1_AllFallbackLocationsAuditedStrict | core/test/gatekeeper_adversarial_test.go |
| 600 | PENDING | -- | PENDING | TestInfra_30_1_AllFallbackLocationsAuditedStrict/total_inventory_within_bounds | core/test/gatekeeper_adversarial_test.go |
| 601 | PENDING | -- | PENDING | TestInfra_30_1_AllFallbackLocationsAuditedStrict/contrast_Go_wiring_has_no_mock_fallback | core/test/gatekeeper_adversarial_test.go |
| 602 | TAGGED | TST-CORE-1127 | PENDING | TestAdv_34_1_AgentSendsMalformedIntentToBypassGatekeeper | core/test/gatekeeper_adversarial_test.go |
| 603 | PENDING | -- | PENDING | TestAdv_34_1_AgentSendsMalformedIntentToBypassGatekeeper/empty_action_returns_error_not_decision | core/test/gatekeeper_adversarial_test.go |
| 604 | PENDING | -- | PENDING | TestAdv_34_1_AgentSendsMalformedIntentToBypassGatekeeper/empty_agent_did_returns_error_not_decision | core/test/gatekeeper_adversarial_test.go |
| 605 | PENDING | -- | PENDING | TestAdv_34_1_AgentSendsMalformedIntentToBypassGatekeeper/both_empty_returns_error | core/test/gatekeeper_adversarial_test.go |
| 606 | PENDING | -- | PENDING | TestAdv_34_1_AgentSendsMalformedIntentToBypassGatekeeper/positive_control_valid_intent_returns_decision | core/test/gatekeeper_adversarial_test.go |
| 607 | PENDING | -- | PENDING | TestAdv_34_1_AgentSendsMalformedIntentToBypassGatekeeper/nil_constraints_safe | core/test/gatekeeper_adversarial_test.go |
| 608 | PENDING | -- | PENDING | TestAdv_34_1_AgentSendsMalformedIntentToBypassGatekeeper/empty_constraints_map_safe | core/test/gatekeeper_adversarial_test.go |
| 609 | PENDING | -- | PENDING | TestAdv_34_1_AgentSendsMalformedIntentToBypassGatekeeper/CheckAccess_propagates_validation_error | core/test/gatekeeper_adversarial_test.go |
| 610 | PENDING | -- | PENDING | TestAdv_34_1_AgentSendsMalformedIntentToBypassGatekeeper/malformed_intent_with_risky_action_still_errors | core/test/gatekeeper_adversarial_test.go |
| 611 | TAGGED | TST-CORE-1126 | PENDING | TestGatekeeper_34_2_5_OversizedQueryLimitCapped | core/test/gatekeeper_adversarial_test.go |
| 612 | PENDING | -- | PENDING | TestGatekeeper_34_2_5_OversizedQueryLimitCapped/oversized_limit_999999_capped_to_100 | core/test/gatekeeper_adversarial_test.go |
| 613 | PENDING | -- | PENDING | TestGatekeeper_34_2_5_OversizedQueryLimitCapped/oversized_limit_1000000_capped_to_100 | core/test/gatekeeper_adversarial_test.go |
| 614 | PENDING | -- | PENDING | TestGatekeeper_34_2_5_OversizedQueryLimitCapped/limit_at_boundary_100_passes_through | core/test/gatekeeper_adversarial_test.go |
| 615 | PENDING | -- | PENDING | TestGatekeeper_34_2_5_OversizedQueryLimitCapped/limit_101_capped_to_100 | core/test/gatekeeper_adversarial_test.go |
| 616 | PENDING | -- | PENDING | TestGatekeeper_34_2_5_OversizedQueryLimitCapped/normal_limit_50_passes_through | core/test/gatekeeper_adversarial_test.go |
| 617 | PENDING | -- | PENDING | TestGatekeeper_34_2_5_OversizedQueryLimitCapped/limit_1_passes_through | core/test/gatekeeper_adversarial_test.go |
| 618 | PENDING | -- | PENDING | TestGatekeeper_34_2_5_OversizedQueryLimitCapped/limit_zero_clamped_to_default | core/test/gatekeeper_adversarial_test.go |
| 619 | PENDING | -- | PENDING | TestGatekeeper_34_2_5_OversizedQueryLimitCapped/negative_limit_clamped_to_default | core/test/gatekeeper_adversarial_test.go |
| 620 | PENDING | -- | PENDING | TestGatekeeper_34_2_5_OversizedQueryLimitCapped/positive_control_response_contains_items_array | core/test/gatekeeper_adversarial_test.go |
| 621 | TAGGED | TST-CORE-1024 | PENDING | TestGatekeeper_30_8_3_LockedPersonaDeadDropIngress | core/test/gatekeeper_adversarial_test.go |
| 622 | PENDING | -- | PENDING | TestGatekeeper_30_8_3_LockedPersonaDeadDropIngress/vault_query_on_locked_persona_returns_403 | core/test/gatekeeper_adversarial_test.go |
| 623 | PENDING | -- | PENDING | TestGatekeeper_30_8_3_LockedPersonaDeadDropIngress/vault_store_on_locked_persona_returns_403 | core/test/gatekeeper_adversarial_test.go |
| 624 | PENDING | -- | PENDING | TestGatekeeper_30_8_3_LockedPersonaDeadDropIngress/dead_drop_accepts_messages_while_locked | core/test/gatekeeper_adversarial_test.go |
| 625 | PENDING | -- | PENDING | TestGatekeeper_30_8_3_LockedPersonaDeadDropIngress/vault_query_and_dead_drop_combined_scenario | core/test/gatekeeper_adversarial_test.go |
| 626 | PENDING | -- | PENDING | TestGatekeeper_30_8_3_LockedPersonaDeadDropIngress/after_unlock_vault_query_succeeds | core/test/gatekeeper_adversarial_test.go |
| 627 | PENDING | -- | PENDING | TestGatekeeper_30_8_3_LockedPersonaDeadDropIngress/after_unlock_vault_store_succeeds | core/test/gatekeeper_adversarial_test.go |
| 628 | PENDING | -- | PENDING | TestGatekeeper_30_8_3_LockedPersonaDeadDropIngress/different_persona_still_locked | core/test/gatekeeper_adversarial_test.go |
| 629 | TAGGED | TST-CORE-998 | PENDING | TestContract_30_3_8_JSONSchemaFrozenGoldenExamples | core/test/gatekeeper_adversarial_test.go |
| 630 | PENDING | -- | PENDING | TestContract_30_3_8_JSONSchemaFrozenGoldenExamples/vault_query_response_schema | core/test/gatekeeper_adversarial_test.go |
| 631 | PENDING | -- | PENDING | TestContract_30_3_8_JSONSchemaFrozenGoldenExamples/vault_store_response_schema | core/test/gatekeeper_adversarial_test.go |
| 632 | PENDING | -- | PENDING | TestContract_30_3_8_JSONSchemaFrozenGoldenExamples/vault_store_batch_response_schema | core/test/gatekeeper_adversarial_test.go |
| 633 | PENDING | -- | PENDING | TestContract_30_3_8_JSONSchemaFrozenGoldenExamples/vault_query_invalid_body_error_schema | core/test/gatekeeper_adversarial_test.go |
| 634 | PENDING | -- | PENDING | TestContract_30_3_8_JSONSchemaFrozenGoldenExamples/vault_query_invalid_persona_error_schema | core/test/gatekeeper_adversarial_test.go |
| 635 | PENDING | -- | PENDING | TestContract_30_3_8_JSONSchemaFrozenGoldenExamples/vault_query_method_not_allowed_schema | core/test/gatekeeper_adversarial_test.go |
| 636 | PENDING | -- | PENDING | TestContract_30_3_8_JSONSchemaFrozenGoldenExamples/vault_store_method_not_allowed_schema | core/test/gatekeeper_adversarial_test.go |
| 637 | PENDING | -- | PENDING | TestContract_30_3_8_JSONSchemaFrozenGoldenExamples/vault_query_locked_persona_error_schema | core/test/gatekeeper_adversarial_test.go |
| 638 | PENDING | -- | PENDING | TestContract_30_3_8_JSONSchemaFrozenGoldenExamples/positive_control_request_fields_accepted | core/test/gatekeeper_adversarial_test.go |
| 639 | PENDING | -- | PENDING | TestContract_30_3_7_PIIScrubContractBrainToCore | core/test/gatekeeper_adversarial_test.go |
| 640 | PENDING | -- | PENDING | TestContract_30_3_7_PIIScrubContractBrainToCore/valid_scrub_request_returns_scrubbed_and_entities | core/test/gatekeeper_adversarial_test.go |
| 641 | PENDING | -- | PENDING | TestContract_30_3_7_PIIScrubContractBrainToCore/empty_text_returns_400 | core/test/gatekeeper_adversarial_test.go |
| 642 | PENDING | -- | PENDING | TestContract_30_3_7_PIIScrubContractBrainToCore/invalid_json_body_returns_400 | core/test/gatekeeper_adversarial_test.go |
| 643 | PENDING | -- | PENDING | TestContract_30_3_7_PIIScrubContractBrainToCore/wrong_method_returns_405 | core/test/gatekeeper_adversarial_test.go |
| 644 | PENDING | -- | PENDING | TestContract_30_3_7_PIIScrubContractBrainToCore/scrubber_error_returns_500 | core/test/gatekeeper_adversarial_test.go |
| 645 | PENDING | -- | PENDING | TestContract_30_3_1_RealCoreHTTPRouterContract | core/test/gatekeeper_adversarial_test.go |
| 646 | PENDING | -- | PENDING | TestContract_30_3_1_RealCoreHTTPRouterContract/vault_query_routed_correctly | core/test/gatekeeper_adversarial_test.go |
| 647 | PENDING | -- | PENDING | TestContract_30_3_1_RealCoreHTTPRouterContract/vault_store_routed_correctly | core/test/gatekeeper_adversarial_test.go |
| 648 | PENDING | -- | PENDING | TestContract_30_3_1_RealCoreHTTPRouterContract/vault_store_batch_routed_correctly | core/test/gatekeeper_adversarial_test.go |
| 649 | PENDING | -- | PENDING | TestContract_30_3_1_RealCoreHTTPRouterContract/pii_scrub_routed_correctly | core/test/gatekeeper_adversarial_test.go |
| 650 | PENDING | -- | PENDING | TestContract_30_3_1_RealCoreHTTPRouterContract/healthz_routed_correctly | core/test/gatekeeper_adversarial_test.go |
| 651 | PENDING | -- | PENDING | TestContract_30_3_1_RealCoreHTTPRouterContract/unregistered_route_returns_404 | core/test/gatekeeper_adversarial_test.go |
| 652 | PENDING | -- | PENDING | TestContract_30_3_1_RealCoreHTTPRouterContract/wrong_method_on_vault_query_returns_405 | core/test/gatekeeper_adversarial_test.go |
| 653 | PENDING | -- | PENDING | TestContract_30_3_6_BrainToCoreVaultQueryContract | core/test/gatekeeper_adversarial_test.go |
| 654 | PENDING | -- | PENDING | TestContract_30_3_6_BrainToCoreVaultQueryContract/minimal_query_persona_and_text_only | core/test/gatekeeper_adversarial_test.go |
| 655 | PENDING | -- | PENDING | TestContract_30_3_6_BrainToCoreVaultQueryContract/full_query_all_fields_accepted | core/test/gatekeeper_adversarial_test.go |
| 656 | PENDING | -- | PENDING | TestContract_30_3_6_BrainToCoreVaultQueryContract/query_different_persona | core/test/gatekeeper_adversarial_test.go |
| 657 | PENDING | -- | PENDING | TestContract_30_3_6_BrainToCoreVaultQueryContract/query_locked_persona_returns_403 | core/test/gatekeeper_adversarial_test.go |
| 658 | PENDING | -- | PENDING | TestContract_30_3_6_BrainToCoreVaultQueryContract/query_invalid_persona_name_returns_400 | core/test/gatekeeper_adversarial_test.go |
| 659 | PENDING | -- | PENDING | TestContract_30_3_6_BrainToCoreVaultQueryContract/query_empty_body_returns_400 | core/test/gatekeeper_adversarial_test.go |
| 660 | PENDING | -- | PENDING | TestContract_30_3_6_BrainToCoreVaultQueryContract/items_array_has_expected_fields | core/test/gatekeeper_adversarial_test.go |
| 661 | PENDING | -- | PENDING | TestContract_30_3_6_BrainToCoreVaultQueryContract/search_mode_degradation_signals | core/test/gatekeeper_adversarial_test.go |
| 662 | PENDING | -- | PENDING | TestContract_30_6_3_RealDeleteAPIsUsedNotFiltering | core/test/gatekeeper_adversarial_test.go |
| 663 | PENDING | -- | PENDING | TestContract_30_6_3_RealDeleteAPIsUsedNotFiltering/delete_calls_writer_delete_method | core/test/gatekeeper_adversarial_test.go |
| 664 | PENDING | -- | PENDING | TestContract_30_6_3_RealDeleteAPIsUsedNotFiltering/get_item_after_delete_returns_not_found | core/test/gatekeeper_adversarial_test.go |
| 665 | PENDING | -- | PENDING | TestContract_30_6_3_RealDeleteAPIsUsedNotFiltering/delete_on_locked_persona_returns_403 | core/test/gatekeeper_adversarial_test.go |
| 666 | PENDING | -- | PENDING | TestContract_30_6_3_RealDeleteAPIsUsedNotFiltering/delete_with_empty_id_returns_400 | core/test/gatekeeper_adversarial_test.go |
| 667 | PENDING | -- | PENDING | TestContract_30_6_3_RealDeleteAPIsUsedNotFiltering/wrong_method_returns_405 | core/test/gatekeeper_adversarial_test.go |
| 668 | PENDING | -- | PENDING | TestContract_30_6_3_RealDeleteAPIsUsedNotFiltering/multiple_deletes_are_tracked | core/test/gatekeeper_adversarial_test.go |
| 669 | PENDING | -- | PENDING | TestSecurity_30_10_3_EgressPolicyEnforcementAllCategories | core/test/gatekeeper_adversarial_test.go |
| 670 | PENDING | -- | PENDING | TestSecurity_30_10_3_EgressPolicyEnforcementAllCategories/pii_email_blocked | core/test/gatekeeper_adversarial_test.go |
| 671 | PENDING | -- | PENDING | TestSecurity_30_10_3_EgressPolicyEnforcementAllCategories/pii_ssn_blocked | core/test/gatekeeper_adversarial_test.go |
| 672 | PENDING | -- | PENDING | TestSecurity_30_10_3_EgressPolicyEnforcementAllCategories/pii_credit_card_blocked | core/test/gatekeeper_adversarial_test.go |
| 673 | PENDING | -- | PENDING | TestSecurity_30_10_3_EgressPolicyEnforcementAllCategories/pii_phone_blocked | core/test/gatekeeper_adversarial_test.go |
| 674 | PENDING | -- | PENDING | TestSecurity_30_10_3_EgressPolicyEnforcementAllCategories/pii_ip_address_blocked | core/test/gatekeeper_adversarial_test.go |
| 675 | PENDING | -- | PENDING | TestSecurity_30_10_3_EgressPolicyEnforcementAllCategories/clean_data_to_trusted_destination_allowed | core/test/gatekeeper_adversarial_test.go |
| 676 | PENDING | -- | PENDING | TestSecurity_30_10_3_EgressPolicyEnforcementAllCategories/clean_data_to_unknown_destination_allowed | core/test/gatekeeper_adversarial_test.go |
| 677 | PENDING | -- | PENDING | TestSecurity_30_10_3_EgressPolicyEnforcementAllCategories/any_data_to_blocked_destination_denied | core/test/gatekeeper_adversarial_test.go |
| 678 | PENDING | -- | PENDING | TestSecurity_30_10_3_EgressPolicyEnforcementAllCategories/pii_to_trusted_destination_still_blocked | core/test/gatekeeper_adversarial_test.go |
| 679 | PENDING | -- | PENDING | TestSecurity_30_10_3_EgressPolicyEnforcementAllCategories/nil_data_to_any_destination_allowed | core/test/gatekeeper_adversarial_test.go |
| 680 | PENDING | -- | PENDING | TestSecurity_30_10_3_EgressPolicyEnforcementAllCategories/empty_destination_returns_error | core/test/gatekeeper_adversarial_test.go |
| 681 | PENDING | -- | PENDING | TestSecurity_30_10_3_EgressPolicyEnforcementAllCategories/multiple_pii_types_in_single_payload_blocked | core/test/gatekeeper_adversarial_test.go |
| 682 | PENDING | -- | PENDING | TestSecurity_30_10_3_EgressPolicyEnforcementAllCategories/pii_embedded_in_large_json_still_detected | core/test/gatekeeper_adversarial_test.go |
| 683 | PENDING | -- | PENDING | TestSecurity_34_2_9_AgentCannotEscalateFromTaskScopedToFullAccess | core/test/gatekeeper_adversarial_test.go |
| 684 | PENDING | -- | PENDING | TestSecurity_34_2_9_AgentCannotEscalateFromTaskScopedToFullAccess/draft_only_blocks_send_email | core/test/gatekeeper_adversarial_test.go |
| 685 | PENDING | -- | PENDING | TestSecurity_34_2_9_AgentCannotEscalateFromTaskScopedToFullAccess/draft_only_blocks_transfer_money | core/test/gatekeeper_adversarial_test.go |
| 686 | PENDING | -- | PENDING | TestSecurity_34_2_9_AgentCannotEscalateFromTaskScopedToFullAccess/draft_only_blocks_share_data | core/test/gatekeeper_adversarial_test.go |
| 687 | PENDING | -- | PENDING | TestSecurity_34_2_9_AgentCannotEscalateFromTaskScopedToFullAccess/draft_only_allows_vault_read | core/test/gatekeeper_adversarial_test.go |
| 688 | PENDING | -- | PENDING | TestSecurity_34_2_9_AgentCannotEscalateFromTaskScopedToFullAccess/persona_constraint_blocks_cross_persona_access | core/test/gatekeeper_adversarial_test.go |
| 689 | PENDING | -- | PENDING | TestSecurity_34_2_9_AgentCannotEscalateFromTaskScopedToFullAccess/persona_constraint_allows_own_persona | core/test/gatekeeper_adversarial_test.go |
| 690 | PENDING | -- | PENDING | TestSecurity_34_2_9_AgentCannotEscalateFromTaskScopedToFullAccess/persona_constraint_blocks_all_other_personas | core/test/gatekeeper_adversarial_test.go |
| 691 | PENDING | -- | PENDING | TestSecurity_34_2_9_AgentCannotEscalateFromTaskScopedToFullAccess/compound_constraints_both_enforced | core/test/gatekeeper_adversarial_test.go |
| 692 | PENDING | -- | PENDING | TestSecurity_34_2_9_AgentCannotEscalateFromTaskScopedToFullAccess/false_constraint_value_does_not_restrict | core/test/gatekeeper_adversarial_test.go |
| 693 | PENDING | -- | PENDING | TestSecurity_34_2_9_AgentCannotEscalateFromTaskScopedToFullAccess/nil_constraints_no_restriction | core/test/gatekeeper_adversarial_test.go |
| 694 | PENDING | -- | PENDING | TestSecurity_34_2_9_AgentCannotEscalateFromTaskScopedToFullAccess/brain_agent_with_constraints_still_denied_security_actions | core/test/gatekeeper_adversarial_test.go |
| 695 | TAGGED | TST-CORE-1200 | PENDING | TestAdv_34_3_ApprovalLifecycleE2E | core/test/gatekeeper_adversarial_test.go |
| 696 | PENDING | -- | PENDING | TestAdv_34_3_ApprovalLifecycleE2E/default_persona_always_allowed_for_agent | core/test/gatekeeper_adversarial_test.go |
| 697 | PENDING | -- | PENDING | TestAdv_34_3_ApprovalLifecycleE2E/standard_persona_denied_without_session | core/test/gatekeeper_adversarial_test.go |
| 698 | PENDING | -- | PENDING | TestAdv_34_3_ApprovalLifecycleE2E/sensitive_persona_denied_then_approved | core/test/gatekeeper_adversarial_test.go |
| 699 | PENDING | -- | PENDING | TestAdv_34_3_ApprovalLifecycleE2E/cross_agent_grant_isolation | core/test/gatekeeper_adversarial_test.go |
| 700 | PENDING | -- | PENDING | TestAdv_34_3_ApprovalLifecycleE2E/user_always_allowed_for_sensitive | core/test/gatekeeper_adversarial_test.go |
| 701 | PENDING | -- | PENDING | TestAdv_34_3_ApprovalLifecycleE2E/locked_persona_denies_agent_unconditionally | core/test/gatekeeper_adversarial_test.go |
| 702 | PENDING | -- | PENDING | TestAdv_34_3_ApprovalLifecycleE2E/session_end_revokes_grants | core/test/gatekeeper_adversarial_test.go |
| 703 | PENDING | -- | PENDING | TestAdv_34_3_ApprovalLifecycleE2E/denied_approval_stays_denied | core/test/gatekeeper_adversarial_test.go |
| 704 | TAGGED | TST-CORE-783 | PENDING | TestGatekeeper_6_1_1_SafeIntentAllowed | core/test/gatekeeper_test.go |
| 705 | TAGGED | TST-CORE-784 | PENDING | TestGatekeeper_6_1_2_RiskyIntentFlagged | core/test/gatekeeper_test.go |
| 706 | TAGGED | TST-CORE-785 | PENDING | TestGatekeeper_6_1_3_BlockedIntentDenied | core/test/gatekeeper_test.go |
| 707 | TAGGED | TST-CORE-786 | PENDING | TestGatekeeper_6_1_4_ReadVaultByUntrustedDenied | core/test/gatekeeper_test.go |
| 708 | TAGGED | TST-CORE-787 | PENDING | TestGatekeeper_6_1_5_EmptyActionRejected | core/test/gatekeeper_test.go |
| 709 | TAGGED | TST-CORE-788 | PENDING | TestGatekeeper_6_1_6_EmptyAgentDIDRejected | core/test/gatekeeper_test.go |
| 710 | TAGGED | TST-CORE-789 | PENDING | TestGatekeeper_6_1_7_DecisionContainsReason | core/test/gatekeeper_test.go |
| 711 | TAGGED | TST-CORE-790 | PENDING | TestGatekeeper_6_1_8_SafeIntentNoAudit | core/test/gatekeeper_test.go |
| 712 | TAGGED | TST-CORE-791 | PENDING | TestGatekeeper_6_1_9_MockAllowAll | core/test/gatekeeper_test.go |
| 713 | TAGGED | TST-CORE-792 | PENDING | TestGatekeeper_6_1_10_MockDenyAll | core/test/gatekeeper_test.go |
| 714 | TAGGED | TST-CORE-793 | PENDING | TestGatekeeper_6_2_1_EgressToTrustedDestination | core/test/gatekeeper_test.go |
| 715 | TAGGED | TST-CORE-794 | PENDING | TestGatekeeper_6_2_2_EgressToBlockedDestination | core/test/gatekeeper_test.go |
| 716 | TAGGED | TST-CORE-795 | PENDING | TestGatekeeper_6_2_3_EgressWithPIIBlocked | core/test/gatekeeper_test.go |
| 717 | TAGGED | TST-CORE-796 | PENDING | TestGatekeeper_6_2_4_EgressEmptyDestinationRejected | core/test/gatekeeper_test.go |
| 718 | TAGGED | TST-CORE-797 | PENDING | TestGatekeeper_6_2_5_EgressNilDataAllowed | core/test/gatekeeper_test.go |
| 719 | TAGGED | TST-CORE-798 | PENDING | TestGatekeeper_6_2_6_MockEgressDeny | core/test/gatekeeper_test.go |
| 720 | TAGGED | TST-CORE-799 | PENDING | TestGatekeeper_6_3_1_TrustedAgentAccessesOpenPersona | core/test/gatekeeper_test.go |
| 721 | TAGGED | TST-CORE-800 | PENDING | TestGatekeeper_6_3_2_UntrustedAgentDeniedLockedPersona | core/test/gatekeeper_test.go |
| 722 | TAGGED | TST-CORE-801 | PENDING | TestGatekeeper_6_3_3_VerifiedAgentRestrictedPersona | core/test/gatekeeper_test.go |
| 723 | TAGGED | TST-CORE-802 | PENDING | TestGatekeeper_6_3_4_CrossPersonaAccessDenied | core/test/gatekeeper_test.go |
| 724 | TAGGED | TST-CORE-803 | PENDING | TestGatekeeper_6_3_5_MoneyActionRequiresTrustedRing | core/test/gatekeeper_test.go |
| 725 | TAGGED | TST-CORE-804 | PENDING | TestGatekeeper_6_3_6_DataSharingActionFlagged | core/test/gatekeeper_test.go |
| 726 | TAGGED | TST-CORE-360 | PENDING | TestGatekeeper_6_1_SP1_DefaultDenyNoPolicyExists | core/test/gatekeeper_test.go |
| 727 | TAGGED | TST-CORE-361 | PENDING | TestGatekeeper_6_1_SP2_DefaultDenyMissingCategoryKey | core/test/gatekeeper_test.go |
| 728 | TAGGED | TST-CORE-362 | PENDING | TestGatekeeper_6_1_SP3_PolicyNoneExplicit | core/test/gatekeeper_test.go |
| 729 | TAGGED | TST-CORE-363 | PENDING | TestGatekeeper_6_1_SP4_PolicySummaryTier | core/test/gatekeeper_test.go |
| 730 | TAGGED | TST-CORE-364 | PENDING | TestGatekeeper_6_1_SP5_PolicyFullTier | core/test/gatekeeper_test.go |
| 731 | TAGGED | TST-CORE-365 | PENDING | TestGatekeeper_6_1_SP6_PerContactPerCategoryGranularity | core/test/gatekeeper_test.go |
| 732 | TAGGED | TST-CORE-366 | PENDING | TestGatekeeper_6_1_SP7_DomainSpecificETAOnly | core/test/gatekeeper_test.go |
| 733 | TAGGED | TST-CORE-367 | PENDING | TestGatekeeper_6_1_SP8_DomainSpecificFreeBusy | core/test/gatekeeper_test.go |
| 734 | TAGGED | TST-CORE-368 | PENDING | TestGatekeeper_6_1_SP9_DomainSpecificExactLocation | core/test/gatekeeper_test.go |
| 735 | TAGGED | TST-CORE-371 | PENDING | TestGatekeeper_6_1_SP12_TrustLevelNotEqualSharing | core/test/gatekeeper_test.go |
| 736 | TAGGED | TST-CORE-372 | PENDING | TestGatekeeper_6_1_SP13_RecognizedCategories | core/test/gatekeeper_test.go |
| 737 | TAGGED | TST-CORE-375 | PENDING | TestGatekeeper_6_1_SP16_ExtensibleCategoryAccepted | core/test/gatekeeper_test.go |
| 738 | TAGGED | TST-CORE-376 | PENDING | TestGatekeeper_6_1_SP17_ExtensibleCategoryEnforcedAtEgress | core/test/gatekeeper_test.go |
| 739 | TAGGED | TST-CORE-369 | PENDING | TestGatekeeper_6_1_SP10_PolicyUpdateViaPatch | core/test/gatekeeper_test.go |
| 740 | TAGGED | TST-CORE-370 | PENDING | TestGatekeeper_6_1_SP11_BulkPolicyUpdate | core/test/gatekeeper_test.go |
| 741 | TAGGED | TST-CORE-373 | PENDING | TestGatekeeper_6_1_SP14_SharingDefaultsForNewContacts | core/test/gatekeeper_test.go |
| 742 | TAGGED | TST-CORE-374 | PENDING | TestGatekeeper_6_1_SP15_OutboundPIIScrub | core/test/gatekeeper_test.go |
| 743 | TAGGED | TST-CORE-377 | PENDING | TestGatekeeper_6_2_SP1_GetPolicy | core/test/gatekeeper_test.go |
| 744 | TAGGED | TST-CORE-378 | PENDING | TestGatekeeper_6_2_SP2_PatchSingleCategory | core/test/gatekeeper_test.go |
| 745 | TAGGED | TST-CORE-379 | PENDING | TestGatekeeper_6_2_SP3_PatchMultipleCategories | core/test/gatekeeper_test.go |
| 746 | TAGGED | TST-CORE-380 | PENDING | TestGatekeeper_6_2_SP4_PatchBulkByTrustLevel | core/test/gatekeeper_test.go |
| 747 | TAGGED | TST-CORE-381 | PENDING | TestGatekeeper_6_2_SP5_PatchBulkAllContacts | core/test/gatekeeper_test.go |
| 748 | TAGGED | TST-CORE-382 | PENDING | TestGatekeeper_6_2_SP6_GetPolicyUnknownDID | core/test/gatekeeper_test.go |
| 749 | TAGGED | TST-CORE-383 | PENDING | TestGatekeeper_6_2_SP7_PatchInvalidTierValue | core/test/gatekeeper_test.go |
| 750 | TAGGED | TST-CORE-384 | PENDING | TestGatekeeper_6_2_SP8_PolicyStoredInContactsTable | core/test/gatekeeper_test.go |
| 751 | TAGGED | TST-CORE-385 | PENDING | TestGatekeeper_6_3_EP1_BrainSendsTieredPayload | core/test/gatekeeper_test.go |
| 752 | TAGGED | TST-CORE-386 | PENDING | TestGatekeeper_6_3_EP2_CoreStripsDeniedCategories | core/test/gatekeeper_test.go |
| 753 | TAGGED | TST-CORE-387 | PENDING | TestGatekeeper_6_3_EP3_MalformedPayloadCategoryDropped | core/test/gatekeeper_test.go |
| 754 | TAGGED | TST-CORE-388 | PENDING | TestGatekeeper_6_3_EP4_EgressEnforcementInCompiledGo | core/test/gatekeeper_test.go |
| 755 | TAGGED | TST-CORE-389 | PENDING | TestGatekeeper_6_3_EP5_EgressNotIngress | core/test/gatekeeper_test.go |
| 756 | TAGGED | TST-CORE-390 | PENDING | TestGatekeeper_6_3_EP6_RecipientDIDResolution | core/test/gatekeeper_test.go |
| 757 | TAGGED | TST-CORE-391 | PENDING | TestGatekeeper_6_3_EP7_EgressAuditLogging | core/test/gatekeeper_test.go |
| 758 | TAGGED | TST-CORE-392 | PENDING | TestGatekeeper_6_3_EP8_AuditIncludesDeniedCategories | core/test/gatekeeper_test.go |
| 759 | TAGGED | TST-CORE-393 | PENDING | TestGatekeeper_6_3_EP9_NaClEncryptionAfterPolicyCheck | core/test/gatekeeper_test.go |
| 760 | TAGGED | TST-CORE-889 | PENDING | TestGatekeeper_6_4_AuditLog_90DayRollingRetention | core/test/gatekeeper_test.go |
| 761 | TAGGED | TST-CORE-890 | PENDING | TestGatekeeper_6_5_ContactsUpdatedAtRefreshedOnPolicyChange | core/test/gatekeeper_test.go |
| 762 | TAGGED | TST-CORE-891 | PENDING | TestGatekeeper_6_6_DraftConfidenceScore_Validated | core/test/gatekeeper_test.go |
| 763 | TAGGED | TST-CORE-892 | PENDING | TestGatekeeper_6_6_26_AgentConstraint_DraftOnlyEnforced | core/test/gatekeeper_test.go |
| 764 | TAGGED | TST-CORE-893 | PENDING | TestGatekeeper_6_6_27_AgentOutcome_RecordedForTrust | core/test/gatekeeper_test.go |
| 765 | TAGGED | TST-CORE-1122 | PENDING | TestGatekeeper_33_1_1_AgentCrossPersonaVaultQuery | core/test/gatekeeper_test.go |
| 766 | PENDING | -- | PENDING | TestGatekeeper_33_1_1_AgentCrossPersonaVaultQuery/consumer_agent_reads_health_denied | core/test/gatekeeper_test.go |
| 767 | PENDING | -- | PENDING | TestGatekeeper_33_1_1_AgentCrossPersonaVaultQuery/consumer_agent_reads_financial_denied | core/test/gatekeeper_test.go |
| 768 | PENDING | -- | PENDING | TestGatekeeper_33_1_1_AgentCrossPersonaVaultQuery/consumer_agent_reads_consumer_allowed | core/test/gatekeeper_test.go |
| 769 | PENDING | -- | PENDING | TestGatekeeper_33_1_1_AgentCrossPersonaVaultQuery/health_agent_reads_consumer_denied | core/test/gatekeeper_test.go |
| 770 | PENDING | -- | PENDING | TestGatekeeper_33_1_1_AgentCrossPersonaVaultQuery/unconstrained_agent_accesses_any_persona | core/test/gatekeeper_test.go |
| 771 | TAGGED | TST-CORE-980 | PENDING | TestGatekeeper_29_10_NoPolicyForContact_AllCategoriesDenied | core/test/gatekeeper_test.go |
| 772 | PENDING | -- | PENDING | TestGatekeeper_29_10_NoPolicyForContact_AllCategoriesDenied/all_six_categories_denied_real_impl | core/test/gatekeeper_test.go |
| 773 | PENDING | -- | PENDING | TestGatekeeper_29_10_NoPolicyForContact_AllCategoriesDenied/single_category_also_denied | core/test/gatekeeper_test.go |
| 774 | PENDING | -- | PENDING | TestGatekeeper_29_10_NoPolicyForContact_AllCategoriesDenied/contrast_known_contact_with_policy_allowed | core/test/gatekeeper_test.go |
| 775 | PENDING | -- | PENDING | TestGatekeeper_29_10_NoPolicyForContact_AllCategoriesDenied/empty_categories_payload_no_crash | core/test/gatekeeper_test.go |
| 776 | TAGGED | TST-CORE-981 | PENDING | TestGatekeeper_29_10_4_MalformedPayloadNonTieredPayloadDenied | core/test/gatekeeper_test.go |
| 777 | PENDING | -- | PENDING | TestGatekeeper_29_10_4_MalformedPayloadNonTieredPayloadDenied/raw_string_denied | core/test/gatekeeper_test.go |
| 778 | PENDING | -- | PENDING | TestGatekeeper_29_10_4_MalformedPayloadNonTieredPayloadDenied/integer_denied | core/test/gatekeeper_test.go |
| 779 | PENDING | -- | PENDING | TestGatekeeper_29_10_4_MalformedPayloadNonTieredPayloadDenied/bool_denied | core/test/gatekeeper_test.go |
| 780 | PENDING | -- | PENDING | TestGatekeeper_29_10_4_MalformedPayloadNonTieredPayloadDenied/nil_value_denied | core/test/gatekeeper_test.go |
| 781 | PENDING | -- | PENDING | TestGatekeeper_29_10_4_MalformedPayloadNonTieredPayloadDenied/nested_map_denied | core/test/gatekeeper_test.go |
| 782 | PENDING | -- | PENDING | TestGatekeeper_29_10_4_MalformedPayloadNonTieredPayloadDenied/slice_denied | core/test/gatekeeper_test.go |
| 783 | PENDING | -- | PENDING | TestGatekeeper_29_10_4_MalformedPayloadNonTieredPayloadDenied/contrast_well_formed_allowed | core/test/gatekeeper_test.go |
| 784 | PENDING | -- | PENDING | TestGatekeeper_29_10_4_MalformedPayloadNonTieredPayloadDenied/mixed_well_formed_and_malformed | core/test/gatekeeper_test.go |
| 785 | PENDING | -- | PENDING | TestGatekeeper_29_10_4_MalformedPayloadNonTieredPayloadDenied/audit_reason_malformed | core/test/gatekeeper_test.go |
| 786 | TAGGED | TST-CORE-979 | PENDING | TestGatekeeper_29_10_2_TierNoneBlocksCategory | core/test/gatekeeper_test.go |
| 787 | PENDING | -- | PENDING | TestGatekeeper_29_10_2_TierNoneBlocksCategory/tier_none_denies_valid_payload | core/test/gatekeeper_test.go |
| 788 | PENDING | -- | PENDING | TestGatekeeper_29_10_2_TierNoneBlocksCategory/positive_control_summary_tier_allows | core/test/gatekeeper_test.go |
| 789 | PENDING | -- | PENDING | TestGatekeeper_29_10_2_TierNoneBlocksCategory/audit_entry_reason_tier_none | core/test/gatekeeper_test.go |
| 790 | PENDING | -- | PENDING | TestGatekeeper_29_10_2_TierNoneBlocksCategory/selective_blocking_mixed_tiers | core/test/gatekeeper_test.go |
| 791 | PENDING | -- | PENDING | TestGatekeeper_29_10_2_TierNoneBlocksCategory/all_categories_none_nothing_filtered | core/test/gatekeeper_test.go |
| 792 | TAGGED | TST-CORE-977 | PENDING | TestGatekeeper_29_9_3_EgressDeniedAndAudited | core/test/gatekeeper_test.go |
| 793 | PENDING | -- | PENDING | TestGatekeeper_29_9_3_EgressDeniedAndAudited/denied_egress_audited_and_notified | core/test/gatekeeper_test.go |
| 794 | PENDING | -- | PENDING | TestGatekeeper_29_9_3_EgressDeniedAndAudited/positive_control_allowed_egress_audited_but_not_notified | core/test/gatekeeper_test.go |
| 795 | PENDING | -- | PENDING | TestGatekeeper_29_9_3_EgressDeniedAndAudited/multiple_destinations_selective_denial | core/test/gatekeeper_test.go |
| 796 | TAGGED | TST-CORE-1121 | PENDING | TestGatekeeper_34_1_5_UserSharingPolicyOverridesBotSuggestedVisibility | core/test/gatekeeper_test.go |
| 797 | PENDING | -- | PENDING | TestGatekeeper_34_1_5_UserSharingPolicyOverridesBotSuggestedVisibility/user_policy_none_blocks_bot_full_suggestion | core/test/gatekeeper_test.go |
| 798 | PENDING | -- | PENDING | TestGatekeeper_34_1_5_UserSharingPolicyOverridesBotSuggestedVisibility/user_policy_summary_downgrades_bot_full_suggestion | core/test/gatekeeper_test.go |
| 799 | PENDING | -- | PENDING | TestGatekeeper_34_1_5_UserSharingPolicyOverridesBotSuggestedVisibility/positive_control_user_policy_full_allows_full_content | core/test/gatekeeper_test.go |
| 800 | PENDING | -- | PENDING | TestGatekeeper_34_1_5_UserSharingPolicyOverridesBotSuggestedVisibility/mixed_policies_enforced_independently_per_category | core/test/gatekeeper_test.go |
| 801 | PENDING | -- | PENDING | TestGatekeeper_34_1_5_UserSharingPolicyOverridesBotSuggestedVisibility/audit_entries_reflect_user_policy_not_bot_suggestion | core/test/gatekeeper_test.go |
| 802 | TAGGED | TST-CORE-1106 | PENDING | TestIdentity_3_DeterministicCorruptMetadataFailsClosed | core/test/identity_deterministic_test.go |
| 803 | TAGGED | TST-CORE-1107 | PENDING | TestIdentity_3_DeterministicGenerationPersistsAcrossRestart | core/test/identity_deterministic_test.go |
| 804 | TAGGED | TST-CORE-1108 | PENDING | TestIdentity_3_DeterministicRejectsNonNextGeneration | core/test/identity_deterministic_test.go |
| 805 | TAGGED | TST-CORE-1109 | PENDING | TestIdentity_3_DeterministicPLCBranchIsolated | core/test/identity_deterministic_test.go |
| 806 | PENDING | -- | PENDING | TestIdentity_3_DeterministicKeyRotationWithPersistenceRestart | core/test/identity_deterministic_test.go |
| 807 | PENDING | -- | PENDING | TestIdentity_3_DeterministicKeyRotationWithPersistenceRestart/rotate_persists_and_survives_restart | core/test/identity_deterministic_test.go |
| 808 | PENDING | -- | PENDING | TestIdentity_3_DeterministicKeyRotationWithPersistenceRestart/old_key_cannot_sign_rotation_after_restart | core/test/identity_deterministic_test.go |
| 809 | PENDING | -- | PENDING | TestIdentity_3_DeterministicKeyRotationWithPersistenceRestart/rotation_fail_closed_no_metadata_no_rotation | core/test/identity_deterministic_test.go |
| 810 | PENDING | -- | PENDING | TestIdentity_3_DeterministicKeyRotationWithPersistenceRestart/deterministic_key_derivation_across_generations | core/test/identity_deterministic_test.go |
| 811 | PENDING | -- | PENDING | TestIdentity_3_DeterministicKeyRotationWithPersistenceRestart/each_generation_produces_unique_key | core/test/identity_deterministic_test.go |
| 812 | PENDING | -- | PENDING | TestIdentity_3_DeterministicKeyRotationWithPersistenceRestart/RootSigningPath_format_correct | core/test/identity_deterministic_test.go |
| 813 | TAGGED | TST-CORE-1110 | PENDING | TestSecurity_17_VectorUnlockHydratesHNSW | core/test/identity_deterministic_test.go |
| 814 | TAGGED | TST-CORE-1111 | PENDING | TestSecurity_17_VectorLockDestroysIndex | core/test/identity_deterministic_test.go |
| 815 | TAGGED | TST-CORE-1112 | PENDING | TestSecurity_17_VectorNoPlaintextFiles | core/test/identity_deterministic_test.go |
| 816 | TAGGED | TST-CORE-1113 | PENDING | TestSecurity_17_VectorRestartRebuildsFromSQLCipher | core/test/identity_deterministic_test.go |
| 817 | TAGGED | TST-CORE-1114 | PENDING | TestInfra_30_StaticAuditNoLatestTags | core/test/identity_deterministic_test.go |
| 818 | TAGGED | TST-CORE-1115 | PENDING | TestInfra_30_StaticAuditNoUnexpectedPublicRoutes | core/test/identity_deterministic_test.go |
| 819 | TAGGED | TST-CORE-1116 | PENDING | TestInfra_30_StaticAuditNoPlaintextVectorPatterns | core/test/identity_deterministic_test.go |
| 820 | TAGGED | TST-CORE-130 | PENDING | TestIdentity_3_1_1_GenerateRootDID | core/test/identity_test.go |
| 821 | TAGGED | TST-CORE-131 | PENDING | TestIdentity_3_1_2_LoadExistingDID | core/test/identity_test.go |
| 822 | TAGGED | TST-CORE-132 | PENDING | TestIdentity_3_1_3_DIDDocumentStructure | core/test/identity_test.go |
| 823 | TAGGED | TST-CORE-133 | PENDING | TestIdentity_3_1_4_MultiplePersonaDIDs | core/test/identity_test.go |
| 824 | TAGGED | TST-CORE-134 | PENDING | TestIdentity_3_1_5_DIDDocumentServiceEndpoint | core/test/identity_test.go |
| 825 | TAGGED | TST-CORE-135 | PENDING | TestIdentity_3_1_6_PLCDirectorySignedOpsOnly | core/test/identity_test.go |
| 826 | TAGGED | TST-CORE-136 | PENDING | TestIdentity_3_1_7_SecondRootGenerationRejected | core/test/identity_test.go |
| 827 | TAGGED | TST-CORE-137 | PENDING | TestIdentity_3_1_8_RootIdentityCreatedAtTimestamp | core/test/identity_test.go |
| 828 | TAGGED | TST-CORE-138 | PENDING | TestIdentity_3_1_9_DeviceOriginFingerprint | core/test/identity_test.go |
| 829 | TAGGED | TST-CORE-139 | PENDING | TestIdentity_3_1_10_MultikeyZ6MkPrefix | core/test/identity_test.go |
| 830 | TAGGED | TST-CORE-140 | PENDING | TestIdentity_3_1_1_1_RotateSigningKey | core/test/identity_test.go |
| 831 | TAGGED | TST-CORE-141 | PENDING | TestIdentity_3_1_1_2_RotationPreservesDID | core/test/identity_test.go |
| 832 | TAGGED | TST-CORE-142 | PENDING | TestIdentity_3_1_1_3_OldKeyInvalidAfterRotation | core/test/identity_test.go |
| 833 | TAGGED | TST-CORE-143 | PENDING | TestIdentity_3_1_1_4_RotationOpSignedByOldKey | core/test/identity_test.go |
| 834 | TAGGED | TST-CORE-144 | PENDING | TestIdentity_3_1_1_5_RecoveryKeysCanReclaimDID | core/test/identity_test.go |
| 835 | TAGGED | TST-CORE-145 | PENDING | TestIdentity_3_1_1_6_DeterministicRotationEnforcement | core/test/identity_test.go |
| 836 | TAGGED | TST-CORE-145 | PENDING | TestIdentity_3_1_2_1_DIDWebResolution | core/test/identity_test.go |
| 837 | TAGGED | TST-CORE-146 | PENDING | TestIdentity_3_1_2_2_DIDWebSameKeypair | core/test/identity_test.go |
| 838 | TAGGED | TST-CORE-147 | PENDING | TestIdentity_3_1_2_3_RotationPLCToDIDWeb | core/test/identity_test.go |
| 839 | TAGGED | TST-CORE-148 | PENDING | TestIdentity_3_1_2_4_DIDWebPiggybacksIngress | core/test/identity_test.go |
| 840 | TAGGED | TST-CORE-149 | PENDING | TestIdentity_3_1_2_5_DIDWebTradeoffAcknowledged | core/test/identity_test.go |
| 841 | TAGGED | TST-CORE-150 | PENDING | TestIdentity_3_2_1_CreatePersona | core/test/identity_test.go |
| 842 | TAGGED | TST-CORE-151 | PENDING | TestIdentity_3_2_2_ListPersonas | core/test/identity_test.go |
| 843 | TAGGED | TST-CORE-152 | PENDING | TestIdentity_3_2_3_DeletePersona | core/test/identity_test.go |
| 844 | TAGGED | TST-CORE-153 | PENDING | TestIdentity_3_2_4_DeleteFileRemovesPersona | core/test/identity_test.go |
| 845 | TAGGED | TST-CORE-154 | PENDING | TestIdentity_3_2_5_PersonaIsolation | core/test/identity_test.go |
| 846 | TAGGED | TST-CORE-155 | PENDING | TestIdentity_3_2_6_DefaultPersonaExists | core/test/identity_test.go |
| 847 | TAGGED | TST-CORE-156 | PENDING | TestIdentity_3_2_7_PerPersonaFileLayout | core/test/identity_test.go |
| 848 | TAGGED | TST-CORE-157 | PENDING | TestIdentity_3_2_8_PerPersonaIndependentDEK | core/test/identity_test.go |
| 849 | TAGGED | TST-CORE-158 | PENDING | TestIdentity_3_2_9_LockedPersonaOpaqueBytes | core/test/identity_test.go |
| 850 | TAGGED | TST-CORE-159 | PENDING | TestIdentity_3_2_10_SelectiveUnlockWithTTL | core/test/identity_test.go |
| 851 | TAGGED | TST-CORE-160 | PENDING | TestIdentity_3_2_11_PersonaKeySignsDIDComm | core/test/identity_test.go |
| 852 | TAGGED | TST-CORE-161 | PENDING | TestIdentity_3_2_12_PersonaKeySignsTrustNetwork | core/test/identity_test.go |
| 853 | TAGGED | TST-CORE-162 | PENDING | TestIdentity_3_2_13_NoCrossCompartmentCode | core/test/identity_test.go |
| 854 | TAGGED | TST-CORE-163 | PENDING | TestIdentity_3_3_1_AccessOpenTier | core/test/identity_test.go |
| 855 | TAGGED | TST-CORE-164 | PENDING | TestIdentity_3_3_2_AccessRestrictedTier | core/test/identity_test.go |
| 856 | TAGGED | TST-CORE-165 | PENDING | TestIdentity_3_3_3_AccessLockedTierWithoutUnlock | core/test/identity_test.go |
| 857 | TAGGED | TST-CORE-166 | PENDING | TestIdentity_3_3_4_UnlockLockedPersona | core/test/identity_test.go |
| 858 | TAGGED | TST-CORE-167 | PENDING | TestIdentity_3_3_5_LockedPersonaTTLExpiry | core/test/identity_test.go |
| 859 | TAGGED | TST-CORE-168 | PENDING | TestIdentity_3_3_6_LockedPersonaReLock | core/test/identity_test.go |
| 860 | TAGGED | TST-CORE-169 | PENDING | TestIdentity_3_3_7_AuditLogForRestrictedAccess | core/test/identity_test.go |
| 861 | TAGGED | TST-CORE-170 | PENDING | TestIdentity_3_3_8_NotificationOnRestrictedAccess | core/test/identity_test.go |
| 862 | TAGGED | TST-CORE-171 | PENDING | TestIdentity_3_3_9_LockedPersonaUnlockFlow | core/test/identity_test.go |
| 863 | TAGGED | TST-CORE-172 | PENDING | TestIdentity_3_3_10_LockedPersonaUnlockDenied | core/test/identity_test.go |
| 864 | TAGGED | TST-CORE-173 | PENDING | TestIdentity_3_3_11_LockedPersonaUnlockTTLExpires | core/test/identity_test.go |
| 865 | TAGGED | TST-CORE-174 | PENDING | TestIdentity_3_3_12_CrossPersonaParallelReads | core/test/identity_test.go |
| 866 | TAGGED | TST-CORE-175 | PENDING | TestIdentity_3_3_13_GetPersonasForContactDerived | core/test/identity_test.go |
| 867 | TAGGED | TST-CORE-176 | PENDING | TestIdentity_3_3_14_GetPersonasForContactLockedInvisible | core/test/identity_test.go |
| 868 | TAGGED | TST-CORE-177 | PENDING | TestIdentity_3_3_15_TierConfigInConfigJSON | core/test/identity_test.go |
| 869 | PENDING | -- | PENDING | TestIdentity_3_3_16_ValidTier | core/test/identity_test.go |
| 870 | PENDING | -- | PENDING | TestIdentity_3_3_17_CreateWithNewTiers | core/test/identity_test.go |
| 871 | PENDING | -- | PENDING | TestIdentity_3_3_18_AccessPersonaDefaultTier | core/test/identity_test.go |
| 872 | PENDING | -- | PENDING | TestIdentity_3_3_19_AccessPersonaStandardDeniesAgentWithoutSession | core/test/identity_test.go |
| 873 | PENDING | -- | PENDING | TestIdentity_3_3_20_AccessPersonaSensitiveDeniesAllNonUser | core/test/identity_test.go |
| 874 | PENDING | -- | PENDING | TestIdentity_3_3_21_SessionStartAndGrant | core/test/identity_test.go |
| 875 | PENDING | -- | PENDING | TestIdentity_3_3_22_SessionEndRevokesGrants | core/test/identity_test.go |
| 876 | PENDING | -- | PENDING | TestIdentity_3_3_23_SessionReconnect | core/test/identity_test.go |
| 877 | PENDING | -- | PENDING | TestIdentity_3_3_24_ApprovalLifecycle | core/test/identity_test.go |
| 878 | PENDING | -- | PENDING | TestIdentity_3_3_25_ApprovalDeny | core/test/identity_test.go |
| 879 | PENDING | -- | PENDING | TestIdentity_3_3_26_LockedTierDeniesAgentEvenUnlocked | core/test/identity_test.go |
| 880 | PENDING | -- | PENDING | TestIdentity_3_3_27_SingleUseGrantConsumed | core/test/identity_test.go |
| 881 | PENDING | -- | PENDING | TestIdentity_3_3_28_CrossAgentSessionIsolation | core/test/identity_test.go |
| 882 | PENDING | -- | PENDING | TestIdentity_3_3_29_EndToEndApprovalFlow | core/test/identity_test.go |
| 883 | PENDING | -- | PENDING | TestIdentity_3_3_30_SingleUseGrantClosesVault | core/test/identity_test.go |
| 884 | TAGGED | TST-CORE-178 | PENDING | TestIdentity_3_4_1_AddContact | core/test/identity_test.go |
| 885 | TAGGED | TST-CORE-179 | PENDING | TestIdentity_3_4_2_ResolveContactDID | core/test/identity_test.go |
| 886 | TAGGED | TST-CORE-180 | PENDING | TestIdentity_3_4_3_UpdateContactTrustLevel | core/test/identity_test.go |
| 887 | TAGGED | TST-CORE-181 | PENDING | TestIdentity_3_4_4_DeleteContact | core/test/identity_test.go |
| 888 | TAGGED | TST-CORE-182 | PENDING | TestIdentity_3_4_5_PerPersonaContactRouting | core/test/identity_test.go |
| 889 | TAGGED | TST-CORE-183 | PENDING | TestIdentity_3_4_6_ContactsTableNoPersonaColumn | core/test/identity_test.go |
| 890 | TAGGED | TST-CORE-184 | PENDING | TestIdentity_3_4_7_ContactsFullSchemaValidation | core/test/identity_test.go |
| 891 | TAGGED | TST-CORE-185 | PENDING | TestIdentity_3_4_8_TrustLevelEnumValidation | core/test/identity_test.go |
| 892 | TAGGED | TST-CORE-186 | PENDING | TestIdentity_3_4_9_ContactsTrustIndex | core/test/identity_test.go |
| 893 | TAGGED | TST-CORE-187 | PENDING | TestIdentity_3_5_1_RegisterDevice | core/test/identity_test.go |
| 894 | TAGGED | TST-CORE-188 | PENDING | TestIdentity_3_5_2_ListDevices | core/test/identity_test.go |
| 895 | TAGGED | TST-CORE-189 | PENDING | TestIdentity_3_5_3_RevokeDevice | core/test/identity_test.go |
| 896 | TAGGED | TST-CORE-190 | PENDING | TestIdentity_3_5_4_MaxDeviceLimit | core/test/identity_test.go |
| 897 | TAGGED | TST-CORE-191 | PENDING | TestIdentity_3_6_1_SplitMasterSeed | core/test/identity_test.go |
| 898 | TAGGED | TST-CORE-192 | PENDING | TestIdentity_3_6_2_ReconstructWithThreshold | core/test/identity_test.go |
| 899 | TAGGED | TST-CORE-193 | PENDING | TestIdentity_3_6_3_ReconstructFewerThanThreshold | core/test/identity_test.go |
| 900 | TAGGED | TST-CORE-194 | PENDING | TestIdentity_3_6_4_ReconstructWithInvalidShare | core/test/identity_test.go |
| 901 | TAGGED | TST-CORE-195 | PENDING | TestIdentity_3_6_5_ShareFormat | core/test/identity_test.go |
| 902 | TAGGED | TST-CORE-926 | PENDING | TestIdentity_3_6_6_IngressTierChange_DIDDocRotation | core/test/identity_test.go |
| 903 | TAGGED | TST-CORE-927 | PENDING | TestIdentity_3_6_7_TrustRingLevelsDefinedInCode | core/test/identity_test.go |
| 904 | TAGGED | TST-CORE-928 | PENDING | TestIdentity_3_6_8_NoMCPOrOpenClawVaultAccess | core/test/identity_test.go |
| 905 | PENDING | -- | PENDING | TestIdentity_3_7_1_MetadataPersisted | core/test/identity_test.go |
| 906 | PENDING | -- | PENDING | TestIdentity_3_7_2_MetadataLocalOnlyNoRotationKey | core/test/identity_test.go |
| 907 | PENDING | -- | PENDING | TestIdentity_3_7_3_MetadataLoadNoFile | core/test/identity_test.go |
| 908 | PENDING | -- | PENDING | TestIdentity_3_7_4_MetadataRoundTrip | core/test/identity_test.go |
| 909 | PENDING | -- | PENDING | TestIdentity_3_8_1_RestoreDIDFromMetadata | core/test/identity_test.go |
| 910 | PENDING | -- | PENDING | TestIdentity_3_8_2_RestoreDIDDeterministic | core/test/identity_test.go |
| 911 | PENDING | -- | PENDING | TestIdentity_3_8_3_RestoreRejectsDuplicate | core/test/identity_test.go |
| 912 | PENDING | -- | PENDING | TestIdentity_3_8_4_RestoreRejectsNilMetadata | core/test/identity_test.go |
| 913 | PENDING | -- | PENDING | TestIdentity_3_8_5_RestoreRejectsInvalidKey | core/test/identity_test.go |
| 914 | PENDING | -- | PENDING | TestIdentity_3_8_6_RestorePreservesMetadataFields | core/test/identity_test.go |
| 915 | PENDING | -- | PENDING | TestIdentity_3_8_7_RestoreHydratesGeneration | core/test/identity_test.go |
| 916 | PENDING | -- | PENDING | TestIdentity_3_9_1_ExportBundle | core/test/identity_test.go |
| 917 | PENDING | -- | PENDING | TestIdentity_3_9_2_ExportRequiresDID | core/test/identity_test.go |
| 918 | PENDING | -- | PENDING | TestIdentity_3_9_3_ImportBundleSecrets | core/test/identity_test.go |
| 919 | PENDING | -- | PENDING | TestIdentity_3_9_4_ImportRefusesOverwrite | core/test/identity_test.go |
| 920 | PENDING | -- | PENDING | TestIdentity_3_9_5_LoadBundleRejectsInvalid | core/test/identity_test.go |
| 921 | PENDING | -- | PENDING | TestIdentity_3_9_6_FullExportImportRoundTrip | core/test/identity_test.go |
| 922 | PENDING | -- | PENDING | TestIdentity_3_9_7_IntegrityDetectsTamperedMetadata | core/test/identity_test.go |
| 923 | PENDING | -- | PENDING | TestIdentity_3_9_8_IntegrityFailsWithWrongSeed | core/test/identity_test.go |
| 924 | PENDING | -- | PENDING | TestIdentity_3_9_9_RestorePersistedMetadataAvailableForExport | core/test/identity_test.go |
| 925 | TAGGED | TST-CORE-063 | PENDING | TestIdentity_2_1_MnemonicRecovery_SameDID | core/test/identity_test.go |
| 926 | PENDING | -- | PENDING | TestIdentity_2_1_MnemonicRecovery_SameDID/full_recovery_pipeline | core/test/identity_test.go |
| 927 | PENDING | -- | PENDING | TestIdentity_2_1_MnemonicRecovery_SameDID/different_mnemonic_different_DID | core/test/identity_test.go |
| 928 | PENDING | -- | PENDING | TestIdentity_2_1_MnemonicRecovery_SameDID/all_persona_keys_recoverable | core/test/identity_test.go |
| 929 | TAGGED | TST-CORE-689 | PENDING | TestLogging_21_1_1_GoCoreSlogJSON | core/test/logging_test.go |
| 930 | TAGGED | TST-CORE-690 | PENDING | TestLogging_21_1_2_PythonBrainStructlogJSON | core/test/logging_test.go |
| 931 | TAGGED | TST-CORE-691 | PENDING | TestLogging_21_1_3_NoFileLogs | core/test/logging_test.go |
| 932 | TAGGED | TST-CORE-692 | PENDING | TestLogging_21_1_4_DockerLogRotation | core/test/logging_test.go |
| 933 | TAGGED | TST-CORE-693 | PENDING | TestLogging_21_2_1_VaultContentNeverLogged | core/test/logging_test.go |
| 934 | TAGGED | TST-CORE-694 | PENDING | TestLogging_21_2_2_UserQueriesNeverLogged | core/test/logging_test.go |
| 935 | TAGGED | TST-CORE-695 | PENDING | TestLogging_21_2_3_BrainReasoningNeverLogged | core/test/logging_test.go |
| 936 | TAGGED | TST-CORE-696 | PENDING | TestLogging_21_2_4_NaClPlaintextNeverLogged | core/test/logging_test.go |
| 937 | TAGGED | TST-CORE-697 | PENDING | TestLogging_21_2_5_PassphraseNeverLogged | core/test/logging_test.go |
| 938 | TAGGED | TST-CORE-698 | PENDING | TestLogging_21_2_6_APITokensNeverLogged | core/test/logging_test.go |
| 939 | TAGGED | TST-CORE-699 | PENDING | TestLogging_21_3_1_CIBannedLogQuery | core/test/logging_test.go |
| 940 | TAGGED | TST-CORE-700 | PENDING | TestLogging_21_3_2_CIBannedLogContent | core/test/logging_test.go |
| 941 | TAGGED | TST-CORE-701 | PENDING | TestLogging_21_3_3_CIBannedLogBody | core/test/logging_test.go |
| 942 | TAGGED | TST-CORE-702 | PENDING | TestLogging_21_3_4_CIBannedLogPlaintext | core/test/logging_test.go |
| 943 | TAGGED | TST-CORE-703 | PENDING | TestLogging_21_3_5_CIBannedFStringUserData | core/test/logging_test.go |
| 944 | TAGGED | TST-CORE-704 | PENDING | TestLogging_21_3_6_NoSpaCyNEROnLogLines | core/test/logging_test.go |
| 945 | TAGGED | TST-CORE-705 | PENDING | TestLogging_21_4_1_CrashStdoutSanitizedOneLiner | core/test/logging_test.go |
| 946 | TAGGED | TST-CORE-706 | PENDING | TestLogging_21_4_2_CrashFullTracebackToVault | core/test/logging_test.go |
| 947 | TAGGED | TST-CORE-707 | PENDING | TestLogging_21_4_3_CatchAllWrapsMainLoop | core/test/logging_test.go |
| 948 | TAGGED | TST-CORE-708 | PENDING | TestLogging_21_4_4_CrashHandlerSendsTaskID | core/test/logging_test.go |
| 949 | TAGGED | TST-CORE-709 | PENDING | TestLogging_21_4_5_CrashHandlerReRaises | core/test/logging_test.go |
| 950 | TAGGED | TST-CORE-929 | PENDING | TestLogging_21_4_6_SpoolFileNaming_ULIDFormat | core/test/logging_test.go |
| 951 | PENDING | -- | PENDING | TestNotify_35_1_1_WebSocketPushRequiresExplicitPriority | core/test/notify_test.go |
| 952 | PENDING | -- | PENDING | TestNotify_35_1_1_WebSocketPushRequiresExplicitPriority/missing_priority_rejected_with_400 | core/test/notify_test.go |
| 953 | PENDING | -- | PENDING | TestNotify_35_1_1_WebSocketPushRequiresExplicitPriority/empty_priority_string_rejected | core/test/notify_test.go |
| 954 | PENDING | -- | PENDING | TestNotify_35_1_1_WebSocketPushRequiresExplicitPriority/invalid_priority_value_rejected | core/test/notify_test.go |
| 955 | PENDING | -- | PENDING | TestNotify_35_1_1_WebSocketPushRequiresExplicitPriority/case_sensitive_priority_rejected | core/test/notify_test.go |
| 956 | PENDING | -- | PENDING | TestNotify_35_1_1_WebSocketPushRequiresExplicitPriority/error_message_lists_valid_priorities | core/test/notify_test.go |
| 957 | PENDING | -- | PENDING | TestNotify_35_1_1_WebSocketPushRequiresExplicitPriority/fiduciary_priority_accepted | core/test/notify_test.go |
| 958 | PENDING | -- | PENDING | TestNotify_35_1_1_WebSocketPushRequiresExplicitPriority/solicited_priority_accepted | core/test/notify_test.go |
| 959 | PENDING | -- | PENDING | TestNotify_35_1_1_WebSocketPushRequiresExplicitPriority/engagement_priority_queued_not_pushed | core/test/notify_test.go |
| 960 | PENDING | -- | PENDING | TestNotify_35_1_1_WebSocketPushRequiresExplicitPriority/message_still_required_with_priority | core/test/notify_test.go |
| 961 | PENDING | -- | PENDING | TestNotify_35_1_1_WebSocketPushRequiresExplicitPriority/three_valid_priorities_exist | core/test/notify_test.go |
| 962 | PENDING | -- | PENDING | TestNotify_35_1_6_BrainCannotBypassPriorityClassification | core/test/notify_test.go |
| 963 | PENDING | -- | PENDING | TestNotify_35_1_6_BrainCannotBypassPriorityClassification/force_push_true_with_engagement_still_queued | core/test/notify_test.go |
| 964 | PENDING | -- | PENDING | TestNotify_35_1_6_BrainCannotBypassPriorityClassification/force_push_true_with_fiduciary_sends_normally | core/test/notify_test.go |
| 965 | PENDING | -- | PENDING | TestNotify_35_1_6_BrainCannotBypassPriorityClassification/force_push_true_with_solicited_sends_normally | core/test/notify_test.go |
| 966 | PENDING | -- | PENDING | TestNotify_35_1_6_BrainCannotBypassPriorityClassification/force_push_false_no_effect | core/test/notify_test.go |
| 967 | PENDING | -- | PENDING | TestNotify_35_1_6_BrainCannotBypassPriorityClassification/force_push_without_priority_still_rejected | core/test/notify_test.go |
| 968 | PENDING | -- | PENDING | TestNotify_35_1_6_BrainCannotBypassPriorityClassification/unknown_fields_ignored_gracefully | core/test/notify_test.go |
| 969 | PENDING | -- | PENDING | TestAuth_29_1_5_EmptySignatureBackwardCompatibility | core/test/notify_test.go |
| 970 | PENDING | -- | PENDING | TestAuth_29_1_5_EmptySignatureBackwardCompatibility/empty_X_Signature_falls_through_to_Bearer | core/test/notify_test.go |
| 971 | PENDING | -- | PENDING | TestAuth_29_1_5_EmptySignatureBackwardCompatibility/missing_all_signature_headers_falls_through_to_Bearer | core/test/notify_test.go |
| 972 | PENDING | -- | PENDING | TestAuth_29_1_5_EmptySignatureBackwardCompatibility/empty_X_DID_falls_through_to_Bearer | core/test/notify_test.go |
| 973 | PENDING | -- | PENDING | TestAuth_29_1_5_EmptySignatureBackwardCompatibility/empty_X_Timestamp_falls_through_to_Bearer | core/test/notify_test.go |
| 974 | PENDING | -- | PENDING | TestAuth_29_1_5_EmptySignatureBackwardCompatibility/empty_signature_no_Bearer_returns_401 | core/test/notify_test.go |
| 975 | PENDING | -- | PENDING | TestAuth_29_1_5_EmptySignatureBackwardCompatibility/no_auth_at_all_returns_401 | core/test/notify_test.go |
| 976 | PENDING | -- | PENDING | TestAuth_29_1_5_EmptySignatureBackwardCompatibility/invalid_Bearer_after_empty_signature_returns_401 | core/test/notify_test.go |
| 977 | PENDING | -- | PENDING | TestAuth_29_1_5_EmptySignatureBackwardCompatibility/public_paths_bypass_auth_entirely | core/test/notify_test.go |
| 978 | PENDING | -- | PENDING | TestNotify_35_1_2_EngagementTierNeverPushedViaWebSocket | core/test/notify_test.go |
| 979 | PENDING | -- | PENDING | TestNotify_35_1_2_EngagementTierNeverPushedViaWebSocket/engagement_without_DND_queued_not_broadcast | core/test/notify_test.go |
| 980 | PENDING | -- | PENDING | TestNotify_35_1_2_EngagementTierNeverPushedViaWebSocket/engagement_with_DND_active_still_queued | core/test/notify_test.go |
| 981 | PENDING | -- | PENDING | TestNotify_35_1_2_EngagementTierNeverPushedViaWebSocket/engagement_with_force_push_still_queued | core/test/notify_test.go |
| 982 | PENDING | -- | PENDING | TestNotify_35_1_2_EngagementTierNeverPushedViaWebSocket/engagement_with_DND_and_force_push_still_queued | core/test/notify_test.go |
| 983 | PENDING | -- | PENDING | TestNotify_35_1_2_EngagementTierNeverPushedViaWebSocket/multiple_engagement_notifications_all_queued | core/test/notify_test.go |
| 984 | PENDING | -- | PENDING | TestNotify_35_1_2_EngagementTierNeverPushedViaWebSocket/engagement_returns_200_not_202 | core/test/notify_test.go |
| 985 | PENDING | -- | PENDING | TestNotify_35_1_3_FiduciaryPushedEvenDuringDND | core/test/notify_test.go |
| 986 | PENDING | -- | PENDING | TestNotify_35_1_3_FiduciaryPushedEvenDuringDND/fiduciary_broadcast_when_DND_active | core/test/notify_test.go |
| 987 | PENDING | -- | PENDING | TestNotify_35_1_3_FiduciaryPushedEvenDuringDND/fiduciary_broadcast_when_DND_inactive | core/test/notify_test.go |
| 988 | PENDING | -- | PENDING | TestNotify_35_1_3_FiduciaryPushedEvenDuringDND/fiduciary_message_content_preserved_during_DND | core/test/notify_test.go |
| 989 | PENDING | -- | PENDING | TestNotify_35_1_3_FiduciaryPushedEvenDuringDND/fiduciary_status_is_sent_not_deferred_during_DND | core/test/notify_test.go |
| 990 | PENDING | -- | PENDING | TestNotify_35_1_3_FiduciaryPushedEvenDuringDND/multiple_fiduciary_during_DND_all_sent | core/test/notify_test.go |
| 991 | PENDING | -- | PENDING | TestNotify_35_1_3_FiduciaryPushedEvenDuringDND/fiduciary_with_nil_DND_checker_still_sends | core/test/notify_test.go |
| 992 | PENDING | -- | PENDING | TestNotify_35_1_3_FiduciaryPushedEvenDuringDND/DND_toggle_off_then_on_fiduciary_always_pushes | core/test/notify_test.go |
| 993 | PENDING | -- | PENDING | TestNotify_35_1_4_SolicitedDeferredDuringDND | core/test/notify_test.go |
| 994 | PENDING | -- | PENDING | TestNotify_35_1_4_SolicitedDeferredDuringDND/solicited_deferred_when_DND_active | core/test/notify_test.go |
| 995 | PENDING | -- | PENDING | TestNotify_35_1_4_SolicitedDeferredDuringDND/solicited_sent_when_DND_inactive | core/test/notify_test.go |
| 996 | PENDING | -- | PENDING | TestNotify_35_1_4_SolicitedDeferredDuringDND/solicited_with_nil_DND_checker_sends_normally | core/test/notify_test.go |
| 997 | PENDING | -- | PENDING | TestNotify_35_1_4_SolicitedDeferredDuringDND/deferred_status_distinct_from_queued | core/test/notify_test.go |
| 998 | PENDING | -- | PENDING | TestNotify_35_1_4_SolicitedDeferredDuringDND/multiple_solicited_during_DND_all_deferred | core/test/notify_test.go |
| 999 | PENDING | -- | PENDING | TestNotify_35_1_4_SolicitedDeferredDuringDND/DND_toggle_affects_solicited_routing | core/test/notify_test.go |
| 1000 | PENDING | -- | PENDING | TestNotify_35_1_4_SolicitedDeferredDuringDND/solicited_with_force_push_still_deferred_during_DND | core/test/notify_test.go |
| 1001 | PENDING | -- | PENDING | TestNotify_35_1_4_SolicitedDeferredDuringDND/mixed_priorities_during_DND_routed_correctly | core/test/notify_test.go |
| 1002 | PENDING | -- | PENDING | TestNotify_35_1_5_NotificationRateLimitingPerClient | core/test/notify_test.go |
| 1003 | PENDING | -- | PENDING | TestNotify_35_1_5_NotificationRateLimitingPerClient/rapid_solicited_notifications_hit_rate_limit | core/test/notify_test.go |
| 1004 | PENDING | -- | PENDING | TestNotify_35_1_5_NotificationRateLimitingPerClient/fiduciary_exempt_from_rate_limiting | core/test/notify_test.go |
| 1005 | PENDING | -- | PENDING | TestNotify_35_1_5_NotificationRateLimitingPerClient/rate_limit_resets_after_window_expires | core/test/notify_test.go |
| 1006 | PENDING | -- | PENDING | TestNotify_35_1_5_NotificationRateLimitingPerClient/no_rate_limit_when_limit_is_zero | core/test/notify_test.go |
| 1007 | PENDING | -- | PENDING | TestNotify_35_1_5_NotificationRateLimitingPerClient/engagement_unaffected_by_rate_limiting | core/test/notify_test.go |
| 1008 | PENDING | -- | PENDING | TestNotify_35_1_5_NotificationRateLimitingPerClient/rate_limit_429_response_includes_error_message | core/test/notify_test.go |
| 1009 | PENDING | -- | PENDING | TestNotify_35_1_5_NotificationRateLimitingPerClient/default_rate_limit_constants_reasonable | core/test/notify_test.go |
| 1010 | PENDING | -- | PENDING | TestNotify_35_1_5_NotificationRateLimitingPerClient/fiduciary_does_not_consume_rate_limit_quota | core/test/notify_test.go |
| 1011 | PENDING | -- | PENDING | TestNotify_35_1_5_NotificationRateLimitingPerClient/rate_limit_with_DND_interaction | core/test/notify_test.go |
| 1012 | TAGGED | TST-CORE-662 | PENDING | TestObservability_20_1_1_HealthzLiveness | core/test/observability_test.go |
| 1013 | TAGGED | TST-CORE-663 | PENDING | TestObservability_20_1_2_ReadyzVaultQueryable | core/test/observability_test.go |
| 1014 | TAGGED | TST-CORE-664 | PENDING | TestObservability_20_1_3_ReadyzVaultLocked | core/test/observability_test.go |
| 1015 | TAGGED | TST-CORE-665 | PENDING | TestObservability_20_1_4_ReadyzDBDeadlocked | core/test/observability_test.go |
| 1016 | TAGGED | TST-CORE-666 | PENDING | TestObservability_20_1_5_ZombieDetection | core/test/observability_test.go |
| 1017 | TAGGED | TST-CORE-667 | PENDING | TestObservability_20_1_6_HealthzUnauthenticated | core/test/observability_test.go |
| 1018 | TAGGED | TST-CORE-668 | PENDING | TestObservability_20_1_7_ReadyzUnauthenticated | core/test/observability_test.go |
| 1019 | TAGGED | TST-CORE-669 | PENDING | TestObservability_20_2_1_CoreHealthcheckEndpoint | core/test/observability_test.go |
| 1020 | TAGGED | TST-CORE-670 | PENDING | TestObservability_20_2_2_CoreHealthcheckInterval | core/test/observability_test.go |
| 1021 | TAGGED | TST-CORE-671 | PENDING | TestObservability_20_2_3_CoreHealthcheckTimeout | core/test/observability_test.go |
| 1022 | TAGGED | TST-CORE-672 | PENDING | TestObservability_20_2_4_CoreHealthcheckRetries | core/test/observability_test.go |
| 1023 | TAGGED | TST-CORE-673 | PENDING | TestObservability_20_2_5_CoreHealthcheckStartPeriod | core/test/observability_test.go |
| 1024 | TAGGED | TST-CORE-674 | PENDING | TestObservability_20_2_6_BrainHealthcheck | core/test/observability_test.go |
| 1025 | TAGGED | TST-CORE-675 | PENDING | TestObservability_20_2_7_PDSHealthcheck | core/test/observability_test.go |
| 1026 | TAGGED | TST-CORE-676 | PENDING | TestObservability_20_2_8_LlamaHealthcheck | core/test/observability_test.go |
| 1027 | TAGGED | TST-CORE-677 | PENDING | TestObservability_20_2_9_WgetNotCurl | core/test/observability_test.go |
| 1028 | TAGGED | TST-CORE-678 | PENDING | TestObservability_20_2_10_RestartAlways | core/test/observability_test.go |
| 1029 | TAGGED | TST-CORE-679 | PENDING | TestObservability_20_2_11_BrainDependsOnCoreHealthy | core/test/observability_test.go |
| 1030 | TAGGED | TST-CORE-680 | PENDING | TestObservability_20_2_12_CoreDependsOnPDSStarted | core/test/observability_test.go |
| 1031 | TAGGED | TST-CORE-681 | PENDING | TestObservability_20_2_13_LlamaProfileLocalLLM | core/test/observability_test.go |
| 1032 | TAGGED | TST-CORE-682 | PENDING | TestObservability_20_3_1_CrashTracebackStored | core/test/observability_test.go |
| 1033 | TAGGED | TST-CORE-683 | PENDING | TestObservability_20_3_2_CrashLogTableSchema | core/test/observability_test.go |
| 1034 | TAGGED | TST-CORE-684 | PENDING | TestObservability_20_3_3_CrashLogEncryptedAtRest | core/test/observability_test.go |
| 1035 | TAGGED | TST-CORE-685 | PENDING | TestObservability_20_3_4_CrashLogRetention90Days | core/test/observability_test.go |
| 1036 | TAGGED | TST-CORE-686 | PENDING | TestObservability_20_3_5_CrashLogQueryable | core/test/observability_test.go |
| 1037 | TAGGED | TST-CORE-687 | PENDING | TestObservability_20_3_6_CrashLogIncludedInBackup | core/test/observability_test.go |
| 1038 | TAGGED | TST-CORE-688 | PENDING | TestObservability_20_3_7_AdminUICrashHistory | core/test/observability_test.go |
| 1039 | TAGGED | TST-CORE-914 | PENDING | TestObservability_20_3_8_DockerComposeLoggingRotationConfig | core/test/observability_test.go |
| 1040 | TAGGED | TST-CORE-917 | PENDING | TestObservability_20_3_11_DataVolumeLayout | core/test/observability_test.go |
| 1041 | TAGGED | TST-CORE-649 | PENDING | TestOnboarding_19_1_ManagedOnboarding | core/test/onboarding_test.go |
| 1042 | TAGGED | TST-CORE-650 | PENDING | TestOnboarding_19_2_SeedReceivedFromClient | core/test/onboarding_test.go |
| 1043 | TAGGED | TST-CORE-651 | PENDING | TestOnboarding_19_3_RootKeypairDerived | core/test/onboarding_test.go |
| 1044 | TAGGED | TST-CORE-652 | PENDING | TestOnboarding_19_4_DIDRegistered | core/test/onboarding_test.go |
| 1045 | TAGGED | TST-CORE-653 | PENDING | TestOnboarding_19_5_DEKsDerived | core/test/onboarding_test.go |
| 1046 | TAGGED | TST-CORE-654 | PENDING | TestOnboarding_19_6_PasswordWrapsMasterSeed | core/test/onboarding_test.go |
| 1047 | TAGGED | TST-CORE-655 | PENDING | TestOnboarding_19_7_DatabasesCreated | core/test/onboarding_test.go |
| 1048 | TAGGED | TST-CORE-656 | PENDING | TestOnboarding_19_8_ConvenienceModeSet | core/test/onboarding_test.go |
| 1049 | TAGGED | TST-CORE-657 | PENDING | TestOnboarding_19_9_BrainStartsGuardianLoop | core/test/onboarding_test.go |
| 1050 | TAGGED | TST-CORE-658 | PENDING | TestOnboarding_19_10_InitialSyncTriggered | core/test/onboarding_test.go |
| 1051 | TAGGED | TST-CORE-659 | PENDING | TestOnboarding_19_11_OneDefaultPersona | core/test/onboarding_test.go |
| 1052 | TAGGED | TST-CORE-660 | PENDING | TestOnboarding_19_12_MnemonicBackupDeferred | core/test/onboarding_test.go |
| 1053 | TAGGED | TST-CORE-661 | PENDING | TestOnboarding_19_13_SharingRulesDefaultEmpty | core/test/onboarding_test.go |
| 1054 | TAGGED | TST-CORE-932 | PENDING | TestOnboarding_19_14_InstallSH_Bootstrap | core/test/onboarding_test.go |
| 1055 | TAGGED | TST-CORE-520 | PENDING | TestPairing_10_1_1_GenerateCode | core/test/pairing_test.go |
| 1056 | TAGGED | TST-CORE-520 | PENDING | TestPairing_10_1_2_GenerateCodeUniqueness | core/test/pairing_test.go |
| 1057 | TAGGED | TST-CORE-520 | PENDING | TestPairing_10_1_3_GenerateCodeEntropy | core/test/pairing_test.go |
| 1058 | TAGGED | TST-CORE-521 | PENDING | TestPairing_10_2_1_CompletePairingSuccess | core/test/pairing_test.go |
| 1059 | TAGGED | TST-CORE-523 | PENDING | TestPairing_10_2_2_CompletePairingInvalidCode | core/test/pairing_test.go |
| 1060 | TAGGED | TST-CORE-521 | PENDING | TestPairing_10_2_3_DeviceNameRecorded | core/test/pairing_test.go |
| 1061 | TAGGED | TST-CORE-530 | PENDING | TestPairing_10_1_4_TokenLengthAndEntropy | core/test/pairing_test.go |
| 1062 | TAGGED | TST-CORE-530 | PENDING | TestPairing_10_3_2_TokenUniquePerDevice | core/test/pairing_test.go |
| 1063 | TAGGED | TST-CORE-523 | PENDING | TestPairing_10_4_1_NumericCodeFormat | core/test/pairing_test.go |
| 1064 | TAGGED | TST-CORE-524 | PENDING | TestPairing_10_4_2_NumericCodeBruteForceResistance | core/test/pairing_test.go |
| 1065 | TAGGED | TST-CORE-524 | PENDING | TestPairing_10_4_3_CodeCollisionRetry | core/test/pairing_test.go |
| 1066 | TAGGED | TST-CORE-522 | PENDING | TestPairing_10_5_1_CodeExpiresAfterTTL | core/test/pairing_test.go |
| 1067 | TAGGED | TST-CORE-525 | PENDING | TestPairing_10_6_CodeSingleUse | core/test/pairing_test.go |
| 1068 | TAGGED | TST-CORE-526 | PENDING | TestPairing_10_7_ConcurrentPairingCodes | core/test/pairing_test.go |
| 1069 | TAGGED | TST-CORE-527 | PENDING | TestPairing_10_1_ListPairedDevices | core/test/pairing_test.go |
| 1070 | TAGGED | TST-CORE-528 | PENDING | TestPairing_10_1_RevokeDevice | core/test/pairing_test.go |
| 1071 | TAGGED | TST-CORE-529 | PENDING | TestPairing_10_1_PairCompletionResponseFields | core/test/pairing_test.go |
| 1072 | PENDING | -- | PENDING | TestPairing_DeviceRole_DefaultIsUser | core/test/pairing_test.go |
| 1073 | PENDING | -- | PENDING | TestPairing_DeviceRole_ExplicitAgent | core/test/pairing_test.go |
| 1074 | PENDING | -- | PENDING | TestPairing_DeviceRole_MixedRoles | core/test/pairing_test.go |
| 1075 | PENDING | -- | PENDING | TestPairing_GetDeviceByDID_Found | core/test/pairing_test.go |
| 1076 | PENDING | -- | PENDING | TestPairing_GetDeviceByDID_NotFound | core/test/pairing_test.go |
| 1077 | PENDING | -- | PENDING | TestPairing_GetDeviceByDID_Revoked | core/test/pairing_test.go |
| 1078 | PENDING | -- | PENDING | TestPairing_DeviceRole_TokenPairDefaultsUser | core/test/pairing_test.go |
| 1079 | TAGGED | TST-CORE-895 | PENDING | TestPairing_10_1_5_DeviceTypeRecorded | core/test/pairing_test.go |
| 1080 | TAGGED | TST-CORE-896 | PENDING | TestPairing_10_1_6_mDNS_AutoDiscoveryBroadcast | core/test/pairing_test.go |
| 1081 | TAGGED | TST-CORE-710 | PENDING | TestPDS_22_1_1_SignAttestationRecord | core/test/pds_test.go |
| 1082 | TAGGED | TST-CORE-711 | PENDING | TestPDS_22_1_2_SignOutcomeReport | core/test/pds_test.go |
| 1083 | TAGGED | TST-CORE-712 | PENDING | TestPDS_22_1_3_LexiconValidation | core/test/pds_test.go |
| 1084 | TAGGED | TST-CORE-713 | PENDING | TestPDS_22_1_4_RecordInMerkleRepo | core/test/pds_test.go |
| 1085 | TAGGED | TST-CORE-714 | PENDING | TestPDS_22_1_5_PDSConnectionFailure | core/test/pds_test.go |
| 1086 | TAGGED | TST-CORE-715 | PENDING | TestPDS_22_1_6_TypeBBundledPDS | core/test/pds_test.go |
| 1087 | TAGGED | TST-CORE-716 | PENDING | TestPDS_22_1_7_TypeAExternalPDS | core/test/pds_test.go |
| 1088 | TAGGED | TST-CORE-717 | PENDING | TestPDS_22_1_8_RatingRangeEnforcement | core/test/pds_test.go |
| 1089 | TAGGED | TST-CORE-718 | PENDING | TestPDS_22_1_9_VerdictIsStructuredObject | core/test/pds_test.go |
| 1090 | TAGGED | TST-CORE-719 | PENDING | TestPDS_22_1_10_AllRequiredFieldsValidated | core/test/pds_test.go |
| 1091 | TAGGED | TST-CORE-720 | PENDING | TestPDS_22_2_1_AuthorDeletesOwnRecord | core/test/pds_test.go |
| 1092 | TAGGED | TST-CORE-721 | PENDING | TestPDS_22_2_2_NonAuthorDeletionRejected | core/test/pds_test.go |
| 1093 | TAGGED | TST-CORE-722 | PENDING | TestPDS_22_2_3_TombstonePropagation | core/test/pds_test.go |
| 1094 | TAGGED | TST-CORE-723 | PENDING | TestPDS_22_2_4_DeletedRecordAbsentFromQueries | core/test/pds_test.go |
| 1095 | TAGGED | TST-CORE-918 | PENDING | TestPDS_22_2_5_BotLexiconValidation | core/test/pds_test.go |
| 1096 | TAGGED | TST-CORE-919 | PENDING | TestPDS_22_2_6_OutcomeDataSchemaValidation | core/test/pds_test.go |
| 1097 | TAGGED | TST-CORE-920 | PENDING | TestPDS_22_2_7_AttestationOptionalFieldsURIFormat | core/test/pds_test.go |
| 1098 | TAGGED | TST-CORE-921 | PENDING | TestPDS_22_2_8_TrustQueryResponseIncludesSignedPayloads | core/test/pds_test.go |
| 1099 | TAGGED | TST-CORE-922 | PENDING | TestPDS_22_2_9_DIDDocContainsDIDCommServiceEndpoint | core/test/pds_test.go |
| 1100 | TAGGED | TST-CORE-923 | PENDING | TestPDS_22_2_10_OutcomeRecordSigning | core/test/pds_test.go |
| 1101 | TAGGED | TST-CORE-924 | PENDING | TestPDS_22_2_11_TypeA_FallbackToExternalHTTPS | core/test/pds_test.go |
| 1102 | PENDING | -- | PENDING | TestPendingReason_SQLite_SecondApprovalExtendsExpiry | core/test/pending_reason_test.go |
| 1103 | PENDING | -- | PENDING | TestPendingReason_SQLite_CallerBinding | core/test/pending_reason_test.go |
| 1104 | PENDING | -- | PENDING | TestPendingReason_SQLite_NotFoundReturnsNil | core/test/pending_reason_test.go |
| 1105 | PENDING | -- | PENDING | TestPendingReason_SQLite_CompleteLifecycle | core/test/pending_reason_test.go |
| 1106 | PENDING | -- | PENDING | TestPendingReason_SQLite_DeniedStatus | core/test/pending_reason_test.go |
| 1107 | PENDING | -- | PENDING | TestPendingReason_SQLite_GetByApprovalIDFiltersNonPending | core/test/pending_reason_test.go |
| 1108 | PENDING | -- | PENDING | TestPendingReason_SQLite_SweepExpiresPendingEntries | core/test/pending_reason_test.go |
| 1109 | PENDING | -- | PENDING | TestPendingReason_SQLite_SweepDeletesOldCompletedEntries | core/test/pending_reason_test.go |
| 1110 | PENDING | -- | PENDING | TestPendingReason_SQLite_SweepSkipsResumingEntries | core/test/pending_reason_test.go |
| 1111 | PENDING | -- | PENDING | TestPendingReason_CreateAndGetByID | core/test/pending_reason_test.go |
| 1112 | PENDING | -- | PENDING | TestPendingReason_CallerBinding | core/test/pending_reason_test.go |
| 1113 | PENDING | -- | PENDING | TestPendingReason_GetByApprovalID | core/test/pending_reason_test.go |
| 1114 | PENDING | -- | PENDING | TestPendingReason_SecondApprovalCycle | core/test/pending_reason_test.go |
| 1115 | PENDING | -- | PENDING | TestPendingReason_DeniedStatus | core/test/pending_reason_test.go |
| 1116 | PENDING | -- | PENDING | TestPendingReason_CompleteWithResult | core/test/pending_reason_test.go |
| 1117 | TAGGED | TST-CORE-900 | PENDING | TestPIIHandler_Tier1Only_BrainNil | core/test/pii_handler_test.go |
| 1118 | TAGGED | TST-CORE-901 | PENDING | TestPIIHandler_Tier1PlusTier2 | core/test/pii_handler_test.go |
| 1119 | TAGGED | TST-CORE-902 | PENDING | TestPIIHandler_Tier2Failure_GracefulDegradation | core/test/pii_handler_test.go |
| 1120 | TAGGED | TST-CORE-903 | PENDING | TestPIIHandler_EntityDeduplication | core/test/pii_handler_test.go |
| 1121 | TAGGED | TST-CORE-343 | PENDING | TestPII_5_1_EmailDetection | core/test/pii_test.go |
| 1122 | TAGGED | TST-CORE-344 | PENDING | TestPII_5_2_PhoneDetection | core/test/pii_test.go |
| 1123 | TAGGED | TST-CORE-345 | PENDING | TestPII_5_3_SSNDetection | core/test/pii_test.go |
| 1124 | TAGGED | TST-CORE-346 | PENDING | TestPII_5_4_CreditCardDetection | core/test/pii_test.go |
| 1125 | TAGGED | TST-CORE-355 | PENDING | TestPII_5_5_MultipleEmails | core/test/pii_test.go |
| 1126 | TAGGED | TST-CORE-348 | PENDING | TestPII_5_6_NoPII | core/test/pii_test.go |
| 1127 | TAGGED | TST-CORE-349 | PENDING | TestPII_5_7_MixedPII | core/test/pii_test.go |
| 1128 | TAGGED | TST-CORE-776 | PENDING | TestPII_5_8_AddressDetection | core/test/pii_test.go |
| 1129 | TAGGED | TST-CORE-777 | PENDING | TestPII_5_9_TableDriven | core/test/pii_test.go |
| 1130 | TAGGED | TST-CORE-352 | PENDING | TestPII_5_10_LatencyUnder1ms | core/test/pii_test.go |
| 1131 | TAGGED | TST-CORE-353 | PENDING | TestPII_5_11_AddCustomPattern | core/test/pii_test.go |
| 1132 | TAGGED | TST-CORE-778 | PENDING | TestPII_5_12_EmptyInput | core/test/pii_test.go |
| 1133 | TAGGED | TST-CORE-355 | PENDING | TestPII_5_13_NumberedTokensUnique | core/test/pii_test.go |
| 1134 | TAGGED | TST-CORE-359 | PENDING | TestPII_5_14_IndianPhoneNumber | core/test/pii_test.go |
| 1135 | TAGGED | TST-CORE-779 | PENDING | TestPII_5_15_EmailInURL | core/test/pii_test.go |
| 1136 | TAGGED | TST-CORE-780 | PENDING | TestPII_5_16_ConsecutivePIISameType | core/test/pii_test.go |
| 1137 | TAGGED | TST-CORE-781 | PENDING | TestPII_5_17_SQLInjectionInInput | core/test/pii_test.go |
| 1138 | TAGGED | TST-CORE-782 | PENDING | TestPII_5_18_UnicodeTextSafe | core/test/pii_test.go |
| 1139 | TAGGED | TST-CORE-347 | PENDING | TestPII_5_19_IPAddressDetection | core/test/pii_test.go |
| 1140 | TAGGED | TST-CORE-350 | PENDING | TestPII_5_20_PIIAtStringBoundaries | core/test/pii_test.go |
| 1141 | TAGGED | TST-CORE-351 | PENDING | TestPII_5_21_UnicodeInternationalFormats | core/test/pii_test.go |
| 1142 | TAGGED | TST-CORE-354 | PENDING | TestPII_5_22_BankAccountNumber | core/test/pii_test.go |
| 1143 | TAGGED | TST-CORE-356 | PENDING | TestPII_5_23_ReplacementMapReturned | core/test/pii_test.go |
| 1144 | TAGGED | TST-CORE-357 | PENDING | TestPII_5_24_ReplacementMapRoundTrip | core/test/pii_test.go |
| 1145 | TAGGED | TST-CORE-358 | PENDING | TestPII_5_16_NoFalsePositivesOnNumbers | core/test/pii_test.go |
| 1146 | TAGGED | TST-CORE-886 | PENDING | TestPII_5_26_DeSanitizeEndpoint_RestoresTokensFromMap | core/test/pii_test.go |
| 1147 | TAGGED | TST-CORE-887 | PENDING | TestPII_5_27_ScrubEndpoint_NoOutboundNetworkCalls | core/test/pii_test.go |
| 1148 | TAGGED | TST-CORE-888 | PENDING | TestPII_5_28_SensitivePersona_MandatoryPIIScrubBeforeCloudLLM | core/test/pii_test.go |
| 1149 | TAGGED | TST-CORE-724 | PENDING | TestPortability_23_1_1_ExportProducesEncryptedArchive | core/test/portability_test.go |
| 1150 | TAGGED | TST-CORE-725 | PENDING | TestPortability_23_1_2_WALCheckpointBeforeExport | core/test/portability_test.go |
| 1151 | TAGGED | TST-CORE-726 | PENDING | TestPortability_23_1_3_ArchiveContainsCorrectFiles | core/test/portability_test.go |
| 1152 | TAGGED | TST-CORE-727 | PENDING | TestPortability_23_1_4_ManifestContents | core/test/portability_test.go |
| 1153 | TAGGED | TST-CORE-728 | PENDING | TestPortability_23_1_5_ExportExcludesBrainToken | core/test/portability_test.go |
| 1154 | TAGGED | TST-CORE-729 | PENDING | TestPortability_23_1_6_ExportExcludesClientTokenHashes | core/test/portability_test.go |
| 1155 | TAGGED | TST-CORE-730 | PENDING | TestPortability_23_1_7_ExportExcludesPassphrase | core/test/portability_test.go |
| 1156 | TAGGED | TST-CORE-731 | PENDING | TestPortability_23_1_8_ExportExcludesPDSData | core/test/portability_test.go |
| 1157 | TAGGED | TST-CORE-732 | PENDING | TestPortability_23_1_9_ExportExcludesDockerSecrets | core/test/portability_test.go |
| 1158 | TAGGED | TST-CORE-733 | PENDING | TestPortability_23_1_10_ExportWhileVaultLocked | core/test/portability_test.go |
| 1159 | TAGGED | TST-CORE-734 | PENDING | TestPortability_23_1_11_DatabaseWritesResumedAfterExport | core/test/portability_test.go |
| 1160 | TAGGED | TST-CORE-735 | PENDING | TestPortability_23_2_1_ImportPromptsForPassphrase | core/test/portability_test.go |
| 1161 | TAGGED | TST-CORE-736 | PENDING | TestPortability_23_2_2_ImportWithWrongPassphrase | core/test/portability_test.go |
| 1162 | TAGGED | TST-CORE-737 | PENDING | TestPortability_23_2_3_ImportVerifiesChecksums | core/test/portability_test.go |
| 1163 | TAGGED | TST-CORE-738 | PENDING | TestPortability_23_2_4_ImportDetectsCorruption | core/test/portability_test.go |
| 1164 | TAGGED | TST-CORE-739 | PENDING | TestPortability_23_2_5_ImportChecksVersionCompatibility | core/test/portability_test.go |
| 1165 | TAGGED | TST-CORE-740 | PENDING | TestPortability_23_2_6_ImportRunsIntegrityCheck | core/test/portability_test.go |
| 1166 | TAGGED | TST-CORE-741 | PENDING | TestPortability_23_2_7_ImportIntegrityCheckFailure | core/test/portability_test.go |
| 1167 | TAGGED | TST-CORE-742 | PENDING | TestPortability_23_2_8_ImportPromptsForRepairing | core/test/portability_test.go |
| 1168 | TAGGED | TST-CORE-743 | PENDING | TestPortability_23_2_9_ImportedDIDMatchesOriginal | core/test/portability_test.go |
| 1169 | TAGGED | TST-CORE-744 | PENDING | TestPortability_23_2_10_ImportOnFreshInstance | core/test/portability_test.go |
| 1170 | TAGGED | TST-CORE-745 | PENDING | TestPortability_23_2_11_ImportOnExistingDataRejected | core/test/portability_test.go |
| 1171 | TAGGED | TST-CORE-746 | PENDING | TestPortability_23_2_12_ImportRejectsTamperedArchive | core/test/portability_test.go |
| 1172 | TAGGED | TST-CORE-747 | PENDING | TestPortability_23_3_1_ManagedToSelfHostedVPS | core/test/portability_test.go |
| 1173 | TAGGED | TST-CORE-748 | PENDING | TestPortability_23_3_2_RaspberryPiToMacMini | core/test/portability_test.go |
| 1174 | TAGGED | TST-CORE-749 | PENDING | TestPortability_23_3_3_SameDockerImageAcrossHostingLevels | core/test/portability_test.go |
| 1175 | TAGGED | TST-CORE-750 | PENDING | TestPortability_23_3_4_MigrationPreservesVaultSearch | core/test/portability_test.go |
| 1176 | TAGGED | TST-CORE-925 | PENDING | TestPortability_23_3_5_ImportInvalidatesAllDeviceTokens | core/test/portability_test.go |
| 1177 | TAGGED | TST-CORE-545 | PENDING | TestRateLimit_13_1_BelowLimit | core/test/ratelimit_test.go |
| 1178 | TAGGED | TST-CORE-546 | PENDING | TestRateLimit_13_2_AtLimit | core/test/ratelimit_test.go |
| 1179 | TAGGED | TST-CORE-547 | PENDING | TestRateLimit_13_3_AboveLimit | core/test/ratelimit_test.go |
| 1180 | TAGGED | TST-CORE-548 | PENDING | TestRateLimit_13_4_Reset | core/test/ratelimit_test.go |
| 1181 | TAGGED | TST-CORE-549 | PENDING | TestRateLimit_13_5_PerIPIsolation | core/test/ratelimit_test.go |
| 1182 | TAGGED | TST-CORE-550 | PENDING | TestRateLimit_13_6_RateLimitHeaders | core/test/ratelimit_test.go |
| 1183 | PENDING | -- | PENDING | TestRateLimit_34_2_5_ConcurrentRateLimitBypass | core/test/ratelimit_test.go |
| 1184 | PENDING | -- | PENDING | TestRateLimit_34_2_5_ConcurrentRateLimitBypass/concurrent_requests_enforce_limit_no_excess_allowed | core/test/ratelimit_test.go |
| 1185 | PENDING | -- | PENDING | TestRateLimit_34_2_5_ConcurrentRateLimitBypass/per_IP_isolation_under_concurrent_load | core/test/ratelimit_test.go |
| 1186 | PENDING | -- | PENDING | TestRateLimit_34_2_5_ConcurrentRateLimitBypass/no_panics_under_heavy_concurrent_access | core/test/ratelimit_test.go |
| 1187 | PENDING | -- | PENDING | TestRateLimit_34_2_5_ConcurrentRateLimitBypass/after_window_reset_quota_restored_under_concurrency | core/test/ratelimit_test.go |
| 1188 | PENDING | -- | PENDING | TestRateLimit_34_2_5_ConcurrentRateLimitBypass/positive_control_sequential_requests_work | core/test/ratelimit_test.go |
| 1189 | TAGGED | TST-CORE-611 | PENDING | TestSecurity_17_1_NoVacuumInto | core/test/security_test.go |
| 1190 | TAGGED | TST-CORE-612 | PENDING | TestSecurity_17_2_SQLInjectionResistance | core/test/security_test.go |
| 1191 | TAGGED | TST-CORE-613 | PENDING | TestSecurity_17_3_PathTraversal | core/test/security_test.go |
| 1192 | TAGGED | TST-CORE-614 | PENDING | TestSecurity_17_4_HeaderInjection | core/test/security_test.go |
| 1193 | TAGGED | TST-CORE-615 | PENDING | TestSecurity_17_5_MemoryZeroization | core/test/security_test.go |
| 1194 | TAGGED | TST-CORE-616 | PENDING | TestSecurity_17_6_TLSEnforcement | core/test/security_test.go |
| 1195 | TAGGED | TST-CORE-617 | PENDING | TestSecurity_17_7_DockerNetworkIsolation | core/test/security_test.go |
| 1196 | TAGGED | TST-CORE-618 | PENDING | TestSecurity_17_8_SecretsNotInEnvironment | core/test/security_test.go |
| 1197 | TAGGED | TST-CORE-619 | PENDING | TestSecurity_17_9_NoPlaintextKeysOnDisk | core/test/security_test.go |
| 1198 | TAGGED | TST-CORE-620 | PENDING | TestSecurity_17_10_ConstantTimeComparisons | core/test/security_test.go |
| 1199 | TAGGED | TST-CORE-621 | PENDING | TestSecurity_17_11_NoPluginLoading | core/test/security_test.go |
| 1200 | TAGGED | TST-CORE-622 | PENDING | TestSecurity_17_12_NoPluginAPIEndpoint | core/test/security_test.go |
| 1201 | TAGGED | TST-CORE-623 | PENDING | TestSecurity_17_13_OnlyTwoExtensionPoints | core/test/security_test.go |
| 1202 | TAGGED | TST-CORE-624 | PENDING | TestSecurity_17_14_NoPlaintextVaultDataOnDisk | core/test/security_test.go |
| 1203 | TAGGED | TST-CORE-625 | PENDING | TestSecurity_17_15_PlaintextDiscardedAfterProcessing | core/test/security_test.go |
| 1204 | TAGGED | TST-CORE-626 | PENDING | TestSecurity_17_16_KeysInRAMOnlyWhileNeeded | core/test/security_test.go |
| 1205 | TAGGED | TST-CORE-627 | PENDING | TestSecurity_17_17_SQLCipherLibrary | core/test/security_test.go |
| 1206 | TAGGED | TST-CORE-628 | PENDING | TestSecurity_17_18_RawSQLiteNotValid | core/test/security_test.go |
| 1207 | TAGGED | TST-CORE-629 | PENDING | TestSecurity_17_19_JSONSerialization | core/test/security_test.go |
| 1208 | TAGGED | TST-CORE-630 | PENDING | TestSecurity_17_20_DigestPinning | core/test/security_test.go |
| 1209 | TAGGED | TST-CORE-631 | PENDING | TestSecurity_17_21_CosignSignature | core/test/security_test.go |
| 1210 | TAGGED | TST-CORE-632 | PENDING | TestSecurity_17_22_SBOMGenerated | core/test/security_test.go |
| 1211 | TAGGED | TST-CORE-633 | PENDING | TestSecurity_17_23_SecretsNeverInEnvVars | core/test/security_test.go |
| 1212 | TAGGED | TST-CORE-634 | PENDING | TestSecurity_17_24_SecretsTmpfsMount | core/test/security_test.go |
| 1213 | TAGGED | TST-CORE-635 | PENDING | TestSecurity_17_25_GoogleAPIKeyException | core/test/security_test.go |
| 1214 | TAGGED | TST-CORE-636 | PENDING | TestSecurity_17_26_PdsNetOutbound | core/test/security_test.go |
| 1215 | TAGGED | TST-CORE-637 | PENDING | TestSecurity_17_27_BrainNetStandard | core/test/security_test.go |
| 1216 | TAGGED | TST-CORE-638 | PENDING | TestSecurity_17_28_ExternalPortsOnly | core/test/security_test.go |
| 1217 | TAGGED | TST-CORE-903 | PENDING | TestSecurity_17_29_NoGoPluginImport | core/test/security_test.go |
| 1218 | TAGGED | TST-CORE-904 | PENDING | TestSecurity_17_30_NoExternalOAuthTokenStorage | core/test/security_test.go |
| 1219 | TAGGED | TST-CORE-905 | PENDING | TestSecurity_17_31_NoVectorClocksNoCRDTs | core/test/security_test.go |
| 1220 | TAGGED | TST-CORE-065 | PENDING | TestSecurity_2_1_RootIdentityNeverTransmittedInPlaintext | core/test/security_test.go |
| 1221 | PENDING | -- | PENDING | TestSecurity_2_1_RootIdentityNeverTransmittedInPlaintext/handler_source_never_returns_seed_or_mnemonic | core/test/security_test.go |
| 1222 | PENDING | -- | PENDING | TestSecurity_2_1_RootIdentityNeverTransmittedInPlaintext/adapter_source_never_logs_seed_or_dek | core/test/security_test.go |
| 1223 | PENDING | -- | PENDING | TestSecurity_2_1_RootIdentityNeverTransmittedInPlaintext/did_endpoint_returns_only_public_data | core/test/security_test.go |
| 1224 | PENDING | -- | PENDING | TestSecurity_2_1_RootIdentityNeverTransmittedInPlaintext/export_bundle_contains_no_plaintext_seed | core/test/security_test.go |
| 1225 | PENDING | -- | PENDING | TestSecurity_2_1_RootIdentityNeverTransmittedInPlaintext/onboarding_never_stores_mnemonic_in_core | core/test/security_test.go |
| 1226 | TAGGED | TST-CORE-557 | PENDING | TestServer_15_1_1_LivenessProbe | core/test/server_test.go |
| 1227 | TAGGED | TST-CORE-558 | PENDING | TestServer_15_1_2_ReadinessProbeVaultHealthy | core/test/server_test.go |
| 1228 | TAGGED | TST-CORE-559 | PENDING | TestServer_15_1_3_ReadinessProbeVaultLocked | core/test/server_test.go |
| 1229 | TAGGED | TST-CORE-560 | PENDING | TestServer_15_1_4_ReadinessProbeSQLiteLocked | core/test/server_test.go |
| 1230 | TAGGED | TST-CORE-561 | PENDING | TestServer_15_1_5_LivenessNotEqualReadiness | core/test/server_test.go |
| 1231 | TAGGED | TST-CORE-562 | PENDING | TestServer_15_1_6_DockerHealthcheckUsesHealthz | core/test/server_test.go |
| 1232 | TAGGED | TST-CORE-563 | PENDING | TestServer_15_1_7_DockerHealthcheckParams | core/test/server_test.go |
| 1233 | TAGGED | TST-CORE-564 | PENDING | TestServer_15_1_8_BrainStartsAfterCoreHealthy | core/test/server_test.go |
| 1234 | TAGGED | TST-CORE-565 | PENDING | TestServer_15_2_1_SearchVault | core/test/server_test.go |
| 1235 | TAGGED | TST-CORE-566 | PENDING | TestServer_15_2_2_StoreItem | core/test/server_test.go |
| 1236 | TAGGED | TST-CORE-567 | PENDING | TestServer_15_2_3_GetItemByID | core/test/server_test.go |
| 1237 | TAGGED | TST-CORE-568 | PENDING | TestServer_15_2_4_DeleteItem | core/test/server_test.go |
| 1238 | TAGGED | TST-CORE-569 | PENDING | TestServer_15_2_5_StoreCrashTraceback | core/test/server_test.go |
| 1239 | TAGGED | TST-CORE-570 | PENDING | TestServer_15_2_6_ACKTask | core/test/server_test.go |
| 1240 | TAGGED | TST-CORE-571 | PENDING | TestServer_15_2_7_VaultKVStore | core/test/server_test.go |
| 1241 | TAGGED | TST-CORE-572 | PENDING | TestServer_15_2_8_VaultKVRead | core/test/server_test.go |
| 1242 | TAGGED | TST-CORE-573 | PENDING | TestServer_15_2_9_VaultKVUpsert | core/test/server_test.go |
| 1243 | TAGGED | TST-CORE-574 | PENDING | TestServer_15_2_10_VaultKVNotFound | core/test/server_test.go |
| 1244 | TAGGED | TST-CORE-575 | PENDING | TestServer_15_2_11_VaultBatchStore | core/test/server_test.go |
| 1245 | TAGGED | TST-CORE-576 | PENDING | TestServer_15_2_12_VaultBatchStoreExceedsCap | core/test/server_test.go |
| 1246 | TAGGED | TST-CORE-577 | PENDING | TestServer_15_3_1_GetOwnDID | core/test/server_test.go |
| 1247 | TAGGED | TST-CORE-578 | PENDING | TestServer_15_3_2_CreatePersona | core/test/server_test.go |
| 1248 | TAGGED | TST-CORE-579 | PENDING | TestServer_15_3_3_ListPersonas | core/test/server_test.go |
| 1249 | TAGGED | TST-CORE-580 | PENDING | TestServer_15_3_4_GetContacts | core/test/server_test.go |
| 1250 | TAGGED | TST-CORE-581 | PENDING | TestServer_15_3_5_AddContact | core/test/server_test.go |
| 1251 | TAGGED | TST-CORE-582 | PENDING | TestServer_15_3_6_RegisterDevice | core/test/server_test.go |
| 1252 | TAGGED | TST-CORE-583 | PENDING | TestServer_15_3_7_ListDevices | core/test/server_test.go |
| 1253 | TAGGED | TST-CORE-584 | PENDING | TestServer_15_4_1_SendMessage | core/test/server_test.go |
| 1254 | TAGGED | TST-CORE-585 | PENDING | TestServer_15_4_2_ReceiveMessages | core/test/server_test.go |
| 1255 | TAGGED | TST-CORE-586 | PENDING | TestServer_15_4_3_AcknowledgeMessage | core/test/server_test.go |
| 1256 | TAGGED | TST-CORE-587 | PENDING | TestServer_15_5_1_InitiatePairing | core/test/server_test.go |
| 1257 | TAGGED | TST-CORE-588 | PENDING | TestServer_15_5_2_InitiateStoresPendingPairing | core/test/server_test.go |
| 1258 | TAGGED | TST-CORE-589 | PENDING | TestServer_15_5_3_CompletePairing | core/test/server_test.go |
| 1259 | TAGGED | TST-CORE-590 | PENDING | TestServer_15_5_4_ClientTokenIs32BytesHex | core/test/server_test.go |
| 1260 | TAGGED | TST-CORE-591 | PENDING | TestServer_15_5_5_SHA256HashStoredNotToken | core/test/server_test.go |
| 1261 | TAGGED | TST-CORE-592 | PENDING | TestServer_15_5_6_PendingPairingDeletedAfterComplete | core/test/server_test.go |
| 1262 | TAGGED | TST-CORE-593 | PENDING | TestServer_15_5_7_DeviceNameStored | core/test/server_test.go |
| 1263 | TAGGED | TST-CORE-594 | PENDING | TestServer_15_5_8_ManagedHostingNoTerminal | core/test/server_test.go |
| 1264 | TAGGED | TST-CORE-595 | PENDING | TestServer_15_6_1_ATProtoDiscoveryEndpoint | core/test/server_test.go |
| 1265 | TAGGED | TST-CORE-596 | PENDING | TestServer_15_6_2_DiscoveryReturnsRootDID | core/test/server_test.go |
| 1266 | TAGGED | TST-CORE-597 | PENDING | TestServer_15_6_3_DiscoveryUnauthenticated | core/test/server_test.go |
| 1267 | TAGGED | TST-CORE-598 | PENDING | TestServer_15_6_4_DiscoveryAvailableInDevMode | core/test/server_test.go |
| 1268 | TAGGED | TST-CORE-599 | PENDING | TestServer_15_6_5_MissingDIDNoIdentityYet | core/test/server_test.go |
| 1269 | TAGGED | TST-CORE-600 | PENDING | TestServer_15_7_1_ScrubText | core/test/server_test.go |
| 1270 | TAGGED | TST-CORE-901 | PENDING | TestServer_15_7_2_MetricsEndpointExists | core/test/server_test.go |
| 1271 | TAGGED | TST-CORE-902 | PENDING | TestServer_15_7_3_SyncStatusEndpoint | core/test/server_test.go |
| 1272 | TAGGED | TST-CORE-920 | PENDING | TestSession_EmptyNameAutoGenerated | core/test/session_handler_test.go |
| 1273 | TAGGED | TST-CORE-921 | PENDING | TestSession_ExplicitNameUsedAsIs | core/test/session_handler_test.go |
| 1274 | PENDING | -- | PENDING | TestSignature_28_ValidSignature_Accepted | core/test/signature_test.go |
| 1275 | PENDING | -- | PENDING | TestSignature_28_ValidSignature_EmptyBody | core/test/signature_test.go |
| 1276 | PENDING | -- | PENDING | TestSignature_28_InvalidSignature_Rejected | core/test/signature_test.go |
| 1277 | PENDING | -- | PENDING | TestSignature_28_WrongKey_Rejected | core/test/signature_test.go |
| 1278 | PENDING | -- | PENDING | TestSignature_28_TamperedBody_Rejected | core/test/signature_test.go |
| 1279 | PENDING | -- | PENDING | TestSignature_28_TamperedPath_Rejected | core/test/signature_test.go |
| 1280 | PENDING | -- | PENDING | TestSignature_28_TamperedMethod_Rejected | core/test/signature_test.go |
| 1281 | TAGGED | TST-CORE-1223 | PENDING | TestSignature_28_ExpiredTimestamp_Rejected | core/test/signature_test.go |
| 1282 | TAGGED | TST-CORE-1224 | PENDING | TestSignature_28_FutureTimestamp_Rejected | core/test/signature_test.go |
| 1283 | PENDING | -- | PENDING | TestSignature_28_WithinWindow_Accepted | core/test/signature_test.go |
| 1284 | TAGGED | TST-CORE-1225 | PENDING | TestSignature_28_InvalidTimestampFormat_Rejected | core/test/signature_test.go |
| 1285 | PENDING | -- | PENDING | TestSignature_28_UnknownDID_Rejected | core/test/signature_test.go |
| 1286 | PENDING | -- | PENDING | TestSignature_28_RevokedDevice_Rejected | core/test/signature_test.go |
| 1287 | PENDING | -- | PENDING | TestSignature_28_MalformedSignatureHex_Rejected | core/test/signature_test.go |
| 1288 | PENDING | -- | PENDING | TestPairing_28_CompletePairingWithKey_Success | core/test/signature_test.go |
| 1289 | PENDING | -- | PENDING | TestPairing_28_CompletePairingWithKey_InvalidCode | core/test/signature_test.go |
| 1290 | PENDING | -- | PENDING | TestPairing_28_CompletePairingWithKey_InvalidMultibase | core/test/signature_test.go |
| 1291 | PENDING | -- | PENDING | TestPairing_28_CompletePairingWithKey_CodeAlreadyUsed | core/test/signature_test.go |
| 1292 | PENDING | -- | PENDING | TestPairing_28_CompletePairingWithKey_DeviceAppearsInList | core/test/signature_test.go |
| 1293 | PENDING | -- | PENDING | TestSignature_28_MockValidator_FallsBackToBearerToken | core/test/signature_test.go |
| 1294 | TAGGED | TST-CORE-1129 | PENDING | TestSignature_34_2_8_AgentRevocationTakesImmediateEffect | core/test/signature_test.go |
| 1295 | PENDING | -- | PENDING | TestSignature_34_2_8_AgentRevocationTakesImmediateEffect/valid_before_revocation_rejected_after | core/test/signature_test.go |
| 1296 | PENDING | -- | PENDING | TestSignature_34_2_8_AgentRevocationTakesImmediateEffect/revocation_does_not_affect_other_agents | core/test/signature_test.go |
| 1297 | PENDING | -- | PENDING | TestSignature_34_2_8_AgentRevocationTakesImmediateEffect/revocation_is_immediate_no_cache_delay | core/test/signature_test.go |
| 1298 | PENDING | -- | PENDING | TestSignature_34_2_8_AgentRevocationTakesImmediateEffect/multiple_endpoints_all_rejected_after_revocation | core/test/signature_test.go |
| 1299 | PENDING | -- | PENDING | TestSourceTrust_StoreWithProvenance | core/test/source_trust_test.go |
| 1300 | PENDING | -- | PENDING | TestSourceTrust_StoreWithoutProvenance | core/test/source_trust_test.go |
| 1301 | PENDING | -- | PENDING | TestSourceTrust_DefaultQueryExcludesQuarantineAndBriefing | core/test/source_trust_test.go |
| 1302 | PENDING | -- | PENDING | TestSourceTrust_IncludeAllReturnsEverything | core/test/source_trust_test.go |
| 1303 | PENDING | -- | PENDING | TestSourceTrust_QueryFiltersByPolicy | core/test/source_trust_test.go |
| 1304 | PENDING | -- | PENDING | TestSourceTrust_FTS5RespectsPolicy | core/test/source_trust_test.go |
| 1305 | PENDING | -- | PENDING | TestSourceTrust_ContradictionStored | core/test/source_trust_test.go |
| 1306 | PENDING | -- | PENDING | TestSourceTrust_ValidationRejectsInvalid | core/test/source_trust_test.go |
| 1307 | PENDING | -- | PENDING | TestSourceTrust_BatchStoreWithProvenance | core/test/source_trust_test.go |
| 1308 | PENDING | -- | PENDING | TestSourceTrust_EmptyPolicyDefaultsToNormal | core/test/source_trust_test.go |
| 1309 | PENDING | -- | PENDING | TestSourceTrust_LegacyItemsVisible | core/test/source_trust_test.go |
| 1310 | PENDING | -- | PENDING | TestSourceTrust_CaveatedIncludedInDefaultSearch | core/test/source_trust_test.go |
| 1311 | TAGGED | TST-CORE-1200 | PENDING | TestStagingInbox_Ingest | core/test/staging_inbox_test.go |
| 1312 | TAGGED | TST-CORE-1201 | PENDING | TestStagingInbox_DedupOnConnectorSourceID | core/test/staging_inbox_test.go |
| 1313 | TAGGED | TST-CORE-1202 | PENDING | TestStagingInbox_Claim | core/test/staging_inbox_test.go |
| 1314 | TAGGED | TST-CORE-1203 | PENDING | TestStagingInbox_ClaimSetsLease | core/test/staging_inbox_test.go |
| 1315 | TAGGED | TST-CORE-1204 | PENDING | TestStagingInbox_ExpiredLeaseReverts | core/test/staging_inbox_test.go |
| 1316 | TAGGED | TST-CORE-1205 | PENDING | TestStagingInbox_ResolveOpenPersona | core/test/staging_inbox_test.go |
| 1317 | TAGGED | TST-CORE-1206 | PENDING | TestStagingInbox_ResolveLockedPersona | core/test/staging_inbox_test.go |
| 1318 | TAGGED | TST-CORE-1207 | PENDING | TestStagingInbox_DrainPending | core/test/staging_inbox_test.go |
| 1319 | TAGGED | TST-CORE-1208 | PENDING | TestStagingInbox_MarkFailed | core/test/staging_inbox_test.go |
| 1320 | TAGGED | TST-CORE-1209 | PENDING | TestStagingInbox_SweepExpired | core/test/staging_inbox_test.go |
| 1321 | TAGGED | TST-CORE-1210 | PENDING | TestStagingInbox_ListByStatus | core/test/staging_inbox_test.go |
| 1322 | TAGGED | TST-CORE-1211 | PENDING | TestStagingInbox_LineageInResolve | core/test/staging_inbox_test.go |
| 1323 | TAGGED | TST-CORE-1212 | PENDING | TestStagingInbox_ConcurrentClaim | core/test/staging_inbox_test.go |
| 1324 | TAGGED | TST-CORE-1213 | PENDING | TestStagingInbox_ConnectorAuthz | core/test/staging_inbox_test.go |
| 1325 | TAGGED | TST-CORE-1214 | PENDING | TestStagingInbox_Phase4_DeviceVaultStoreLockdown | core/test/staging_inbox_test.go |
| 1326 | TAGGED | TST-CORE-1215 | PENDING | TestStagingInbox_Phase4_BrainVaultStoreAllowed | core/test/staging_inbox_test.go |
| 1327 | TAGGED | TST-CORE-1216 | PENDING | TestStagingInbox_Phase4_AdminVaultStoreAllowed | core/test/staging_inbox_test.go |
| 1328 | TAGGED | TST-CORE-1217 | PENDING | TestCXH1_DeviceCannotSelfApprove | core/test/staging_inbox_test.go |
| 1329 | TAGGED | TST-CORE-1218 | PENDING | TestCXH1_ApprovalHandlerRejectsMalformedJSON | core/test/staging_inbox_test.go |
| 1330 | TAGGED | TST-CORE-1219 | PENDING | TestCXH1_ApprovalHandlerBlocksDeviceCaller | core/test/staging_inbox_test.go |
| 1331 | PENDING | -- | PENDING | TestFH1_DeviceCannotAppendAudit | core/test/staging_inbox_test.go |
| 1332 | PENDING | -- | PENDING | TestCXH3_DeviceCannotPushNotifications | core/test/staging_inbox_test.go |
| 1333 | PENDING | -- | PENDING | TestFH3_BrainCannotCreatePersonas | core/test/staging_inbox_test.go |
| 1334 | PENDING | -- | PENDING | TestCXH6_SyncStatusRequiresAuth | core/test/staging_inbox_test.go |
| 1335 | PENDING | -- | PENDING | TestCXH6_SyncStatusNoProxyURL | core/test/staging_inbox_test.go |
| 1336 | TAGGED | TST-CORE-1220 | PENDING | TestVT3_EmbeddingRejectsNaNInf | core/test/staging_inbox_test.go |
| 1337 | TAGGED | TST-CORE-1221 | PENDING | TestVT6_ExtendLeaseAdditive | core/test/staging_inbox_test.go |
| 1338 | TAGGED | TST-CORE-1222 | PENDING | TestGetStatusDetailed_StoredItemReturnsPersona | core/test/staging_inbox_test.go |
| 1339 | TAGGED | TST-CORE-1223 | PENDING | TestGetStatusDetailed_ReceivedItemHasEmptyPersona | core/test/staging_inbox_test.go |
| 1340 | TAGGED | TST-CORE-1224 | PENDING | TestGetStatusDetailed_UnknownIDReturnsError | core/test/staging_inbox_test.go |
| 1341 | TAGGED | TST-CORE-862 | PENDING | TestSync_26_1_ClientSendsCheckpoint_CoreReturnsChangedItems | core/test/sync_test.go |
| 1342 | TAGGED | TST-CORE-863 | PENDING | TestSync_26_2_NewVaultItem_PushedToConnectedClients | core/test/sync_test.go |
| 1343 | TAGGED | TST-CORE-864 | PENDING | TestSync_26_3_ConflictResolution_LastWriteWins | core/test/sync_test.go |
| 1344 | TAGGED | TST-CORE-865 | PENDING | TestSync_26_4_ThinClient_QueryViaWebSocket | core/test/sync_test.go |
| 1345 | TAGGED | TST-CORE-866 | PENDING | TestSync_26_5_BackupBlobStoreDestination | core/test/sync_test.go |
| 1346 | TAGGED | TST-CORE-867 | PENDING | TestSync_26_6_NewDeviceFullSync | core/test/sync_test.go |
| 1347 | TAGGED | TST-CORE-868 | PENDING | TestSync_26_7_OfflineQueueSyncsOnReconnect | core/test/sync_test.go |
| 1348 | TAGGED | TST-CORE-456 | PENDING | TestTaskQueue_8_1_1_EnqueueReturnsID | core/test/taskqueue_test.go |
| 1349 | TAGGED | TST-CORE-828 | PENDING | TestTaskQueue_8_1_2_DequeueTransitionsToRunning | core/test/taskqueue_test.go |
| 1350 | TAGGED | TST-CORE-829 | PENDING | TestTaskQueue_8_1_3_DequeueEmptyReturnsNil | core/test/taskqueue_test.go |
| 1351 | TAGGED | TST-CORE-830 | PENDING | TestTaskQueue_8_1_4_CompleteTask | core/test/taskqueue_test.go |
| 1352 | TAGGED | TST-CORE-831 | PENDING | TestTaskQueue_8_1_5_MockEnqueueDequeue | core/test/taskqueue_test.go |
| 1353 | TAGGED | TST-CORE-832 | PENDING | TestTaskQueue_8_2_1_HighPriorityFirst | core/test/taskqueue_test.go |
| 1354 | TAGGED | TST-CORE-833 | PENDING | TestTaskQueue_8_2_2_SamePriorityFIFO | core/test/taskqueue_test.go |
| 1355 | TAGGED | TST-CORE-834 | PENDING | TestTaskQueue_8_2_3_MockPriorityNotEnforced | core/test/taskqueue_test.go |
| 1356 | TAGGED | TST-CORE-835 | PENDING | TestTaskQueue_8_3_1_FailTask | core/test/taskqueue_test.go |
| 1357 | TAGGED | TST-CORE-836 | PENDING | TestTaskQueue_8_3_2_RetryIncrementsCounter | core/test/taskqueue_test.go |
| 1358 | TAGGED | TST-CORE-837 | PENDING | TestTaskQueue_8_3_3_RetryNonFailedTaskFails | core/test/taskqueue_test.go |
| 1359 | TAGGED | TST-CORE-838 | PENDING | TestTaskQueue_8_3_4_FailNonExistentTaskFails | core/test/taskqueue_test.go |
| 1360 | TAGGED | TST-CORE-839 | PENDING | TestTaskQueue_8_4_1_CrashRecoveryReEnqueuesRunningTasks | core/test/taskqueue_test.go |
| 1361 | TAGGED | TST-CORE-840 | PENDING | TestTaskQueue_8_4_2_RetryScheduleExponentialBackoff | core/test/taskqueue_test.go |
| 1362 | TAGGED | TST-CORE-841 | PENDING | TestTaskQueue_8_4_3_MaxRetriesExceededMarksDeadLetter | core/test/taskqueue_test.go |
| 1363 | TAGGED | TST-CORE-842 | PENDING | TestTaskQueue_8_4_4_PersistenceAcrossRestart | core/test/taskqueue_test.go |
| 1364 | TAGGED | TST-CORE-457 | PENDING | TestTaskQueue_8_1_6_TaskIDIsULID | core/test/taskqueue_test.go |
| 1365 | TAGGED | TST-CORE-458 | PENDING | TestTaskQueue_8_1_7_SendToBrainSetsProcessing | core/test/taskqueue_test.go |
| 1366 | TAGGED | TST-CORE-459 | PENDING | TestTaskQueue_8_1_8_BrainACKDeletesTask | core/test/taskqueue_test.go |
| 1367 | TAGGED | TST-CORE-461 | PENDING | TestTaskQueue_8_1_9_TaskTypes | core/test/taskqueue_test.go |
| 1368 | TAGGED | TST-CORE-463 | PENDING | TestTaskQueue_8_1_10_ConcurrentWorkers | core/test/taskqueue_test.go |
| 1369 | TAGGED | TST-CORE-464 | PENDING | TestTaskQueue_8_2_4_WatchdogDetectsTimedOutTask | core/test/taskqueue_test.go |
| 1370 | TAGGED | TST-CORE-465 | PENDING | TestTaskQueue_8_2_5_WatchdogRunsPeriodically | core/test/taskqueue_test.go |
| 1371 | TAGGED | TST-CORE-466 | PENDING | TestTaskQueue_8_2_6_WatchdogDoesNotTouchHealthyTasks | core/test/taskqueue_test.go |
| 1372 | TAGGED | TST-CORE-467 | PENDING | TestTaskQueue_8_2_7_ResetTaskReDispatched | core/test/taskqueue_test.go |
| 1373 | TAGGED | TST-CORE-468 | PENDING | TestTaskQueue_8_3_5_DeadLetterAfter3Failures | core/test/taskqueue_test.go |
| 1374 | TAGGED | TST-CORE-471 | PENDING | TestTaskQueue_8_3_6_TaskCancellation | core/test/taskqueue_test.go |
| 1375 | TAGGED | TST-CORE-472 | PENDING | TestTaskQueue_8_3_7_IndexOnStatusTimeout | core/test/taskqueue_test.go |
| 1376 | TAGGED | TST-CORE-473 | PENDING | TestTaskQueue_8_3_8_NoSilentDataLoss | core/test/taskqueue_test.go |
| 1377 | TAGGED | TST-CORE-474 | PENDING | TestTaskQueue_8_4_5_StoreReminder | core/test/taskqueue_test.go |
| 1378 | TAGGED | TST-CORE-475 | PENDING | TestTaskQueue_8_4_6_NextPendingReminder | core/test/taskqueue_test.go |
| 1379 | TAGGED | TST-CORE-476 | PENDING | TestTaskQueue_8_4_7_SleepUntilTriggerTime | core/test/taskqueue_test.go |
| 1380 | TAGGED | TST-CORE-477 | PENDING | TestTaskQueue_8_4_8_MissedReminderOnStartup | core/test/taskqueue_test.go |
| 1381 | TAGGED | TST-CORE-478 | PENDING | TestTaskQueue_8_4_9_FireAndMarkDone | core/test/taskqueue_test.go |
| 1382 | TAGGED | TST-CORE-479 | PENDING | TestTaskQueue_8_4_10_NoPendingSleepOneMinute | core/test/taskqueue_test.go |
| 1383 | TAGGED | TST-CORE-480 | PENDING | TestTaskQueue_8_4_11_NoCronLibrary | core/test/taskqueue_test.go |
| 1384 | TAGGED | TST-CORE-481 | PENDING | TestTaskQueue_8_4_12_ComplexSchedulingDelegated | core/test/taskqueue_test.go |
| 1385 | TAGGED | TST-CORE-460 | PENDING | TestTaskQueue_8_1_11_BrainNoACKCrash | core/test/taskqueue_test.go |
| 1386 | TAGGED | TST-CORE-462 | PENDING | TestTaskQueue_8_1_12_TaskPersistenceAcrossRestart | core/test/taskqueue_test.go |
| 1387 | TAGGED | TST-CORE-469 | PENDING | TestTaskQueue_8_3_9_DeadLetterNot5 | core/test/taskqueue_test.go |
| 1388 | TAGGED | TST-CORE-470 | PENDING | TestTaskQueue_8_3_10_RetryBackoff | core/test/taskqueue_test.go |
| 1389 | TAGGED | TST-CORE-933 | PENDING | TestTaskQueue_8_4_13_SilenceRules_StoredAndRetrievable | core/test/taskqueue_test.go |
| 1390 | TAGGED | TST-CORE-882 | PENDING | TestTaskQueue_8_5_1_DequeueClaimsOnlyOneTask | core/test/taskqueue_test.go |
| 1391 | TAGGED | TST-CORE-883 | PENDING | TestTaskQueue_8_5_2_AcknowledgeWithCorrectID | core/test/taskqueue_test.go |
| 1392 | TAGGED | TST-CORE-884 | PENDING | TestTaskQueue_8_5_3_AcknowledgeWithWrongID | core/test/taskqueue_test.go |
| 1393 | PENDING | -- | PENDING | TestTelegram_AccessPersona_SensitiveAutoApproved | core/test/telegram_access_test.go |
| 1394 | PENDING | -- | PENDING | TestTelegram_AccessPersona_NoUserOrigin_ExistingBehavior | core/test/telegram_access_test.go |
| 1395 | PENDING | -- | PENDING | TestTelegram_AccessPersona_NonBrainCallerIgnoresUserOrigin | core/test/telegram_access_test.go |
| 1396 | PENDING | -- | PENDING | TestTelegram_AccessPersona_LockedStillDenied | core/test/telegram_access_test.go |
| 1397 | PENDING | -- | PENDING | TestTelegram_AccessPersona_DefaultTierAlwaysAllowed | core/test/telegram_access_test.go |
| 1398 | PENDING | -- | PENDING | TestTelegram_AccessPersona_StandardTierBrainAllowed | core/test/telegram_access_test.go |
| 1399 | PENDING | -- | PENDING | TestTelegram_EnsureOpen_AutoUnlockCalled | core/test/telegram_access_test.go |
| 1400 | PENDING | -- | PENDING | TestTelegram_EnsureOpen_AlreadyOpen_NoAutoUnlock | core/test/telegram_access_test.go |
| 1401 | PENDING | -- | PENDING | TestTelegram_EnsureOpen_NonUserOriginated_AutoOpens | core/test/telegram_access_test.go |
| 1402 | PENDING | -- | PENDING | TestTelegram_EnsureOpen_Store_AutoUnlock | core/test/telegram_access_test.go |
| 1403 | PENDING | -- | PENDING | TestTelegram_EnsureOpen_Delete_AutoUnlock | core/test/telegram_access_test.go |
| 1404 | PENDING | -- | PENDING | TestTelegram_EnsureOpen_StoreBatch_AutoUnlock | core/test/telegram_access_test.go |
| 1405 | PENDING | -- | PENDING | TestTelegram_AuditIncludesUserOrigin | core/test/telegram_access_test.go |
| 1406 | PENDING | -- | PENDING | TestTelegram_DefaultPersonaCannotBeLocked | core/test/telegram_access_test.go |
| 1407 | PENDING | -- | PENDING | TestTelegram_StandardPersonaCannotBeLocked | core/test/telegram_access_test.go |
| 1408 | PENDING | -- | PENDING | TestTelegram_SensitivePersonaCanBeLocked | core/test/telegram_access_test.go |
| 1409 | PENDING | -- | PENDING | TestTelegram_DefaultPersonaForcedUnlockedOnLoad | core/test/telegram_access_test.go |
| 1410 | PENDING | -- | PENDING | TestTieredContent_StoreWithL0L1 | core/test/tiered_content_test.go |
| 1411 | PENDING | -- | PENDING | TestTieredContent_StoreWithoutL0L1 | core/test/tiered_content_test.go |
| 1412 | PENDING | -- | PENDING | TestTieredContent_EnrichmentStatusValidation | core/test/tiered_content_test.go |
| 1413 | PENDING | -- | PENDING | TestTieredContent_ProcessingStatus | core/test/tiered_content_test.go |
| 1414 | PENDING | -- | PENDING | TestTieredContent_FailedStatus | core/test/tiered_content_test.go |
| 1415 | PENDING | -- | PENDING | TestTieredContent_EnrichmentVersionJSON | core/test/tiered_content_test.go |
| 1416 | PENDING | -- | PENDING | TestTieredContent_UnenrichedItemSearchable | core/test/tiered_content_test.go |
| 1417 | PENDING | -- | PENDING | TestTieredContent_EnrichedItemSearchable | core/test/tiered_content_test.go |
| 1418 | PENDING | -- | PENDING | TestTieredContent_BatchStoreWithEnrichment | core/test/tiered_content_test.go |
| 1419 | PENDING | -- | PENDING | TestTieredContent_ReEnrichment | core/test/tiered_content_test.go |
| 1420 | TAGGED | TST-CORE-1010 | PENDING | TestTraceability_30_7_1_ManifestTotalsMatchActual | core/test/traceability_test.go |
| 1421 | PENDING | -- | PENDING | TestTraceability_30_7_1_ManifestTotalsMatchActual/total_is_non_zero | core/test/traceability_test.go |
| 1422 | PENDING | -- | PENDING | TestTraceability_30_7_1_ManifestTotalsMatchActual/scenarios_count_is_non_zero | core/test/traceability_test.go |
| 1423 | PENDING | -- | PENDING | TestTraceability_30_7_1_ManifestTotalsMatchActual/sections_sum_equals_total | core/test/traceability_test.go |
| 1424 | PENDING | -- | PENDING | TestTraceability_30_7_1_ManifestTotalsMatchActual/scenarios_count_at_least_total | core/test/traceability_test.go |
| 1425 | PENDING | -- | PENDING | TestTraceability_30_7_1_ManifestTotalsMatchActual/every_section_id_has_scenario_entry | core/test/traceability_test.go |
| 1426 | PENDING | -- | PENDING | TestTraceability_30_7_1_ManifestTotalsMatchActual/actual_go_test_functions_exist | core/test/traceability_test.go |
| 1427 | PENDING | -- | PENDING | TestTraceability_30_7_1_ManifestTotalsMatchActual/total_exceeds_safety_threshold | core/test/traceability_test.go |
| 1428 | PENDING | -- | PENDING | TestTraceability_30_7_3_GoTestFunctionsMappedToPlanIDs | core/test/traceability_test.go |
| 1429 | PENDING | -- | PENDING | TestTraceability_30_7_3_GoTestFunctionsMappedToPlanIDs/tagged_functions_reference_mostly_valid_ids | core/test/traceability_test.go |
| 1430 | PENDING | -- | PENDING | TestTraceability_30_7_3_GoTestFunctionsMappedToPlanIDs/minimum_tagged_coverage | core/test/traceability_test.go |
| 1431 | PENDING | -- | PENDING | TestTraceability_30_7_3_GoTestFunctionsMappedToPlanIDs/no_extreme_id_duplication | core/test/traceability_test.go |
| 1432 | PENDING | -- | PENDING | TestTraceability_30_7_3_GoTestFunctionsMappedToPlanIDs/manifest_scenario_ids_follow_format | core/test/traceability_test.go |
| 1433 | PENDING | -- | PENDING | TestCompliance_30_5_4_NoTokenFallbackInAnyConftest | core/test/traceability_test.go |
| 1434 | PENDING | -- | PENDING | TestCompliance_30_5_4_NoTokenFallbackInAnyConftest/zero_fallback_patterns_across_all_conftest_files | core/test/traceability_test.go |
| 1435 | PENDING | -- | PENDING | TestCompliance_30_5_4_NoTokenFallbackInAnyConftest/no_brain_token_in_admin_operations | core/test/traceability_test.go |
| 1436 | PENDING | -- | PENDING | TestCompliance_30_2_1_ConftestUsesClientTokenForAdminOps | core/test/traceability_test.go |
| 1437 | PENDING | -- | PENDING | TestCompliance_30_2_1_ConftestUsesClientTokenForAdminOps/e2e_conftest_uses_client_token_for_persona_ops | core/test/traceability_test.go |
| 1438 | PENDING | -- | PENDING | TestCompliance_30_2_1_ConftestUsesClientTokenForAdminOps/integration_conftest_uses_client_token_for_admin_setup | core/test/traceability_test.go |
| 1439 | PENDING | -- | PENDING | TestCompliance_30_2_1_ConftestUsesClientTokenForAdminOps/admin_headers_reference_client_token_not_brain_token | core/test/traceability_test.go |
| 1440 | PENDING | -- | PENDING | TestCompliance_30_2_4_DockerModeFailsFastOnMissingClientToken | core/test/traceability_test.go |
| 1441 | PENDING | -- | PENDING | TestCompliance_30_2_4_DockerModeFailsFastOnMissingClientToken/all_docker_services_have_fail_fast_assertion | core/test/traceability_test.go |
| 1442 | PENDING | -- | PENDING | TestCompliance_30_2_4_DockerModeFailsFastOnMissingClientToken/no_silent_empty_token_acceptance | core/test/traceability_test.go |
| 1443 | PENDING | -- | PENDING | TestCompliance_30_2_4_DockerModeFailsFastOnMissingClientToken/error_message_is_actionable | core/test/traceability_test.go |
| 1444 | PENDING | -- | PENDING | TestTraceability_30_7_4_PytestCollectOnlyMapsToPlanIDs | core/test/traceability_test.go |
| 1445 | PENDING | -- | PENDING | TestTraceability_30_7_4_PytestCollectOnlyMapsToPlanIDs/python_test_files_have_plan_id_tags | core/test/traceability_test.go |
| 1446 | PENDING | -- | PENDING | TestTraceability_30_7_4_PytestCollectOnlyMapsToPlanIDs/tag_ids_follow_consistent_format | core/test/traceability_test.go |
| 1447 | PENDING | -- | PENDING | TestTraceability_30_7_4_PytestCollectOnlyMapsToPlanIDs/minimum_total_tags_across_suites | core/test/traceability_test.go |
| 1448 | PENDING | -- | PENDING | TestBIP39_2_1_1_Generate24WordMnemonic | core/test/traceability_test.go |
| 1449 | PENDING | -- | PENDING | TestBIP39_2_1_1_Generate24WordMnemonic/uses_trezor_bip39_reference_library | core/test/traceability_test.go |
| 1450 | PENDING | -- | PENDING | TestBIP39_2_1_1_Generate24WordMnemonic/uses_english_wordlist | core/test/traceability_test.go |
| 1451 | PENDING | -- | PENDING | TestBIP39_2_1_1_Generate24WordMnemonic/seed_to_mnemonic_function_exists_with_correct_signature | core/test/traceability_test.go |
| 1452 | PENDING | -- | PENDING | TestBIP39_2_1_1_Generate24WordMnemonic/validates_32_byte_input_entropy | core/test/traceability_test.go |
| 1453 | PENDING | -- | PENDING | TestBIP39_2_1_1_Generate24WordMnemonic/produces_word_list_from_to_mnemonic | core/test/traceability_test.go |
| 1454 | PENDING | -- | PENDING | TestBIP39_2_1_1_Generate24WordMnemonic/generate_seed_uses_csprng | core/test/traceability_test.go |
| 1455 | PENDING | -- | PENDING | TestBIP39_2_1_1_Generate24WordMnemonic/standalone_script_validates_entropy_length | core/test/traceability_test.go |
| 1456 | PENDING | -- | PENDING | TestBIP39_2_1_3_InvalidMnemonicBadChecksum | core/test/traceability_test.go |
| 1457 | PENDING | -- | PENDING | TestBIP39_2_1_3_InvalidMnemonicBadChecksum/seed_wrap_validates_checksum_before_conversion | core/test/traceability_test.go |
| 1458 | PENDING | -- | PENDING | TestBIP39_2_1_3_InvalidMnemonicBadChecksum/seed_wrap_raises_error_on_bad_checksum | core/test/traceability_test.go |
| 1459 | PENDING | -- | PENDING | TestBIP39_2_1_3_InvalidMnemonicBadChecksum/standalone_script_validates_checksum | core/test/traceability_test.go |
| 1460 | PENDING | -- | PENDING | TestBIP39_2_1_3_InvalidMnemonicBadChecksum/standalone_script_raises_on_bad_checksum | core/test/traceability_test.go |
| 1461 | PENDING | -- | PENDING | TestBIP39_2_1_3_InvalidMnemonicBadChecksum/mnemonic_to_seed_validates_word_count | core/test/traceability_test.go |
| 1462 | PENDING | -- | PENDING | TestBIP39_2_1_5_MnemonicExtraWhitespace | core/test/traceability_test.go |
| 1463 | PENDING | -- | PENDING | TestBIP39_2_1_5_MnemonicExtraWhitespace/seed_wrap_normalizes_whitespace_via_join | core/test/traceability_test.go |
| 1464 | PENDING | -- | PENDING | TestBIP39_2_1_5_MnemonicExtraWhitespace/standalone_script_normalizes_whitespace | core/test/traceability_test.go |
| 1465 | PENDING | -- | PENDING | TestBIP39_2_1_5_MnemonicExtraWhitespace/seed_wrap_accepts_list_input_for_natural_normalization | core/test/traceability_test.go |
| 1466 | PENDING | -- | PENDING | TestBIP39_2_1_5_MnemonicExtraWhitespace/consistent_normalization_across_both_implementations | core/test/traceability_test.go |
| 1467 | PENDING | -- | PENDING | TestBIP39_2_1_4_InvalidMnemonicWrongWordCount | core/test/traceability_test.go |
| 1468 | PENDING | -- | PENDING | TestBIP39_2_1_4_InvalidMnemonicWrongWordCount/seed_wrap_rejects_non_24_word_mnemonic | core/test/traceability_test.go |
| 1469 | PENDING | -- | PENDING | TestBIP39_2_1_4_InvalidMnemonicWrongWordCount/seed_wrap_error_message_specifies_expected_count | core/test/traceability_test.go |
| 1470 | PENDING | -- | PENDING | TestBIP39_2_1_4_InvalidMnemonicWrongWordCount/seed_wrap_word_count_checked_before_checksum | core/test/traceability_test.go |
| 1471 | PENDING | -- | PENDING | TestBIP39_2_1_4_InvalidMnemonicWrongWordCount/standalone_script_rejects_wrong_word_count | core/test/traceability_test.go |
| 1472 | PENDING | -- | PENDING | TestBIP39_2_1_4_InvalidMnemonicWrongWordCount/standalone_script_error_mentions_24 | core/test/traceability_test.go |
| 1473 | PENDING | -- | PENDING | TestBIP39_2_1_4_InvalidMnemonicWrongWordCount/seed_to_mnemonic_only_accepts_32_bytes_for_24_words | core/test/traceability_test.go |
| 1474 | PENDING | -- | PENDING | TestBIP39_29_8_1_RecoveryRejectsInvalidChecksum | core/test/traceability_test.go |
| 1475 | PENDING | -- | PENDING | TestBIP39_29_8_1_RecoveryRejectsInvalidChecksum/recovery_path_validates_before_key_derivation | core/test/traceability_test.go |
| 1476 | PENDING | -- | PENDING | TestBIP39_29_8_1_RecoveryRejectsInvalidChecksum/corrupt_word_produces_validation_error_not_wrong_keys | core/test/traceability_test.go |
| 1477 | PENDING | -- | PENDING | TestBIP39_29_8_1_RecoveryRejectsInvalidChecksum/recovery_script_also_validates_checksum | core/test/traceability_test.go |
| 1478 | PENDING | -- | PENDING | TestBIP39_29_8_1_RecoveryRejectsInvalidChecksum/recovery_error_mentions_checksum_in_standalone_script | core/test/traceability_test.go |
| 1479 | PENDING | -- | PENDING | TestBIP39_29_8_1_RecoveryRejectsInvalidChecksum/no_silent_fallback_to_entropy_extraction | core/test/traceability_test.go |
| 1480 | PENDING | -- | PENDING | TestBIP39_29_8_1_RecoveryRejectsInvalidChecksum/both_entry_points_use_same_validation_library | core/test/traceability_test.go |
| 1481 | PENDING | -- | PENDING | TestBIP39_29_8_1_RecoveryRejectsInvalidChecksum/go_side_assumes_valid_entropy_from_python | core/test/traceability_test.go |
| 1482 | TAGGED | TST-CORE-059 | PENDING | TestBIP39_29_8_2_RecoveryRejectsWrongWordCount | core/test/traceability_test.go |
| 1483 | PENDING | -- | PENDING | TestBIP39_29_8_2_RecoveryRejectsWrongWordCount/library_rejects_12_word_at_function_boundary | core/test/traceability_test.go |
| 1484 | PENDING | -- | PENDING | TestBIP39_29_8_2_RecoveryRejectsWrongWordCount/error_message_helps_user_understand_the_problem | core/test/traceability_test.go |
| 1485 | PENDING | -- | PENDING | TestBIP39_29_8_2_RecoveryRejectsWrongWordCount/standalone_script_also_rejects_wrong_word_count | core/test/traceability_test.go |
| 1486 | PENDING | -- | PENDING | TestBIP39_29_8_2_RecoveryRejectsWrongWordCount/word_count_check_precedes_checksum_validation | core/test/traceability_test.go |
| 1487 | PENDING | -- | PENDING | TestBIP39_29_8_2_RecoveryRejectsWrongWordCount/rejection_is_raise_not_return_none | core/test/traceability_test.go |
| 1488 | PENDING | -- | PENDING | TestBIP39_29_8_2_RecoveryRejectsWrongWordCount/no_silent_truncation_or_padding | core/test/traceability_test.go |
| 1489 | PENDING | -- | PENDING | TestComposition_30_4_1_CreateAppBootSmokeMinimalEnv | core/test/traceability_test.go |
| 1490 | PENDING | -- | PENDING | TestComposition_30_4_1_CreateAppBootSmokeMinimalEnv/create_app_function_exists_and_returns_fastapi | core/test/traceability_test.go |
| 1491 | PENDING | -- | PENDING | TestComposition_30_4_1_CreateAppBootSmokeMinimalEnv/explicit_dependency_construction_no_di_framework | core/test/traceability_test.go |
| 1492 | PENDING | -- | PENDING | TestComposition_30_4_1_CreateAppBootSmokeMinimalEnv/llm_providers_optional_with_graceful_degradation | core/test/traceability_test.go |
| 1493 | PENDING | -- | PENDING | TestComposition_30_4_1_CreateAppBootSmokeMinimalEnv/spacy_scrubber_optional_not_required | core/test/traceability_test.go |
| 1494 | PENDING | -- | PENDING | TestComposition_30_4_1_CreateAppBootSmokeMinimalEnv/healthz_endpoint_registered_without_auth | core/test/traceability_test.go |
| 1495 | PENDING | -- | PENDING | TestComposition_30_4_1_CreateAppBootSmokeMinimalEnv/admin_ui_conditional_on_client_token | core/test/traceability_test.go |
| 1496 | PENDING | -- | PENDING | TestComposition_30_4_1_CreateAppBootSmokeMinimalEnv/module_isolation_rules_enforced | core/test/traceability_test.go |
| 1497 | PENDING | -- | PENDING | TestComposition_30_4_1_CreateAppBootSmokeMinimalEnv/service_identity_fail_closed | core/test/traceability_test.go |
| 1498 | PENDING | -- | PENDING | TestCleanup_30_6_1_HardCleanupPerTestClassInRealSuites | core/test/traceability_test.go |
| 1499 | PENDING | -- | PENDING | TestCleanup_30_6_1_HardCleanupPerTestClassInRealSuites/integration_session_clears_vault_at_startup | core/test/traceability_test.go |
| 1500 | PENDING | -- | PENDING | TestCleanup_30_6_1_HardCleanupPerTestClassInRealSuites/integration_has_autouse_cleanup_fixture | core/test/traceability_test.go |
| 1501 | PENDING | -- | PENDING | TestCleanup_30_6_1_HardCleanupPerTestClassInRealSuites/e2e_session_clears_vault_on_all_nodes | core/test/traceability_test.go |
| 1502 | PENDING | -- | PENDING | TestCleanup_30_6_1_HardCleanupPerTestClassInRealSuites/e2e_has_per_test_state_reset | core/test/traceability_test.go |
| 1503 | PENDING | -- | PENDING | TestCleanup_30_6_1_HardCleanupPerTestClassInRealSuites/e2e_reset_clears_all_mutable_state_categories | core/test/traceability_test.go |
| 1504 | PENDING | -- | PENDING | TestCleanup_30_6_1_HardCleanupPerTestClassInRealSuites/cleanup_uses_client_token_not_brain_token | core/test/traceability_test.go |
| 1505 | PENDING | -- | PENDING | TestCleanup_30_6_1_HardCleanupPerTestClassInRealSuites/e2e_clears_real_go_core_state_for_docker_nodes | core/test/traceability_test.go |
| 1506 | PENDING | -- | PENDING | TestComposition_30_4_2_DegradedStartupMissingSpacyModel | core/test/traceability_test.go |
| 1507 | PENDING | -- | PENDING | TestComposition_30_4_2_DegradedStartupMissingSpacyModel/spacy_scrubber_class_documents_exception_behavior | core/test/traceability_test.go |
| 1508 | PENDING | -- | PENDING | TestComposition_30_4_2_DegradedStartupMissingSpacyModel/spacy_load_inside_init_not_module_level | core/test/traceability_test.go |
| 1509 | PENDING | -- | PENDING | TestComposition_30_4_2_DegradedStartupMissingSpacyModel/scrubber_fallback_chain_presidio_then_spacy_then_none | core/test/traceability_test.go |
| 1510 | PENDING | -- | PENDING | TestComposition_30_4_2_DegradedStartupMissingSpacyModel/scrubber_none_when_both_unavailable | core/test/traceability_test.go |
| 1511 | PENDING | -- | PENDING | TestComposition_30_4_2_DegradedStartupMissingSpacyModel/warning_logged_when_scrubber_unavailable | core/test/traceability_test.go |
| 1512 | PENDING | -- | PENDING | TestComposition_30_4_2_DegradedStartupMissingSpacyModel/degraded_scrubber_tier_tracked | core/test/traceability_test.go |
| 1513 | PENDING | -- | PENDING | TestComposition_30_4_2_DegradedStartupMissingSpacyModel/scrubber_tier_passed_to_llm_router_config | core/test/traceability_test.go |
| 1514 | PENDING | -- | PENDING | TestComposition_30_4_3_HealthzComponentStatusCorrectness | core/test/traceability_test.go |
| 1515 | PENDING | -- | PENDING | TestComposition_30_4_3_HealthzComponentStatusCorrectness/healthz_registered_on_master_app_not_subapp | core/test/traceability_test.go |
| 1516 | PENDING | -- | PENDING | TestComposition_30_4_3_HealthzComponentStatusCorrectness/healthz_checks_core_connectivity | core/test/traceability_test.go |
| 1517 | PENDING | -- | PENDING | TestComposition_30_4_3_HealthzComponentStatusCorrectness/healthz_has_timeout_to_prevent_blocking | core/test/traceability_test.go |
| 1518 | PENDING | -- | PENDING | TestComposition_30_4_3_HealthzComponentStatusCorrectness/healthz_reports_degraded_when_core_unreachable | core/test/traceability_test.go |
| 1519 | PENDING | -- | PENDING | TestComposition_30_4_3_HealthzComponentStatusCorrectness/healthz_reports_degraded_when_no_llm_providers | core/test/traceability_test.go |
| 1520 | PENDING | -- | PENDING | TestComposition_30_4_3_HealthzComponentStatusCorrectness/healthz_returns_dict_with_status_field | core/test/traceability_test.go |
| 1521 | PENDING | -- | PENDING | TestComposition_30_4_3_HealthzComponentStatusCorrectness/healthz_is_async_for_non_blocking_probes | core/test/traceability_test.go |
| 1522 | PENDING | -- | PENDING | TestCleanup_30_6_2_DirtyStateDetectorFailsOnPriorRunArtifacts | core/test/traceability_test.go |
| 1523 | PENDING | -- | PENDING | TestCleanup_30_6_2_DirtyStateDetectorFailsOnPriorRunArtifacts/realvault_tracks_items_via_item_map | core/test/traceability_test.go |
| 1524 | PENDING | -- | PENDING | TestCleanup_30_6_2_DirtyStateDetectorFailsOnPriorRunArtifacts/store_populates_item_map | core/test/traceability_test.go |
| 1525 | PENDING | -- | PENDING | TestCleanup_30_6_2_DirtyStateDetectorFailsOnPriorRunArtifacts/retrieve_uses_item_map_for_filtering | core/test/traceability_test.go |
| 1526 | PENDING | -- | PENDING | TestCleanup_30_6_2_DirtyStateDetectorFailsOnPriorRunArtifacts/item_map_per_test_instance_not_shared | core/test/traceability_test.go |
| 1527 | PENDING | -- | PENDING | TestCleanup_30_6_2_DirtyStateDetectorFailsOnPriorRunArtifacts/cleanup_ids_tracked_for_eventual_removal | core/test/traceability_test.go |
| 1528 | PENDING | -- | PENDING | TestCleanup_30_6_2_DirtyStateDetectorFailsOnPriorRunArtifacts/delete_removes_from_item_map | core/test/traceability_test.go |
| 1529 | PENDING | -- | PENDING | TestCleanup_30_6_2_DirtyStateDetectorFailsOnPriorRunArtifacts/conftest_documents_isolation_strategy | core/test/traceability_test.go |
| 1530 | PENDING | -- | PENDING | TestStrictReal_30_1_EnvVarAndFlagDefinition | core/test/traceability_test.go |
| 1531 | PENDING | -- | PENDING | TestStrictReal_30_1_EnvVarAndFlagDefinition/integration_reads_DINA_STRICT_REAL_env_var | core/test/traceability_test.go |
| 1532 | PENDING | -- | PENDING | TestStrictReal_30_1_EnvVarAndFlagDefinition/e2e_reads_DINA_STRICT_REAL_env_var | core/test/traceability_test.go |
| 1533 | PENDING | -- | PENDING | TestStrictReal_30_1_EnvVarAndFlagDefinition/integration_defines_STRICT_REAL_module_flag | core/test/traceability_test.go |
| 1534 | PENDING | -- | PENDING | TestStrictReal_30_1_EnvVarAndFlagDefinition/e2e_defines_STRICT_REAL_module_flag | core/test/traceability_test.go |
| 1535 | PENDING | -- | PENDING | TestStrictReal_30_1_EnvVarAndFlagDefinition/flag_compares_to_string_1_not_truthy | core/test/traceability_test.go |
| 1536 | PENDING | -- | PENDING | TestStrictReal_30_1_EnvVarAndFlagDefinition/flag_strips_whitespace_before_comparison | core/test/traceability_test.go |
| 1537 | PENDING | -- | PENDING | TestStrictReal_30_1_EnvVarAndFlagDefinition/both_files_document_strict_real_purpose | core/test/traceability_test.go |
| 1538 | PENDING | -- | PENDING | TestStrictReal_30_1_TryRequestRaisesInStrictMode | core/test/traceability_test.go |
| 1539 | PENDING | -- | PENDING | TestStrictReal_30_1_TryRequestRaisesInStrictMode/try_request_checks_STRICT_REAL_on_non_success | core/test/traceability_test.go |
| 1540 | PENDING | -- | PENDING | TestStrictReal_30_1_TryRequestRaisesInStrictMode/try_request_raises_RuntimeError_not_returns_None | core/test/traceability_test.go |
| 1541 | PENDING | -- | PENDING | TestStrictReal_30_1_TryRequestRaisesInStrictMode/error_message_includes_STRICT_REAL_prefix | core/test/traceability_test.go |
| 1542 | PENDING | -- | PENDING | TestStrictReal_30_1_TryRequestRaisesInStrictMode/error_message_includes_method_and_url | core/test/traceability_test.go |
| 1543 | PENDING | -- | PENDING | TestStrictReal_30_1_TryRequestRaisesInStrictMode/error_message_includes_status_code | core/test/traceability_test.go |
| 1544 | PENDING | -- | PENDING | TestStrictReal_30_1_TryRequestRaisesInStrictMode/connection_errors_also_raise_in_strict_mode | core/test/traceability_test.go |
| 1545 | PENDING | -- | PENDING | TestStrictReal_30_1_TryRequestRaisesInStrictMode/non_strict_mode_still_returns_None | core/test/traceability_test.go |
| 1546 | PENDING | -- | PENDING | TestStrictReal_30_1_ApiRequestRaisesInStrictMode | core/test/traceability_test.go |
| 1547 | PENDING | -- | PENDING | TestStrictReal_30_1_ApiRequestRaisesInStrictMode/api_request_merges_STRICT_REAL_with_raise_on_fail | core/test/traceability_test.go |
| 1548 | PENDING | -- | PENDING | TestStrictReal_30_1_ApiRequestRaisesInStrictMode/api_request_raises_RuntimeError_on_non_success | core/test/traceability_test.go |
| 1549 | PENDING | -- | PENDING | TestStrictReal_30_1_ApiRequestRaisesInStrictMode/error_message_includes_STRICT_REAL_prefix | core/test/traceability_test.go |
| 1550 | PENDING | -- | PENDING | TestStrictReal_30_1_ApiRequestRaisesInStrictMode/error_message_includes_method_url_and_status | core/test/traceability_test.go |
| 1551 | PENDING | -- | PENDING | TestStrictReal_30_1_ApiRequestRaisesInStrictMode/connection_errors_raise_when_strict | core/test/traceability_test.go |
| 1552 | PENDING | -- | PENDING | TestStrictReal_30_1_ApiRequestRaisesInStrictMode/non_strict_still_returns_None | core/test/traceability_test.go |
| 1553 | PENDING | -- | PENDING | TestStrictReal_30_1_ApiRequestRaisesInStrictMode/api_request_has_raise_on_fail_parameter | core/test/traceability_test.go |
| 1554 | PENDING | -- | PENDING | TestStrictReal_30_1_ApiRequestRaisesInStrictMode/strict_real_documented_in_module_header | core/test/traceability_test.go |
| 1555 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_3_CompatTestsLabeledExplicitly | core/test/traceability_test.go |
| 1556 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_3_CompatTestsLabeledExplicitly/pyproject_toml_defines_compat_marker | core/test/traceability_test.go |
| 1557 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_3_CompatTestsLabeledExplicitly/pyproject_toml_defines_legacy_marker | core/test/traceability_test.go |
| 1558 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_3_CompatTestsLabeledExplicitly/makefile_test_excludes_legacy | core/test/traceability_test.go |
| 1559 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_3_CompatTestsLabeledExplicitly/backward_compat_tests_have_compat_marker | core/test/traceability_test.go |
| 1560 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_3_CompatTestsLabeledExplicitly/compat_marker_count_nonzero | core/test/traceability_test.go |
| 1561 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_3_CompatTestsLabeledExplicitly/all_six_markers_defined_in_pyproject | core/test/traceability_test.go |
| 1562 | PENDING | -- | PENDING | TestCI_30_8_1_UnitCoreStage | core/test/traceability_test.go |
| 1563 | PENDING | -- | PENDING | TestCI_30_8_1_UnitCoreStage/go_test_files_exist_and_follow_convention | core/test/traceability_test.go |
| 1564 | PENDING | -- | PENDING | TestCI_30_8_1_UnitCoreStage/all_test_files_have_package_declaration | core/test/traceability_test.go |
| 1565 | PENDING | -- | PENDING | TestCI_30_8_1_UnitCoreStage/core_subsystems_covered_by_tests | core/test/traceability_test.go |
| 1566 | PENDING | -- | PENDING | TestCI_30_8_1_UnitCoreStage/test_functions_exist_in_test_files | core/test/traceability_test.go |
| 1567 | PENDING | -- | PENDING | TestCI_30_8_1_UnitCoreStage/makefile_has_go_test_target | core/test/traceability_test.go |
| 1568 | PENDING | -- | PENDING | TestCI_30_8_1_UnitCoreStage/total_test_function_count_is_substantial | core/test/traceability_test.go |
| 1569 | PENDING | -- | PENDING | TestCI_30_8_1_UnitCoreStage/master_runner_includes_integration_tests | core/test/traceability_test.go |
| 1570 | PENDING | -- | PENDING | TestCI_30_8_1_UnitCoreStage/fts5_build_tag_documented | core/test/traceability_test.go |
| 1571 | PENDING | -- | PENDING | TestCI_30_8_2_UnitBrainStage | core/test/traceability_test.go |
| 1572 | PENDING | -- | PENDING | TestCI_30_8_2_UnitBrainStage/brain_test_files_exist_and_follow_convention | core/test/traceability_test.go |
| 1573 | PENDING | -- | PENDING | TestCI_30_8_2_UnitBrainStage/conftest_exists_with_fixtures | core/test/traceability_test.go |
| 1574 | PENDING | -- | PENDING | TestCI_30_8_2_UnitBrainStage/brain_subsystems_covered_by_tests | core/test/traceability_test.go |
| 1575 | PENDING | -- | PENDING | TestCI_30_8_2_UnitBrainStage/test_files_contain_test_functions_or_classes | core/test/traceability_test.go |
| 1576 | PENDING | -- | PENDING | TestCI_30_8_2_UnitBrainStage/makefile_has_pytest_target | core/test/traceability_test.go |
| 1577 | PENDING | -- | PENDING | TestCI_30_8_2_UnitBrainStage/total_test_function_count_is_substantial | core/test/traceability_test.go |
| 1578 | PENDING | -- | PENDING | TestCI_30_8_2_UnitBrainStage/brain_tests_do_not_import_go_core | core/test/traceability_test.go |
| 1579 | PENDING | -- | PENDING | TestCI_30_8_2_UnitBrainStage/factories_module_exists | core/test/traceability_test.go |
| 1580 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_1_LegacyTestsInExplicitProfile | core/test/traceability_test.go |
| 1581 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_1_LegacyTestsInExplicitProfile/legacy_marker_defined_in_pyproject | core/test/traceability_test.go |
| 1582 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_1_LegacyTestsInExplicitProfile/legacy_marker_has_meaningful_description | core/test/traceability_test.go |
| 1583 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_1_LegacyTestsInExplicitProfile/addopts_does_not_auto_exclude_legacy | core/test/traceability_test.go |
| 1584 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_1_LegacyTestsInExplicitProfile/makefile_excludes_legacy_from_default_pipeline | core/test/traceability_test.go |
| 1585 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_1_LegacyTestsInExplicitProfile/legacy_or_compat_markers_on_old_test_files | core/test/traceability_test.go |
| 1586 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_1_LegacyTestsInExplicitProfile/legacy_exclusion_is_pytest_not_filter | core/test/traceability_test.go |
| 1587 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_1_LegacyTestsInExplicitProfile/marker_infrastructure_self_consistent | core/test/traceability_test.go |
| 1588 | PENDING | -- | PENDING | TestCI_30_8_4_IntegrationRealStage | core/test/traceability_test.go |
| 1589 | PENDING | -- | PENDING | TestCI_30_8_4_IntegrationRealStage/integration_conftest_implements_dual_mode | core/test/traceability_test.go |
| 1590 | PENDING | -- | PENDING | TestCI_30_8_4_IntegrationRealStage/real_client_classes_exist_with_inheritance | core/test/traceability_test.go |
| 1591 | PENDING | -- | PENDING | TestCI_30_8_4_IntegrationRealStage/strict_real_mode_prevents_mock_fallback | core/test/traceability_test.go |
| 1592 | PENDING | -- | PENDING | TestCI_30_8_4_IntegrationRealStage/union_compose_exists_with_isolation | core/test/traceability_test.go |
| 1593 | PENDING | -- | PENDING | TestCI_30_8_4_IntegrationRealStage/test_stack_services_class_exists | core/test/traceability_test.go |
| 1594 | PENDING | -- | PENDING | TestCI_30_8_4_IntegrationRealStage/makefile_has_integration_target_with_docker | core/test/traceability_test.go |
| 1595 | PENDING | -- | PENDING | TestCI_30_8_4_IntegrationRealStage/retry_on_429_for_rate_limited_apis | core/test/traceability_test.go |
| 1596 | PENDING | -- | PENDING | TestCI_30_8_4_IntegrationRealStage/integration_tests_cover_major_subsystems | core/test/traceability_test.go |
| 1597 | PENDING | -- | PENDING | TestCI_30_8_4_IntegrationRealStage/ed25519_signing_for_real_requests | core/test/traceability_test.go |
| 1598 | PENDING | -- | PENDING | TestCI_30_8_5_E2ESmokeRealStage | core/test/traceability_test.go |
| 1599 | PENDING | -- | PENDING | TestCI_30_8_5_E2ESmokeRealStage/multi_node_compose_has_4_actors | core/test/traceability_test.go |
| 1600 | PENDING | -- | PENDING | TestCI_30_8_5_E2ESmokeRealStage/keygen_init_containers_provision_keys | core/test/traceability_test.go |
| 1601 | PENDING | -- | PENDING | TestCI_30_8_5_E2ESmokeRealStage/e2e_conftest_skips_without_docker | core/test/traceability_test.go |
| 1602 | PENDING | -- | PENDING | TestCI_30_8_5_E2ESmokeRealStage/real_home_node_class_exists | core/test/traceability_test.go |
| 1603 | PENDING | -- | PENDING | TestCI_30_8_5_E2ESmokeRealStage/real_d2d_network_class_exists | core/test/traceability_test.go |
| 1604 | PENDING | -- | PENDING | TestCI_30_8_5_E2ESmokeRealStage/test_stack_services_used_by_e2e | core/test/traceability_test.go |
| 1605 | PENDING | -- | PENDING | TestCI_30_8_5_E2ESmokeRealStage/critical_path_d2d_messaging_tests_exist | core/test/traceability_test.go |
| 1606 | PENDING | -- | PENDING | TestCI_30_8_5_E2ESmokeRealStage/critical_path_vault_crud_tests_exist | core/test/traceability_test.go |
| 1607 | PENDING | -- | PENDING | TestCI_30_8_5_E2ESmokeRealStage/critical_path_pii_scrub_tests_exist | core/test/traceability_test.go |
| 1608 | PENDING | -- | PENDING | TestCI_30_8_5_E2ESmokeRealStage/e2e_suite_has_sufficient_test_coverage | core/test/traceability_test.go |
| 1609 | PENDING | -- | PENDING | TestCI_30_8_5_E2ESmokeRealStage/allowed_endpoints_include_all_actors | core/test/traceability_test.go |
| 1610 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_2_DefaultPipelineExcludesLegacy | core/test/traceability_test.go |
| 1611 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_2_DefaultPipelineExcludesLegacy/makefile_default_test_excludes_legacy | core/test/traceability_test.go |
| 1612 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_2_DefaultPipelineExcludesLegacy/legacy_exclusion_is_in_pytest_not_go_test | core/test/traceability_test.go |
| 1613 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_2_DefaultPipelineExcludesLegacy/all_legacy_files_have_module_level_marker | core/test/traceability_test.go |
| 1614 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_2_DefaultPipelineExcludesLegacy/integration_dir_has_no_unmarked_legacy | core/test/traceability_test.go |
| 1615 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_2_DefaultPipelineExcludesLegacy/e2e_dir_has_no_unmarked_legacy | core/test/traceability_test.go |
| 1616 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_2_DefaultPipelineExcludesLegacy/run_all_tests_does_not_run_legacy | core/test/traceability_test.go |
| 1617 | PENDING | -- | PENDING | TestLegacyTestSeparation_30_9_2_DefaultPipelineExcludesLegacy/legacy_marker_count_matches_legacy_files | core/test/traceability_test.go |
| 1618 | TAGGED | TST-CORE-934 | PENDING | TestAdv_29_1_SendStoresSignature | core/test/transport_adversarial_test.go |
| 1619 | PENDING | -- | PENDING | TestAdv_29_1_SendStoresSignature/sig_stored_and_status_delivered | core/test/transport_adversarial_test.go |
| 1620 | PENDING | -- | PENDING | TestAdv_29_1_SendStoresSignature/sig_is_valid_ed25519_64_bytes | core/test/transport_adversarial_test.go |
| 1621 | PENDING | -- | PENDING | TestAdv_29_1_SendStoresSignature/sig_verifies_against_plaintext | core/test/transport_adversarial_test.go |
| 1622 | PENDING | -- | PENDING | TestAdv_29_1_SendStoresSignature/delivery_payload_has_hex_sig_and_base64_ciphertext | core/test/transport_adversarial_test.go |
| 1623 | PENDING | -- | PENDING | TestAdv_29_1_SendStoresSignature/different_messages_produce_different_sigs | core/test/transport_adversarial_test.go |
| 1624 | TAGGED | TST-CORE-935 | PENDING | TestAdv_29_1_ValidSignatureAccepted | core/test/transport_adversarial_test.go |
| 1625 | PENDING | -- | PENDING | TestAdv_29_1_ValidSignatureAccepted/basic_valid_sig_decrypts_successfully | core/test/transport_adversarial_test.go |
| 1626 | PENDING | -- | PENDING | TestAdv_29_1_ValidSignatureAccepted/all_message_fields_preserved | core/test/transport_adversarial_test.go |
| 1627 | PENDING | -- | PENDING | TestAdv_29_1_ValidSignatureAccepted/signature_genuinely_verified_not_skipped | core/test/transport_adversarial_test.go |
| 1628 | PENDING | -- | PENDING | TestAdv_29_1_ValidSignatureAccepted/different_message_types_accepted | core/test/transport_adversarial_test.go |
| 1629 | TAGGED | TST-CORE-936 | PENDING | TestAdv_29_1_WrongSignatureRejected | core/test/transport_adversarial_test.go |
| 1630 | TAGGED | TST-CORE-937 | PENDING | TestAdv_29_1_TamperedCiphertextRejected | core/test/transport_adversarial_test.go |
| 1631 | PENDING | -- | PENDING | TestAdv_29_1_EmptySigRejected | core/test/transport_adversarial_test.go |
| 1632 | PENDING | -- | PENDING | TestAdv_29_2_OutboxDeliverSuccess | core/test/transport_adversarial_test.go |
| 1633 | TAGGED | TST-CORE-940 | PENDING | TestAdv_29_2_OutboxDeliveryFailure | core/test/transport_adversarial_test.go |
| 1634 | TAGGED | TST-CORE-941 | PENDING | TestAdv_29_2_OutboxRetryTransient | core/test/transport_adversarial_test.go |
| 1635 | PENDING | -- | PENDING | TestAdv_29_2_OutboxUnresolvableDID | core/test/transport_adversarial_test.go |
| 1636 | TAGGED | TST-CORE-943 | PENDING | TestAdv_29_2_OutboxNoDeliverer | core/test/transport_adversarial_test.go |
| 1637 | PENDING | -- | PENDING | TestAdv_29_2_OutboxContextCancel | core/test/transport_adversarial_test.go |
| 1638 | TAGGED | TST-CORE-947 | PENDING | TestAdv_29_3_IngressIPRateLimit | core/test/transport_adversarial_test.go |
| 1639 | TAGGED | TST-CORE-948 | PENDING | TestAdv_29_3_IngressRouterFlood | core/test/transport_adversarial_test.go |
| 1640 | TAGGED | TST-CORE-949 | PENDING | TestAdv_29_3_IngressDeadDropLocked | core/test/transport_adversarial_test.go |
| 1641 | PENDING | -- | PENDING | TestAdv_29_3_IngressDeadDropLocked/single_message_to_dead_drop | core/test/transport_adversarial_test.go |
| 1642 | PENDING | -- | PENDING | TestAdv_29_3_IngressDeadDropLocked/multiple_messages_accumulate | core/test/transport_adversarial_test.go |
| 1643 | PENDING | -- | PENDING | TestAdv_29_3_IngressDeadDropLocked/blobs_retrievable_after_store | core/test/transport_adversarial_test.go |
| 1644 | TAGGED | TST-CORE-950 | PENDING | TestAdv_29_3_IngressInboxUnlocked | core/test/transport_adversarial_test.go |
| 1645 | PENDING | -- | PENDING | TestAdv_29_3_IngressInboxUnlocked/single_message_to_inbox | core/test/transport_adversarial_test.go |
| 1646 | PENDING | -- | PENDING | TestAdv_29_3_IngressInboxUnlocked/multiple_messages_all_to_inbox | core/test/transport_adversarial_test.go |
| 1647 | PENDING | -- | PENDING | TestAdv_29_3_IngressInboxUnlocked/message_content_preserved | core/test/transport_adversarial_test.go |
| 1648 | PENDING | -- | PENDING | TestAdv_29_3_IngressInboxUnlocked/locked_vs_unlocked_routing_contrast | core/test/transport_adversarial_test.go |
| 1649 | PENDING | -- | PENDING | TestAdv_29_3_IngressInboxUnlocked/different_ips_all_to_inbox | core/test/transport_adversarial_test.go |
| 1650 | TAGGED | TST-CORE-951 | PENDING | TestAdv_29_3_IngressSpoolFull | core/test/transport_adversarial_test.go |
| 1651 | PENDING | -- | PENDING | TestAdv_29_3_IngressSweeperSweep | core/test/transport_adversarial_test.go |
| 1652 | TAGGED | TST-CORE-953 | PENDING | TestAdv_29_3_IngressProcessPending | core/test/transport_adversarial_test.go |
| 1653 | TAGGED | TST-CORE-954 | PENDING | TestAdv_29_3_IngressOversizedPayload | core/test/transport_adversarial_test.go |
| 1654 | TAGGED | TST-CORE-955 | PENDING | TestAdv_29_3_IngressSweepFull | core/test/transport_adversarial_test.go |
| 1655 | PENDING | -- | PENDING | TestAdv_29_4_ReplayDuplicateID | core/test/transport_adversarial_test.go |
| 1656 | TAGGED | TST-CORE-957 | PENDING | TestAdv_29_4_DIDSpoofingFromKID | core/test/transport_adversarial_test.go |
| 1657 | PENDING | -- | PENDING | TestAdv_29_2_OutboxQueueLimit | core/test/transport_adversarial_test.go |
| 1658 | TAGGED | TST-CORE-946 | PENDING | TestAdv_29_2_OutboxRetryCount | core/test/transport_adversarial_test.go |
| 1659 | TAGGED | TST-CORE-958 | PENDING | TestAdv_29_5_PromptInjectionBodySafe | core/test/transport_adversarial_test.go |
| 1660 | TAGGED | TST-CORE-963 | PENDING | TestAdv_29_5_HTMLXSSBodySafe | core/test/transport_adversarial_test.go |
| 1661 | PENDING | -- | PENDING | TestAdv_29_5_HTMLXSSBodySafe/xss_body_does_not_affect_json_structure | core/test/transport_adversarial_test.go |
| 1662 | TAGGED | TST-CORE-952 | PENDING | TestAdv_29_3_IngressSweeperProcessesBlobs | core/test/transport_adversarial_test.go |
| 1663 | PENDING | -- | PENDING | TestAdv_29_3_IngressSweeperProcessesBlobs/two_blobs_both_delivered | core/test/transport_adversarial_test.go |
| 1664 | PENDING | -- | PENDING | TestAdv_29_3_IngressSweeperProcessesBlobs/expired_blobs_dropped_silently | core/test/transport_adversarial_test.go |
| 1665 | PENDING | -- | PENDING | TestAdv_29_3_IngressSweeperProcessesBlobs/poison_pill_evicted_after_max_retries | core/test/transport_adversarial_test.go |
| 1666 | PENDING | -- | PENDING | TestAdv_29_3_IngressSweeperProcessesBlobs/gc_stale_blobs_by_mtime | core/test/transport_adversarial_test.go |
| 1667 | PENDING | -- | PENDING | TestAdv_29_3_IngressSweeperProcessesBlobs/fresh_blobs_survive_gc | core/test/transport_adversarial_test.go |
| 1668 | PENDING | -- | PENDING | TestAdv_29_3_IngressSweeperProcessesBlobs/sweep_full_mixed_valid_and_expired | core/test/transport_adversarial_test.go |
| 1669 | PENDING | -- | PENDING | TestAdv_29_3_IngressSweeperProcessesBlobs/no_transport_no_keys_fail_closed | core/test/transport_adversarial_test.go |
| 1670 | TAGGED | TST-CORE-942 | PENDING | TestTransport_29_2_4_UnresolvableDIDMarkedFailed | core/test/transport_adversarial_test.go |
| 1671 | PENDING | -- | PENDING | TestTransport_29_2_4_UnresolvableDIDMarkedFailed/unknown_DID_marked_failed | core/test/transport_adversarial_test.go |
| 1672 | PENDING | -- | PENDING | TestTransport_29_2_4_UnresolvableDIDMarkedFailed/positive_control_known_DID_delivers | core/test/transport_adversarial_test.go |
| 1673 | PENDING | -- | PENDING | TestTransport_29_2_4_UnresolvableDIDMarkedFailed/mixed_queue_selective_failure | core/test/transport_adversarial_test.go |
| 1674 | PENDING | -- | PENDING | TestTransport_29_2_4_UnresolvableDIDMarkedFailed/DID_with_empty_service_endpoint_fails | core/test/transport_adversarial_test.go |
| 1675 | TAGGED | TST-CORE-956 | PENDING | TestTransport_29_4_1_ReplayedMessageSameIDDetected | core/test/transport_adversarial_test.go |
| 1676 | PENDING | -- | PENDING | TestTransport_29_4_1_ReplayedMessageSameIDDetected/duplicate_message_rejected_with_replay_error | core/test/transport_adversarial_test.go |
| 1677 | PENDING | -- | PENDING | TestTransport_29_4_1_ReplayedMessageSameIDDetected/different_IDs_same_sender_both_accepted | core/test/transport_adversarial_test.go |
| 1678 | PENDING | -- | PENDING | TestTransport_29_4_1_ReplayedMessageSameIDDetected/same_ID_different_senders_both_accepted | core/test/transport_adversarial_test.go |
| 1679 | PENDING | -- | PENDING | TestTransport_29_4_1_ReplayedMessageSameIDDetected/purge_cache_allows_reprocessing | core/test/transport_adversarial_test.go |
| 1680 | PENDING | -- | PENDING | TestTransport_29_4_1_ReplayedMessageSameIDDetected/positive_control_first_message_always_succeeds | core/test/transport_adversarial_test.go |
| 1681 | PENDING | -- | PENDING | TestTransport_29_2_1_ProcessOutboxDeliversPendingMessages | core/test/transport_adversarial_test.go |
| 1682 | PENDING | -- | PENDING | TestTransport_29_2_1_ProcessOutboxDeliversPendingMessages/pending_message_becomes_delivered_after_ProcessOutbox | core/test/transport_adversarial_test.go |
| 1683 | PENDING | -- | PENDING | TestTransport_29_2_1_ProcessOutboxDeliversPendingMessages/deliverer_receives_valid_d2d_payload_with_ciphertext_and_sig | core/test/transport_adversarial_test.go |
| 1684 | PENDING | -- | PENDING | TestTransport_29_2_1_ProcessOutboxDeliversPendingMessages/multiple_pending_messages_all_delivered_in_one_call | core/test/transport_adversarial_test.go |
| 1685 | PENDING | -- | PENDING | TestTransport_29_2_1_ProcessOutboxDeliversPendingMessages/dead_letter_messages_skipped_not_delivered | core/test/transport_adversarial_test.go |
| 1686 | PENDING | -- | PENDING | TestTransport_29_2_1_ProcessOutboxDeliversPendingMessages/positive_control_no_pending_messages_zero_processed | core/test/transport_adversarial_test.go |
| 1687 | PENDING | -- | PENDING | TestTransport_34_2_10_AgentCannotForgeFromDID | core/test/transport_adversarial_test.go |
| 1688 | PENDING | -- | PENDING | TestTransport_34_2_10_AgentCannotForgeFromDID/empty_From_gets_senderDID_in_round_trip | core/test/transport_adversarial_test.go |
| 1689 | PENDING | -- | PENDING | TestTransport_34_2_10_AgentCannotForgeFromDID/forged_From_detected_by_recipient_DID_resolution_failure | core/test/transport_adversarial_test.go |
| 1690 | PENDING | -- | PENDING | TestTransport_34_2_10_AgentCannotForgeFromDID/forged_From_with_different_key_fails_signature_verification | core/test/transport_adversarial_test.go |
| 1691 | PENDING | -- | PENDING | TestTransport_34_2_10_AgentCannotForgeFromDID/handler_sendRequest_does_not_expose_from_field | core/test/transport_adversarial_test.go |
| 1692 | PENDING | -- | PENDING | TestTransport_34_2_10_AgentCannotForgeFromDID/positive_control_legitimate_message_verifies_correctly | core/test/transport_adversarial_test.go |
| 1693 | TAGGED | TST-CORE-1088 | PENDING | TestFixVerify_31_8_1_SendMessage_DeliveryPayloadIsJSONWrapper | core/test/transport_d2d_sig_test.go |
| 1694 | TAGGED | TST-CORE-1089 | PENDING | TestFixVerify_31_8_2_ProcessInbound_JSONWrapperValidSig_Success | core/test/transport_d2d_sig_test.go |
| 1695 | TAGGED | TST-CORE-1090 | PENDING | TestFixVerify_31_8_3_ProcessInbound_JSONWrapperTamperedSig_Error | core/test/transport_d2d_sig_test.go |
| 1696 | TAGGED | TST-CORE-1093 | PENDING | TestFixVerify_31_8_6_ProcessInbound_RawBytesLegacy_Rejected | core/test/transport_d2d_sig_test.go |
| 1697 | PENDING | -- | PENDING | TestFixVerify_31_8_6_ProcessInbound_RawBytesLegacy_Rejected/encrypted_raw_nacl_rejected | core/test/transport_d2d_sig_test.go |
| 1698 | PENDING | -- | PENDING | TestFixVerify_31_8_6_ProcessInbound_RawBytesLegacy_Rejected/random_bytes_rejected | core/test/transport_d2d_sig_test.go |
| 1699 | PENDING | -- | PENDING | TestFixVerify_31_8_6_ProcessInbound_RawBytesLegacy_Rejected/empty_payload_rejected | core/test/transport_d2d_sig_test.go |
| 1700 | PENDING | -- | PENDING | TestFixVerify_31_8_6_ProcessInbound_RawBytesLegacy_Rejected/json_missing_sig_field_rejected | core/test/transport_d2d_sig_test.go |
| 1701 | TAGGED | TST-CORE-1095 | PENDING | TestFixVerify_31_8_8_ProcessOutbox_UsesJSONWrapper | core/test/transport_d2d_sig_test.go |
| 1702 | TAGGED | TST-CORE-1096 | PENDING | TestFixVerify_31_8_9_FullRoundTrip_SendAndReceiveWithSig | core/test/transport_d2d_sig_test.go |
| 1703 | TAGGED | TST-CORE-1091 | PENDING | TestFixVerify_31_8_4_ProcessInbound_JSONWrapperEmptySig_Rejected | core/test/transport_d2d_sig_test.go |
| 1704 | TAGGED | TST-CORE-1094 | PENDING | TestFixVerify_31_8_7_ProcessInbound_JSONWrapper_DIDSpoofing_Rejected | core/test/transport_d2d_sig_test.go |
| 1705 | PENDING | -- | PENDING | TestFixVerify_31_8_5_ProcessInbound_RawBytesLegacy_Migration | core/test/transport_d2d_sig_test.go |
| 1706 | PENDING | -- | PENDING | TestFixVerify_31_8_5_ProcessInbound_RawBytesLegacy_Migration/raw_nacl_accepted_when_allow_unsigned_enabled | core/test/transport_d2d_sig_test.go |
| 1707 | PENDING | -- | PENDING | TestFixVerify_31_8_5_ProcessInbound_RawBytesLegacy_Migration/raw_nacl_rejected_when_allow_unsigned_disabled | core/test/transport_d2d_sig_test.go |
| 1708 | PENDING | -- | PENDING | TestFixVerify_31_8_5_ProcessInbound_RawBytesLegacy_Migration/json_wrapper_still_works_with_allow_unsigned_enabled | core/test/transport_d2d_sig_test.go |
| 1709 | PENDING | -- | PENDING | TestFixVerify_31_8_5_ProcessInbound_RawBytesLegacy_Migration/garbage_bytes_rejected_even_with_allow_unsigned | core/test/transport_d2d_sig_test.go |
| 1710 | PENDING | -- | PENDING | TestFixVerify_31_8_5_ProcessInbound_RawBytesLegacy_Migration/empty_payload_rejected_even_with_allow_unsigned | core/test/transport_d2d_sig_test.go |
| 1711 | PENDING | -- | PENDING | TestFixVerify_31_8_5_ProcessInbound_RawBytesLegacy_Migration/message_body_preserved_in_legacy_path | core/test/transport_d2d_sig_test.go |
| 1712 | PENDING | -- | PENDING | TestFixVerify_31_8_5_ProcessInbound_RawBytesLegacy_Migration/toggle_allow_unsigned_off_rejects_again | core/test/transport_d2d_sig_test.go |
| 1713 | TAGGED | TST-CORE-394 | PENDING | TestTransport_7_1_1_SendToKnownRecipient | core/test/transport_test.go |
| 1714 | TAGGED | TST-CORE-805 | PENDING | TestTransport_7_1_2_SendToUnresolvableDIDFails | core/test/transport_test.go |
| 1715 | TAGGED | TST-CORE-806 | PENDING | TestTransport_7_1_3_SendEmptyEnvelopeRejected | core/test/transport_test.go |
| 1716 | TAGGED | TST-CORE-807 | PENDING | TestTransport_7_1_4_SendNilEnvelopeRejected | core/test/transport_test.go |
| 1717 | TAGGED | TST-CORE-808 | PENDING | TestTransport_7_1_5_MockSendRecordsMessages | core/test/transport_test.go |
| 1718 | TAGGED | TST-CORE-395 | PENDING | TestTransport_7_1_OutboxSchema | core/test/transport_test.go |
| 1719 | TAGGED | TST-CORE-810 | PENDING | TestTransport_7_2_1_ReceiveFromInbox | core/test/transport_test.go |
| 1720 | TAGGED | TST-CORE-811 | PENDING | TestTransport_7_2_2_EmptyInboxReturnsNil | core/test/transport_test.go |
| 1721 | TAGGED | TST-CORE-812 | PENDING | TestTransport_7_2_3_InboxFIFOOrder | core/test/transport_test.go |
| 1722 | TAGGED | TST-CORE-813 | PENDING | TestTransport_7_2_4_InboxSpoolWhenLocked | core/test/transport_test.go |
| 1723 | TAGGED | TST-CORE-814 | PENDING | TestTransport_7_2_5_InboxRejectWhenSpoolFull | core/test/transport_test.go |
| 1724 | TAGGED | TST-CORE-434 | PENDING | TestTransport_7_3_1_ResolveKnownDID | core/test/transport_test.go |
| 1725 | TAGGED | TST-CORE-437 | PENDING | TestTransport_7_3_2_ResolveUnknownDIDFails | core/test/transport_test.go |
| 1726 | TAGGED | TST-CORE-815 | PENDING | TestTransport_7_3_3_ResolveAddedEndpoint | core/test/transport_test.go |
| 1727 | TAGGED | TST-CORE-816 | PENDING | TestTransport_7_3_4_ResolveUnknownDIDReturnsErrorAndIncrementsMiss | core/test/transport_test.go |
| 1728 | TAGGED | TST-CORE-818 | PENDING | TestTransport_7_4_1_EnvelopeContainsRequiredFields | core/test/transport_test.go |
| 1729 | TAGGED | TST-CORE-819 | PENDING | TestTransport_7_4_2_EnvelopeFromFieldIsDID | core/test/transport_test.go |
| 1730 | TAGGED | TST-CORE-820 | PENDING | TestTransport_7_4_3_EnvelopeMaxSize | core/test/transport_test.go |
| 1731 | TAGGED | TST-CORE-821 | PENDING | TestTransport_7_4_13_EnvelopeInvalidJSONRejected | core/test/transport_test.go |
| 1732 | TAGGED | TST-CORE-822 | PENDING | TestTransport_7_5_1_EnvelopeEncryptedInTransit | core/test/transport_test.go |
| 1733 | TAGGED | TST-CORE-823 | PENDING | TestTransport_7_5_2_EncryptDecryptRoundtrip | core/test/transport_test.go |
| 1734 | TAGGED | TST-CORE-824 | PENDING | TestTransport_7_5_3_WrongRecipientCannotDecrypt | core/test/transport_test.go |
| 1735 | TAGGED | TST-CORE-825 | PENDING | TestTransport_7_6_1_DirectDeliveryPreferred | core/test/transport_test.go |
| 1736 | TAGGED | TST-CORE-826 | PENDING | TestTransport_7_6_2_MsgBoxUsedWhenDirectFails | core/test/transport_test.go |
| 1737 | TAGGED | TST-CORE-827 | PENDING | TestTransport_7_6_3_MockSendError | core/test/transport_test.go |
| 1738 | TAGGED | TST-CORE-809 | PENDING | TestTransport_7_1_6_OutboxEnqueuePersistsMessage | core/test/transport_test.go |
| 1739 | TAGGED | TST-CORE-396 | PENDING | TestTransport_7_1_7_SuccessfulDeliveryMarked | core/test/transport_test.go |
| 1740 | TAGGED | TST-CORE-397 | PENDING | TestTransport_7_1_8_DeliveryFailureRetry | core/test/transport_test.go |
| 1741 | TAGGED | TST-CORE-398 | PENDING | TestTransport_7_1_9_MaxRetriesExhaustedNudge | core/test/transport_test.go |
| 1742 | TAGGED | TST-CORE-399 | PENDING | TestTransport_7_1_10_UserRequeueAfterFailure | core/test/transport_test.go |
| 1743 | TAGGED | TST-CORE-400 | PENDING | TestTransport_7_1_11_TTL24Hours | core/test/transport_test.go |
| 1744 | TAGGED | TST-CORE-401 | PENDING | TestTransport_7_1_12_QueueSizeLimit100 | core/test/transport_test.go |
| 1745 | TAGGED | TST-CORE-402 | PENDING | TestTransport_7_1_13_OutboxEnqueueRetrieveRoundTrip | core/test/transport_test.go |
| 1746 | TAGGED | TST-CORE-404 | PENDING | TestTransport_7_1_14_IdempotentDelivery | core/test/transport_test.go |
| 1747 | TAGGED | TST-CORE-407 | PENDING | TestTransport_7_1_15_PriorityOrdering | core/test/transport_test.go |
| 1748 | TAGGED | TST-CORE-408 | PENDING | TestTransport_7_1_16_PayloadIsPreEncrypted | core/test/transport_test.go |
| 1749 | TAGGED | TST-CORE-409 | PENDING | TestTransport_7_1_17_SendingStatusDuringDelivery | core/test/transport_test.go |
| 1750 | TAGGED | TST-CORE-410 | PENDING | TestTransport_7_1_18_UserIgnoresNudgeExpires | core/test/transport_test.go |
| 1751 | TAGGED | TST-CORE-411 | PENDING | TestTransport_7_2_6_Valve1IPRateLimitExceeded | core/test/transport_test.go |
| 1752 | TAGGED | TST-CORE-412 | PENDING | TestTransport_7_2_7_Valve1NormalTraffic | core/test/transport_test.go |
| 1753 | TAGGED | TST-CORE-413 | PENDING | TestTransport_7_2_8_Valve1GlobalRateLimit | core/test/transport_test.go |
| 1754 | TAGGED | TST-CORE-414 | PENDING | TestTransport_7_2_9_Valve1PayloadCap256KB | core/test/transport_test.go |
| 1755 | TAGGED | TST-CORE-415 | PENDING | TestTransport_7_2_10_Valve1PayloadWithinCap | core/test/transport_test.go |
| 1756 | TAGGED | TST-CORE-416 | PENDING | TestTransport_7_2_11_Valve2SpoolWhenLocked | core/test/transport_test.go |
| 1757 | TAGGED | TST-CORE-417 | PENDING | TestTransport_7_2_12_Valve2SpoolCapExceeded | core/test/transport_test.go |
| 1758 | TAGGED | TST-CORE-418 | PENDING | TestTransport_7_2_13_Valve2RejectNewPreservesExisting | core/test/transport_test.go |
| 1759 | TAGGED | TST-CORE-419 | PENDING | TestTransport_7_2_14_Valve3SweeperOnUnlock | core/test/transport_test.go |
| 1760 | TAGGED | TST-CORE-422 | PENDING | TestTransport_7_2_15_Valve3TTLEnforcement | core/test/transport_test.go |
| 1761 | TAGGED | TST-CORE-423 | PENDING | TestTransport_7_2_16_Valve3MessageWithinTTL | core/test/transport_test.go |
| 1762 | TAGGED | TST-CORE-425 | PENDING | TestTransport_7_2_17_FastPathVaultUnlocked | core/test/transport_test.go |
| 1763 | TAGGED | TST-CORE-426 | PENDING | TestTransport_7_2_18_FastPathPerDIDRateLimit | core/test/transport_test.go |
| 1764 | TAGGED | TST-CORE-427 | PENDING | TestTransport_7_2_19_DeadDropPerDIDImpossibleWhenLocked | core/test/transport_test.go |
| 1765 | TAGGED | TST-CORE-428 | PENDING | TestTransport_7_2_20_DIDVerificationOnInbound | core/test/transport_test.go |
| 1766 | TAGGED | TST-CORE-429 | PENDING | TestTransport_7_2_21_DIDVerificationFailure | core/test/transport_test.go |
| 1767 | TAGGED | TST-CORE-430 | PENDING | TestTransport_7_2_22_UnknownSenderDID | core/test/transport_test.go |
| 1768 | TAGGED | TST-CORE-431 | PENDING | TestTransport_7_2_23_SpoolDirectoryIsSafe | core/test/transport_test.go |
| 1769 | TAGGED | TST-CORE-432 | PENDING | TestTransport_7_2_24_DoSWhileLocked | core/test/transport_test.go |
| 1770 | TAGGED | TST-CORE-433 | PENDING | TestTransport_7_2_25_DoSWhileUnlocked | core/test/transport_test.go |
| 1771 | TAGGED | TST-CORE-438 | PENDING | TestTransport_7_3_5_MalformedDIDValidationError | core/test/transport_test.go |
| 1772 | TAGGED | TST-CORE-435 | PENDING | TestTransport_7_3_6_DIDCacheHit | core/test/transport_test.go |
| 1773 | TAGGED | TST-CORE-436 | PENDING | TestTransport_7_3_7_DIDCacheExpiry | core/test/transport_test.go |
| 1774 | TAGGED | TST-CORE-817 | PENDING | TestTransport_7_3_8_UnresolvableDIDNotCached | core/test/transport_test.go |
| 1775 | TAGGED | TST-CORE-439 | PENDING | TestTransport_7_4_5_PlaintextStructure | core/test/transport_test.go |
| 1776 | TAGGED | TST-CORE-440 | PENDING | TestTransport_7_4_6_MessageIDFormat | core/test/transport_test.go |
| 1777 | TAGGED | TST-CORE-443 | PENDING | TestTransport_7_4_7_MessageCategories | core/test/transport_test.go |
| 1778 | TAGGED | TST-CORE-444 | PENDING | TestTransport_7_4_8_UnknownMessageTypeAccepted | core/test/transport_test.go |
| 1779 | TAGGED | TST-CORE-441 | PENDING | TestTransport_7_4_9_EnvelopeFormat | core/test/transport_test.go |
| 1780 | TAGGED | TST-CORE-448 | PENDING | TestTransport_7_5_4_FullConnectionFlow | core/test/transport_test.go |
| 1781 | TAGGED | TST-CORE-449 | PENDING | TestTransport_7_5_5_MutualAuthentication | core/test/transport_test.go |
| 1782 | TAGGED | TST-CORE-450 | PENDING | TestTransport_7_5_6_ContactAllowlistCheck | core/test/transport_test.go |
| 1783 | TAGGED | TST-CORE-451 | PENDING | TestTransport_7_5_7_EndpointFromDIDDocument | core/test/transport_test.go |
| 1784 | TAGGED | TST-CORE-452 | PENDING | TestTransport_7_6_4_MsgBoxForwardEnvelope | core/test/transport_test.go |
| 1785 | TAGGED | TST-CORE-453 | PENDING | TestTransport_7_6_5_MsgBoxCannotReadContent | core/test/transport_test.go |
| 1786 | TAGGED | TST-CORE-454 | PENDING | TestTransport_7_6_6_DIDDocumentPointsToMsgBox | core/test/transport_test.go |
| 1787 | TAGGED | TST-CORE-455 | PENDING | TestTransport_7_6_7_UserCanSwitchMsgBox | core/test/transport_test.go |
| 1788 | TAGGED | TST-CORE-403 | PENDING | TestTransport_7_1_19_SchedulerInterval30s | core/test/transport_test.go |
| 1789 | TAGGED | TST-CORE-405 | PENDING | TestTransport_7_1_20_DeliveredMessagesCleanup | core/test/transport_test.go |
| 1790 | TAGGED | TST-CORE-406 | PENDING | TestTransport_7_1_21_FailedMessagesCleanup | core/test/transport_test.go |
| 1791 | TAGGED | TST-CORE-420 | PENDING | TestTransport_7_2_26_SweeperDecryptsChecksDID | core/test/transport_test.go |
| 1792 | TAGGED | TST-CORE-421 | PENDING | TestTransport_7_2_27_SweeperBlocklistFeedback | core/test/transport_test.go |
| 1793 | TAGGED | TST-CORE-424 | PENDING | TestTransport_7_2_28_Valve3BlobCleanup | core/test/transport_test.go |
| 1794 | TAGGED | TST-CORE-442 | PENDING | TestTransport_7_4_10_Ed25519SignatureOnPlaintext | core/test/transport_test.go |
| 1795 | TAGGED | TST-CORE-445 | PENDING | TestTransport_7_4_11_EphemeralKeyPerMessage | core/test/transport_test.go |
| 1796 | TAGGED | TST-CORE-447 | PENDING | TestTransport_7_4_12_PhaseMigrationInvariant | core/test/transport_test.go |
| 1797 | TAGGED | TST-CORE-894 | PENDING | TestTransport_7_5_OutboxRetryBackoffIncludesJitter | core/test/transport_test.go |
| 1798 | TAGGED | TST-CORE-930 | PENDING | TestTransport_7_6_MessageCategoryNamespaceValidation | core/test/transport_test.go |
| 1799 | TAGGED | TST-CORE-442 | PENDING | TestTransport_7_4_4_Ed25519SignatureOnPlaintext | core/test/transport_test.go |
| 1800 | PENDING | -- | PENDING | TestTransport_30_11_2_DIDResolutionEndpointVerification | core/test/transport_test.go |
| 1801 | PENDING | -- | PENDING | TestTransport_30_11_2_DIDResolutionEndpointVerification/resolve_did_returns_correct_service_endpoint | core/test/transport_test.go |
| 1802 | PENDING | -- | PENDING | TestTransport_30_11_2_DIDResolutionEndpointVerification/cache_serves_resolved_did_without_refetch | core/test/transport_test.go |
| 1803 | PENDING | -- | PENDING | TestTransport_30_11_2_DIDResolutionEndpointVerification/cache_ttl_expiration_triggers_refetch | core/test/transport_test.go |
| 1804 | PENDING | -- | PENDING | TestTransport_30_11_2_DIDResolutionEndpointVerification/invalid_did_format_rejected_before_fetch | core/test/transport_test.go |
| 1805 | PENDING | -- | PENDING | TestTransport_30_11_2_DIDResolutionEndpointVerification/unknown_did_without_fetcher_returns_error | core/test/transport_test.go |
| 1806 | PENDING | -- | PENDING | TestTransport_30_11_2_DIDResolutionEndpointVerification/fetcher_error_not_cached | core/test/transport_test.go |
| 1807 | PENDING | -- | PENDING | TestTransport_30_11_2_DIDResolutionEndpointVerification/cache_invalidation_forces_refetch | core/test/transport_test.go |
| 1808 | PENDING | -- | PENDING | TestTransport_30_11_2_DIDResolutionEndpointVerification/multiple_dids_resolve_to_different_endpoints | core/test/transport_test.go |
| 1809 | PENDING | -- | PENDING | TestTransport_30_11_2_DIDResolutionEndpointVerification/did_document_missing_service_array_rejected | core/test/transport_test.go |
| 1810 | PENDING | -- | PENDING | TestTransport_30_11_2_DIDResolutionEndpointVerification/did_document_empty_service_endpoint_rejected | core/test/transport_test.go |
| 1811 | PENDING | -- | PENDING | TestTransport_30_11_2_DIDResolutionEndpointVerification/cache_stats_track_hits_and_misses | core/test/transport_test.go |
| 1812 | PENDING | -- | PENDING | TestGatekeeper_6_CacheUpsertAndLookup | core/test/trust_test.go |
| 1813 | PENDING | -- | PENDING | TestGatekeeper_6_CacheLookupNotFound | core/test/trust_test.go |
| 1814 | PENDING | -- | PENDING | TestGatekeeper_6_CacheList | core/test/trust_test.go |
| 1815 | PENDING | -- | PENDING | TestGatekeeper_6_CacheRemove | core/test/trust_test.go |
| 1816 | PENDING | -- | PENDING | TestGatekeeper_6_CacheUpsertOverwrites | core/test/trust_test.go |
| 1817 | PENDING | -- | PENDING | TestGatekeeper_6_CacheStats | core/test/trust_test.go |
| 1818 | PENDING | -- | PENDING | TestGatekeeper_6_IngressBlockedContactDrop | core/test/trust_test.go |
| 1819 | PENDING | -- | PENDING | TestGatekeeper_6_IngressTrustedContactAccept | core/test/trust_test.go |
| 1820 | PENDING | -- | PENDING | TestGatekeeper_6_IngressVerifiedContactAccept | core/test/trust_test.go |
| 1821 | PENDING | -- | PENDING | TestGatekeeper_6_IngressHighScoreCacheQuarantineV1 | core/test/trust_test.go |
| 1822 | PENDING | -- | PENDING | TestGatekeeper_6_IngressLowScoreCacheQuarantine | core/test/trust_test.go |
| 1823 | PENDING | -- | PENDING | TestGatekeeper_6_IngressUnknownDIDQuarantine | core/test/trust_test.go |
| 1824 | PENDING | -- | PENDING | TestGatekeeper_6_IngressEmptyDIDQuarantine | core/test/trust_test.go |
| 1825 | PENDING | -- | PENDING | TestGatekeeper_6_IngressBoundaryScoreQuarantineV1 | core/test/trust_test.go |
| 1826 | PENDING | -- | PENDING | TestGatekeeper_6_IngressJustBelowBoundaryQuarantineV1 | core/test/trust_test.go |
| 1827 | PENDING | -- | PENDING | TestGatekeeper_6_IngressBlockedOverridesCache | core/test/trust_test.go |
| 1828 | PENDING | -- | PENDING | TestGatekeeper_6_IngressTrustedOverridesLowCache | core/test/trust_test.go |
| 1829 | PENDING | -- | PENDING | TestGatekeeper_6_ResolverNoAppViewReturnsNil | core/test/trust_test.go |
| 1830 | PENDING | -- | PENDING | TestGatekeeper_6_DomainValidRings | core/test/trust_test.go |
| 1831 | PENDING | -- | PENDING | TestGatekeeper_6_DomainValidRelationships | core/test/trust_test.go |
| 1832 | PENDING | -- | PENDING | TestGatekeeper_6_DomainIngressDecisionConstants | core/test/trust_test.go |
| 1833 | TAGGED | TST-CORE-196 | PENDING | TestVault_4_1_1_CreateNewVault | core/test/vault_test.go |
| 1834 | TAGGED | TST-CORE-197 | PENDING | TestVault_4_1_2_OpenExistingVault | core/test/vault_test.go |
| 1835 | TAGGED | TST-CORE-198 | PENDING | TestVault_4_1_3_OpenWithWrongDEK | core/test/vault_test.go |
| 1836 | TAGGED | TST-CORE-199 | PENDING | TestVault_4_1_4_SchemaMigration | core/test/vault_test.go |
| 1837 | TAGGED | TST-CORE-200 | PENDING | TestVault_4_1_5_ConcurrentAccess | core/test/vault_test.go |
| 1838 | TAGGED | TST-CORE-201 | PENDING | TestVault_4_1_6_PRAGMAsEnforced | core/test/vault_test.go |
| 1839 | TAGGED | TST-CORE-202 | PENDING | TestVault_4_1_7_WALCrashRecovery | core/test/vault_test.go |
| 1840 | TAGGED | TST-CORE-203 | PENDING | TestVault_4_1_8_SynchronousNormalInWAL | core/test/vault_test.go |
| 1841 | TAGGED | TST-CORE-204 | PENDING | TestVault_4_1_9_ForeignKeysEnforced | core/test/vault_test.go |
| 1842 | TAGGED | TST-CORE-205 | PENDING | TestVault_4_1_10_BusyTimeout5000 | core/test/vault_test.go |
| 1843 | TAGGED | TST-CORE-206 | PENDING | TestVault_4_1_1_1_VaultManagerStructure | core/test/vault_test.go |
| 1844 | TAGGED | TST-CORE-207 | PENDING | TestVault_4_1_1_2_SingleWriterSerialization | core/test/vault_test.go |
| 1845 | TAGGED | TST-CORE-208 | PENDING | TestVault_4_1_1_3_ReadPoolMultipleReaders | core/test/vault_test.go |
| 1846 | TAGGED | TST-CORE-209 | PENDING | TestVault_4_1_1_4_ReadConnectionQueryOnly | core/test/vault_test.go |
| 1847 | TAGGED | TST-CORE-210 | PENDING | TestVault_4_1_1_5_WriteAutocheckpoint | core/test/vault_test.go |
| 1848 | TAGGED | TST-CORE-211 | PENDING | TestVault_4_1_1_6_CrossPersonaWriteIndependence | core/test/vault_test.go |
| 1849 | TAGGED | TST-CORE-212 | PENDING | TestVault_4_1_1_7_ConcurrentReadersDuringWrite | core/test/vault_test.go |
| 1850 | TAGGED | TST-CORE-213 | PENDING | TestVault_4_2_1_StoreItem | core/test/vault_test.go |
| 1851 | TAGGED | TST-CORE-214 | PENDING | TestVault_4_2_2_RetrieveByID | core/test/vault_test.go |
| 1852 | TAGGED | TST-CORE-215 | PENDING | TestVault_4_2_3_RetrieveNonExistent | core/test/vault_test.go |
| 1853 | TAGGED | TST-CORE-216 | PENDING | TestVault_4_2_4_UpdateItem | core/test/vault_test.go |
| 1854 | TAGGED | TST-CORE-217 | PENDING | TestVault_4_2_5_DeleteItem | core/test/vault_test.go |
| 1855 | TAGGED | TST-CORE-218 | PENDING | TestVault_4_2_6_ListByCategory | core/test/vault_test.go |
| 1856 | TAGGED | TST-CORE-219 | PENDING | TestVault_4_2_7_Pagination | core/test/vault_test.go |
| 1857 | TAGGED | TST-CORE-220 | PENDING | TestVault_4_2_8_ItemSizeLimit | core/test/vault_test.go |
| 1858 | TAGGED | TST-CORE-248 | PENDING | TestVault_4_3_1_FTS5KeywordSearch | core/test/vault_test.go |
| 1859 | TAGGED | TST-CORE-249 | PENDING | TestVault_4_3_2_SemanticVectorSearch | core/test/vault_test.go |
| 1860 | TAGGED | TST-CORE-250 | PENDING | TestVault_4_3_3_HybridSearch | core/test/vault_test.go |
| 1861 | TAGGED | TST-CORE-251 | PENDING | TestVault_4_3_HybridSearchFormulaVerified | core/test/vault_test.go |
| 1862 | TAGGED | TST-CORE-252 | PENDING | TestVault_4_3_4_EmptyResults | core/test/vault_test.go |
| 1863 | TAGGED | TST-CORE-253 | PENDING | TestVault_4_3_5_CrossPersonaBoundary | core/test/vault_test.go |
| 1864 | TAGGED | TST-CORE-254 | PENDING | TestVault_4_3_6_FTS5Injection | core/test/vault_test.go |
| 1865 | TAGGED | TST-CORE-255 | PENDING | TestVault_4_3_7_IncludeContentFalseDefault | core/test/vault_test.go |
| 1866 | TAGGED | TST-CORE-256 | PENDING | TestVault_4_3_8_IncludeContentTrue | core/test/vault_test.go |
| 1867 | TAGGED | TST-CORE-271 | PENDING | TestVault_4_4_1_WriteScratchpad | core/test/vault_test.go |
| 1868 | TAGGED | TST-CORE-272 | PENDING | TestVault_4_4_2_ReadScratchpad | core/test/vault_test.go |
| 1869 | TAGGED | TST-CORE-273 | PENDING | TestVault_4_4_3_Accumulation | core/test/vault_test.go |
| 1870 | TAGGED | TST-CORE-274 | PENDING | TestVault_4_4_4_ResumeFromExactStep | core/test/vault_test.go |
| 1871 | TAGGED | TST-CORE-275 | PENDING | TestVault_4_4_5_NoScratchpadStartFresh | core/test/vault_test.go |
| 1872 | TAGGED | TST-CORE-276 | PENDING | TestVault_4_4_6_TTLAutoExpire | core/test/vault_test.go |
| 1873 | TAGGED | TST-CORE-277 | PENDING | TestVault_4_4_7_DeleteOnCompletion | core/test/vault_test.go |
| 1874 | TAGGED | TST-CORE-278 | PENDING | TestVault_4_4_8_SizeLimit | core/test/vault_test.go |
| 1875 | TAGGED | TST-CORE-279 | PENDING | TestVault_4_4_9_StoredInIdentitySQLite | core/test/vault_test.go |
| 1876 | TAGGED | TST-CORE-280 | PENDING | TestVault_4_4_10_MultipleConcurrentScratchpads | core/test/vault_test.go |
| 1877 | TAGGED | TST-CORE-281 | PENDING | TestVault_4_4_11_OverwriteSameTaskLaterStep | core/test/vault_test.go |
| 1878 | TAGGED | TST-CORE-282 | PENDING | TestVault_4_5_1_StageItemForReview | core/test/vault_test.go |
| 1879 | TAGGED | TST-CORE-283 | PENDING | TestVault_4_5_2_ApprovePromotesToVault | core/test/vault_test.go |
| 1880 | TAGGED | TST-CORE-284 | PENDING | TestVault_4_5_3_RejectDeletesItem | core/test/vault_test.go |
| 1881 | TAGGED | TST-CORE-285 | PENDING | TestVault_4_5_4_AutoApproveLowRisk | core/test/vault_test.go |
| 1882 | TAGGED | TST-CORE-286 | PENDING | TestVault_4_5_5_PerItemExpiryAndSweep | core/test/vault_test.go |
| 1883 | TAGGED | TST-CORE-287 | PENDING | TestVault_4_5_6_StagingEncryptedAtRest | core/test/vault_test.go |
| 1884 | TAGGED | TST-CORE-288 | PENDING | TestVault_4_5_7_StagingNotBackedUp | core/test/vault_test.go |
| 1885 | TAGGED | TST-CORE-289 | PENDING | TestVault_4_5_8_DraftDontSendInStaging | core/test/vault_test.go |
| 1886 | TAGGED | TST-CORE-290 | PENDING | TestVault_4_5_9_CartHandoverInStaging | core/test/vault_test.go |
| 1887 | TAGGED | TST-CORE-291 | PENDING | TestVault_4_5_10_StagingItemsPerPersona | core/test/vault_test.go |
| 1888 | TAGGED | TST-CORE-292 | PENDING | TestVault_4_5_11_SweeperSchedule | core/test/vault_test.go |
| 1889 | TAGGED | TST-CORE-293 | PENDING | TestVault_4_5_12_PerTypeTTL | core/test/vault_test.go |
| 1890 | TAGGED | TST-CORE-294 | PENDING | TestVault_4_6_1_OnlineBackup | core/test/vault_test.go |
| 1891 | TAGGED | TST-CORE-295 | PENDING | TestVault_4_6_2_BackupEncrypted | core/test/vault_test.go |
| 1892 | TAGGED | TST-CORE-296 | PENDING | TestVault_4_6_3_VACUUMINTOForbidden | core/test/vault_test.go |
| 1893 | TAGGED | TST-CORE-297 | PENDING | TestVault_4_6_4_BackupToDifferentLocation | core/test/vault_test.go |
| 1894 | TAGGED | TST-CORE-298 | PENDING | TestVault_4_6_5_RestoreFromBackup | core/test/vault_test.go |
| 1895 | TAGGED | TST-CORE-299 | PENDING | TestVault_4_6_6_CIPlaintextCheck | core/test/vault_test.go |
| 1896 | TAGGED | TST-CORE-300 | PENDING | TestVault_4_6_7_BackupScopeTier0Tier1Only | core/test/vault_test.go |
| 1897 | TAGGED | TST-CORE-301 | PENDING | TestVault_4_6_8_AutomatedBackupScheduling | core/test/vault_test.go |
| 1898 | TAGGED | TST-CORE-221 | PENDING | TestVault_4_2_1_1_ContactsTableNoPersonaField | core/test/vault_test.go |
| 1899 | TAGGED | TST-CORE-222 | PENDING | TestVault_4_2_1_2_ContactsTrustLevelEnum | core/test/vault_test.go |
| 1900 | TAGGED | TST-CORE-223 | PENDING | TestVault_4_2_1_3_ContactsSharingPolicyJSON | core/test/vault_test.go |
| 1901 | TAGGED | TST-CORE-224 | PENDING | TestVault_4_2_1_4_IdxContactsTrustExists | core/test/vault_test.go |
| 1902 | TAGGED | TST-CORE-225 | PENDING | TestVault_4_2_1_5_AuditLogTableSchema | core/test/vault_test.go |
| 1903 | TAGGED | TST-CORE-226 | PENDING | TestVault_4_2_1_6_KVStoreForSyncCursors | core/test/vault_test.go |
| 1904 | TAGGED | TST-CORE-227 | PENDING | TestVault_4_2_1_7_DeviceTokensSHA256Hash | core/test/vault_test.go |
| 1905 | TAGGED | TST-CORE-228 | PENDING | TestVault_4_2_1_8_DeviceTokensPartialIndex | core/test/vault_test.go |
| 1906 | TAGGED | TST-CORE-229 | PENDING | TestVault_4_2_1_9_CrashLogTableSchema | core/test/vault_test.go |
| 1907 | TAGGED | TST-CORE-230 | PENDING | TestVault_4_2_2_1_VaultItemsRequiredColumns | core/test/vault_test.go |
| 1908 | TAGGED | TST-CORE-231 | PENDING | TestVault_4_2_2_2_VaultItemsFTS5Table | core/test/vault_test.go |
| 1909 | TAGGED | TST-CORE-232 | PENDING | TestVault_4_2_2_3_FTS5TokenizerUnicode61 | core/test/vault_test.go |
| 1910 | TAGGED | TST-CORE-233 | PENDING | TestVault_4_2_2_4_PorterStemmerForbidden | core/test/vault_test.go |
| 1911 | TAGGED | TST-CORE-234 | PENDING | TestVault_4_2_2_5_FTS5EncryptedBySQLCipher | core/test/vault_test.go |
| 1912 | TAGGED | TST-CORE-235 | PENDING | TestVault_4_2_2_6_RelationshipsTable | core/test/vault_test.go |
| 1913 | TAGGED | TST-CORE-236 | PENDING | TestVault_4_2_2_7_VaultItemsTypeEnforced | core/test/vault_test.go |
| 1914 | TAGGED | TST-CORE-237 | PENDING | TestVault_4_2_2_8_RelationshipsEntityTypeEnforced | core/test/vault_test.go |
| 1915 | TAGGED | TST-CORE-238 | PENDING | TestVault_4_2_2_9_FTS5ContentSyncInsert | core/test/vault_test.go |
| 1916 | TAGGED | TST-CORE-239 | PENDING | TestVault_4_2_2_10_FTS5ContentSyncUpdate | core/test/vault_test.go |
| 1917 | TAGGED | TST-CORE-240 | PENDING | TestVault_4_2_2_11_FTS5ContentSyncDelete | core/test/vault_test.go |
| 1918 | TAGGED | TST-CORE-241 | PENDING | TestVault_4_2_2_12_SchemaVersionIdentity | core/test/vault_test.go |
| 1919 | TAGGED | TST-CORE-242 | PENDING | TestVault_4_2_2_13_SchemaVersionPersonaVault | core/test/vault_test.go |
| 1920 | TAGGED | TST-CORE-243 | PENDING | TestVault_4_2_3_1_BatchStore100Items | core/test/vault_test.go |
| 1921 | TAGGED | TST-CORE-244 | PENDING | TestVault_4_2_3_2_BatchPerformance | core/test/vault_test.go |
| 1922 | TAGGED | TST-CORE-245 | PENDING | TestVault_4_2_3_3_BatchFailureRollback | core/test/vault_test.go |
| 1923 | TAGGED | TST-CORE-246 | PENDING | TestVault_4_2_3_4_BatchDuringConcurrentReads | core/test/vault_test.go |
| 1924 | TAGGED | TST-CORE-247 | PENDING | TestVault_4_2_3_5_BatchIngestionPlusEmbedding | core/test/vault_test.go |
| 1925 | TAGGED | TST-CORE-251 | PENDING | TestVault_4_3_4_HybridSearchFormulaVerified | core/test/vault_test.go |
| 1926 | TAGGED | TST-CORE-257 | PENDING | TestVault_4_3_10_FilterByTypes | core/test/vault_test.go |
| 1927 | TAGGED | TST-CORE-258 | PENDING | TestVault_4_3_11_FilterByTimeRange | core/test/vault_test.go |
| 1928 | TAGGED | TST-CORE-259 | PENDING | TestVault_4_3_12_LimitDefault20 | core/test/vault_test.go |
| 1929 | TAGGED | TST-CORE-260 | PENDING | TestVault_4_3_13_LimitMax100 | core/test/vault_test.go |
| 1930 | TAGGED | TST-CORE-261 | PENDING | TestVault_4_3_14_Pagination | core/test/vault_test.go |
| 1931 | TAGGED | TST-CORE-262 | PENDING | TestVault_4_3_15_LockedPersonaStructured403 | core/test/vault_test.go |
| 1932 | TAGGED | TST-CORE-263 | PENDING | TestVault_4_3_16_SimpleSearchFastPath | core/test/vault_test.go |
| 1933 | TAGGED | TST-CORE-264 | PENDING | TestVault_4_3_17_SemanticSearchBrainOrchestrates | core/test/vault_test.go |
| 1934 | TAGGED | TST-CORE-265 | PENDING | TestVault_4_3_1_1_EmbeddingModelTrackedInMetadata | core/test/vault_test.go |
| 1935 | TAGGED | TST-CORE-266 | PENDING | TestVault_4_3_1_2_ModelChangeDetected | core/test/vault_test.go |
| 1936 | TAGGED | TST-CORE-267 | PENDING | TestVault_4_3_1_3_ReindexTriggered | core/test/vault_test.go |
| 1937 | TAGGED | TST-CORE-268 | PENDING | TestVault_4_3_1_4_FTS5AvailableDuringReindexing | core/test/vault_test.go |
| 1938 | TAGGED | TST-CORE-269 | PENDING | TestVault_4_3_1_5_ReembedCompletes | core/test/vault_test.go |
| 1939 | TAGGED | TST-CORE-270 | PENDING | TestVault_4_3_1_6_NoDualIndex | core/test/vault_test.go |
| 1940 | TAGGED | TST-CORE-302 | PENDING | TestVault_4_6_1_1_EncryptedBackupBeforeMigration | core/test/vault_test.go |
| 1941 | TAGGED | TST-CORE-303 | PENDING | TestVault_4_6_1_2_IntegrityCheckAfterMigration | core/test/vault_test.go |
| 1942 | TAGGED | TST-CORE-304 | PENDING | TestVault_4_6_1_3_IntegrityOkCommit | core/test/vault_test.go |
| 1943 | TAGGED | TST-CORE-305 | PENDING | TestVault_4_6_1_4_IntegrityFailRollbackRestore | core/test/vault_test.go |
| 1944 | TAGGED | TST-CORE-306 | PENDING | TestVault_4_6_1_5_PreFlightBackupPath | core/test/vault_test.go |
| 1945 | TAGGED | TST-CORE-307 | PENDING | TestVault_4_6_1_6_AutomaticOnCoreUpdate | core/test/vault_test.go |
| 1946 | TAGGED | TST-CORE-308 | PENDING | TestVault_4_7_1_AppendAuditEntry | core/test/vault_test.go |
| 1947 | TAGGED | TST-CORE-309 | PENDING | TestVault_4_7_2_AppendOnlyEnforcement | core/test/vault_test.go |
| 1948 | TAGGED | TST-CORE-310 | PENDING | TestVault_4_7_3_AuditLogRotation | core/test/vault_test.go |
| 1949 | TAGGED | TST-CORE-311 | PENDING | TestVault_4_7_4_QueryAuditLog | core/test/vault_test.go |
| 1950 | TAGGED | TST-CORE-312 | PENDING | TestVault_4_7_5_AuditLogIntegrityHashChain | core/test/vault_test.go |
| 1951 | TAGGED | TST-CORE-313 | PENDING | TestVault_4_7_6_AuditLogJSONFormat | core/test/vault_test.go |
| 1952 | TAGGED | TST-CORE-314 | PENDING | TestVault_4_7_7_RetentionConfigurable | core/test/vault_test.go |
| 1953 | TAGGED | TST-CORE-315 | PENDING | TestVault_4_7_8_WatchdogDailyCleanup | core/test/vault_test.go |
| 1954 | TAGGED | TST-CORE-316 | PENDING | TestVault_4_7_9_RawEntriesForForensics | core/test/vault_test.go |
| 1955 | TAGGED | TST-CORE-317 | PENDING | TestVault_4_7_10_AuditLogStoredInIdentitySQLite | core/test/vault_test.go |
| 1956 | TAGGED | TST-CORE-318 | PENDING | TestVault_4_7_11_StorageGrowthBounded | core/test/vault_test.go |
| 1957 | TAGGED | TST-CORE-319 | PENDING | TestVault_4_7_12_CrashLog90DayRetention | core/test/vault_test.go |
| 1958 | TAGGED | TST-CORE-320 | PENDING | TestVault_4_8_1_SecurityModeBootFullSequence | core/test/vault_test.go |
| 1959 | TAGGED | TST-CORE-321 | PENDING | TestVault_4_8_2_ConvenienceModeBootFullSequence | core/test/vault_test.go |
| 1960 | TAGGED | TST-CORE-322 | PENDING | TestVault_4_8_3_BootOpensIdentityFirst | core/test/vault_test.go |
| 1961 | TAGGED | TST-CORE-323 | PENDING | TestVault_4_8_4_BootOpensPersonalSecond | core/test/vault_test.go |
| 1962 | TAGGED | TST-CORE-324 | PENDING | TestVault_4_8_5_OtherPersonasRemainClosedAtBoot | core/test/vault_test.go |
| 1963 | TAGGED | TST-CORE-325 | PENDING | TestVault_4_8_6_DEKsNotDerivedForClosedPersonas | core/test/vault_test.go |
| 1964 | TAGGED | TST-CORE-326 | PENDING | TestVault_4_8_7_BrainNotifiedOnVaultUnlock | core/test/vault_test.go |
| 1965 | TAGGED | TST-CORE-327 | PENDING | TestVault_4_8_8_HKDFInfoStringsCorrectIdentity | core/test/vault_test.go |
| 1966 | TAGGED | TST-CORE-328 | PENDING | TestVault_4_8_9_HKDFInfoStringsPerPersona | core/test/vault_test.go |
| 1967 | TAGGED | TST-CORE-329 | PENDING | TestVault_4_8_10_SQLCipherPRAGMAsEnforced | core/test/vault_test.go |
| 1968 | TAGGED | TST-CORE-330 | PENDING | TestVault_4_8_11_ModeStoredInConfig | core/test/vault_test.go |
| 1969 | TAGGED | TST-CORE-331 | PENDING | TestVault_4_8_12_ModeChangeableAtRuntime | core/test/vault_test.go |
| 1970 | TAGGED | TST-CORE-332 | PENDING | TestVault_4_8_13_DefaultModeManagedConvenience | core/test/vault_test.go |
| 1971 | TAGGED | TST-CORE-333 | PENDING | TestVault_4_8_14_DefaultModeSelfHostedSecurity | core/test/vault_test.go |
| 1972 | TAGGED | TST-CORE-334 | PENDING | TestVault_4_8_15_SecurityModeWrongPassphraseVaultStaysLocked | core/test/vault_test.go |
| 1973 | TAGGED | TST-CORE-335 | PENDING | TestVault_4_8_16_ConvenienceModeKeyfileMissingError | core/test/vault_test.go |
| 1974 | TAGGED | TST-CORE-336 | PENDING | TestVault_4_8_17_ConvenienceModeKeyfileWrongPermissions | core/test/vault_test.go |
| 1975 | TAGGED | TST-CORE-337 | PENDING | TestVault_4_8_18_ConfigMissingGracefulDefault | core/test/vault_test.go |
| 1976 | TAGGED | TST-CORE-338 | PENDING | TestVault_4_8_19_ConfigInvalidModeValue | core/test/vault_test.go |
| 1977 | TAGGED | TST-CORE-339 | PENDING | TestVault_4_8_20_SecurityModeWrappedSeedPath | core/test/vault_test.go |
| 1978 | TAGGED | TST-CORE-340 | PENDING | TestVault_4_8_21_MasterSeedNeverPlaintextInSecurityMode | core/test/vault_test.go |
| 1979 | TAGGED | TST-CORE-341 | PENDING | TestVault_4_8_22_ConvenienceModeKeyfilePath | core/test/vault_test.go |
| 1980 | TAGGED | TST-CORE-342 | PENDING | TestVault_4_8_23_ModeSwitchSecurityToConvenience | core/test/vault_test.go |
| 1981 | TAGGED | TST-CORE-883 | PENDING | TestVault_4_9_FTS5WithIndicScripts | core/test/vault_test.go |
| 1982 | TAGGED | TST-CORE-884 | PENDING | TestVault_4_9_2_UsesSqliteVecNotVSS | core/test/vault_test.go |
| 1983 | TAGGED | TST-CORE-885 | PENDING | TestVault_4_9_3_FTS5AvailableDuringReindex | core/test/vault_test.go |
| 1984 | TAGGED | TST-CORE-1141 | PENDING | TestVault_36_1_4_ApprovalExpiresIfNotActedOn | core/test/vault_test.go |
| 1985 | PENDING | -- | PENDING | TestVault_36_1_4_ApprovalExpiresIfNotActedOn/expired_item_swept_then_approve_fails | core/test/vault_test.go |
| 1986 | PENDING | -- | PENDING | TestVault_36_1_4_ApprovalExpiresIfNotActedOn/non_expired_survives_sweep_and_approves | core/test/vault_test.go |
| 1987 | PENDING | -- | PENDING | TestVault_36_1_4_ApprovalExpiresIfNotActedOn/selective_sweep_mixed_expiry | core/test/vault_test.go |
| 1988 | PENDING | -- | PENDING | TestVault_36_1_4_ApprovalExpiresIfNotActedOn/double_sweep_returns_zero | core/test/vault_test.go |
| 1989 | PENDING | -- | PENDING | TestVault_36_1_4_ApprovalExpiresIfNotActedOn/reject_still_works_before_expiry | core/test/vault_test.go |
| 1990 | TAGGED | TST-CORE-1139 | PENDING | TestVault_36_1_2_StagingItemCannotBeExecutedWithoutUserApproval | core/test/vault_test.go |
| 1991 | PENDING | -- | PENDING | TestVault_36_1_2_StagingItemCannotBeExecutedWithoutUserApproval/unapproved_item_not_in_vault | core/test/vault_test.go |
| 1992 | PENDING | -- | PENDING | TestVault_36_1_2_StagingItemCannotBeExecutedWithoutUserApproval/approved_item_promoted_to_vault | core/test/vault_test.go |
| 1993 | PENDING | -- | PENDING | TestVault_36_1_2_StagingItemCannotBeExecutedWithoutUserApproval/rejected_item_never_reaches_vault | core/test/vault_test.go |
| 1994 | PENDING | -- | PENDING | TestVault_36_1_2_StagingItemCannotBeExecutedWithoutUserApproval/selective_approval_only_approved_items_in_vault | core/test/vault_test.go |
| 1995 | PENDING | -- | PENDING | TestVault_36_1_2_StagingItemCannotBeExecutedWithoutUserApproval/double_approval_fails | core/test/vault_test.go |
| 1996 | TAGGED | TST-CORE-1143 | PENDING | TestVault_36_1_6_CartHandoverNoPaymentCredentialsStored | core/test/vault_test.go |
| 1997 | PENDING | -- | PENDING | TestVault_36_1_6_CartHandoverNoPaymentCredentialsStored/cart_handover_items_contain_no_credentials | core/test/vault_test.go |
| 1998 | PENDING | -- | PENDING | TestVault_36_1_6_CartHandoverNoPaymentCredentialsStored/positive_control_credential_detection_works | core/test/vault_test.go |
| 1999 | PENDING | -- | PENDING | TestVault_36_1_6_CartHandoverNoPaymentCredentialsStored/metadata_json_inspected_for_hidden_credentials | core/test/vault_test.go |
| 2000 | PENDING | -- | PENDING | TestVault_36_1_6_CartHandoverNoPaymentCredentialsStored/staged_cart_handover_approved_remains_clean | core/test/vault_test.go |
| 2001 | TAGGED | TST-CORE-1119 | PENDING | TestVault_34_1_1_DeepLinkPreservedThroughVaultStoreRetrieveCycle | core/test/vault_test.go |
| 2002 | PENDING | -- | PENDING | TestVault_34_1_1_DeepLinkPreservedThroughVaultStoreRetrieveCycle/deep_link_url_preserved_on_retrieval | core/test/vault_test.go |
| 2003 | PENDING | -- | PENDING | TestVault_34_1_1_DeepLinkPreservedThroughVaultStoreRetrieveCycle/provenance_fields_preserved | core/test/vault_test.go |
| 2004 | PENDING | -- | PENDING | TestVault_34_1_1_DeepLinkPreservedThroughVaultStoreRetrieveCycle/multiple_items_independent_deep_links | core/test/vault_test.go |
| 2005 | PENDING | -- | PENDING | TestVault_34_1_1_DeepLinkPreservedThroughVaultStoreRetrieveCycle/deep_link_with_special_characters_preserved | core/test/vault_test.go |
| 2006 | TAGGED | TST-CORE-1120 | PENDING | TestVault_34_1_2_VaultItemProvenanceChainImmutableAfterStorage | core/test/vault_test.go |
| 2007 | PENDING | -- | PENDING | TestVault_34_1_2_VaultItemProvenanceChainImmutableAfterStorage/provenance_immutable_after_store | core/test/vault_test.go |
| 2008 | PENDING | -- | PENDING | TestVault_34_1_2_VaultItemProvenanceChainImmutableAfterStorage/storing_second_item_does_not_alter_first | core/test/vault_test.go |
| 2009 | PENDING | -- | PENDING | TestVault_34_1_2_VaultItemProvenanceChainImmutableAfterStorage/delete_and_restore_creates_new_item | core/test/vault_test.go |
| 2010 | PENDING | -- | PENDING | TestVault_34_1_2_VaultItemProvenanceChainImmutableAfterStorage/batch_store_preserves_independent_provenance | core/test/vault_test.go |
| 2011 | TAGGED | TST-CORE-1142 | PENDING | TestVault_36_1_5_BatchApprovalsRequireIndividualConsent | core/test/vault_test.go |
| 2012 | PENDING | -- | PENDING | TestVault_36_1_5_BatchApprovalsRequireIndividualConsent/ten_items_require_individual_approval | core/test/vault_test.go |
| 2013 | PENDING | -- | PENDING | TestVault_36_1_5_BatchApprovalsRequireIndividualConsent/mixed_approve_reject_independent | core/test/vault_test.go |
| 2014 | PENDING | -- | PENDING | TestVault_36_1_5_BatchApprovalsRequireIndividualConsent/rejected_items_cannot_be_approved_later | core/test/vault_test.go |
| 2015 | PENDING | -- | PENDING | TestVault_36_1_5_BatchApprovalsRequireIndividualConsent/approval_order_independent | core/test/vault_test.go |
| 2016 | TAGGED | TST-CORE-1117 | PENDING | TestVault_34_1_3_BotResponseWithSponsoredContentTagged | core/test/vault_test.go |
| 2017 | PENDING | -- | PENDING | TestVault_34_1_3_BotResponseWithSponsoredContentTagged/sponsored_metadata_preserved_in_vault | core/test/vault_test.go |
| 2018 | PENDING | -- | PENDING | TestVault_34_1_3_BotResponseWithSponsoredContentTagged/unsponsored_explicitly_tagged_false | core/test/vault_test.go |
| 2019 | PENDING | -- | PENDING | TestVault_34_1_3_BotResponseWithSponsoredContentTagged/positive_control_sponsored_vs_unsponsored_distinguishable | core/test/vault_test.go |
| 2020 | PENDING | -- | PENDING | TestVault_34_1_3_BotResponseWithSponsoredContentTagged/multiple_sponsors_preserved_independently | core/test/vault_test.go |
| 2021 | PENDING | -- | PENDING | TestVault_34_1_3_BotResponseWithSponsoredContentTagged/sponsored_metadata_survives_staging_cycle | core/test/vault_test.go |
| 2022 | TAGGED | TST-CORE-1138 | PENDING | TestVault_36_1_8_StagingItemsAutoExpireAfterTTL | core/test/vault_test.go |
| 2023 | PENDING | -- | PENDING | TestVault_36_1_8_StagingItemsAutoExpireAfterTTL/zero_TTL_items_never_expire | core/test/vault_test.go |
| 2024 | PENDING | -- | PENDING | TestVault_36_1_8_StagingItemsAutoExpireAfterTTL/expired_items_truly_gone_approve_and_reject_fail | core/test/vault_test.go |
| 2025 | PENDING | -- | PENDING | TestVault_36_1_8_StagingItemsAutoExpireAfterTTL/positive_control_future_TTL_survives_and_operates | core/test/vault_test.go |
| 2026 | PENDING | -- | PENDING | TestVault_36_1_8_StagingItemsAutoExpireAfterTTL/multi_TTL_independent_expiry | core/test/vault_test.go |
| 2027 | PENDING | -- | PENDING | TestVault_36_1_8_StagingItemsAutoExpireAfterTTL/sweep_count_accuracy_across_TTL_tiers | core/test/vault_test.go |
| 2028 | TAGGED | TST-CORE-1140 | PENDING | TestVault_36_1_10_ApprovalTokenSingleUse | core/test/vault_test.go |
| 2029 | PENDING | -- | PENDING | TestVault_36_1_10_ApprovalTokenSingleUse/approve_consumes_token_second_approve_fails | core/test/vault_test.go |
| 2030 | PENDING | -- | PENDING | TestVault_36_1_10_ApprovalTokenSingleUse/reject_removes_token_approve_after_reject_fails | core/test/vault_test.go |
| 2031 | PENDING | -- | PENDING | TestVault_36_1_10_ApprovalTokenSingleUse/approve_consumes_token_item_only_promoted_once | core/test/vault_test.go |
| 2032 | PENDING | -- | PENDING | TestVault_36_1_10_ApprovalTokenSingleUse/reject_then_approve_fails_cross_operation | core/test/vault_test.go |
| 2033 | PENDING | -- | PENDING | TestVault_36_1_10_ApprovalTokenSingleUse/positive_control_fresh_IDs_work_independently | core/test/vault_test.go |
| 2034 | TAGGED | TST-CORE-1144 | PENDING | TestVault_34_1_7_SponsorshipHasZeroRankingWeight | core/test/vault_test.go |
| 2035 | PENDING | -- | PENDING | TestVault_34_1_7_SponsorshipHasZeroRankingWeight/identical_embeddings_rank_equally_regardless_of_sponsorship | core/test/vault_test.go |
| 2036 | PENDING | -- | PENDING | TestVault_34_1_7_SponsorshipHasZeroRankingWeight/positive_control_different_embeddings_rank_differently | core/test/vault_test.go |
| 2037 | PENDING | -- | PENDING | TestVault_34_1_7_SponsorshipHasZeroRankingWeight/FTS5_search_sponsorship_has_no_effect | core/test/vault_test.go |
| 2038 | PENDING | -- | PENDING | TestVault_34_1_7_SponsorshipHasZeroRankingWeight/multiple_sponsored_dont_cluster_above_unsponsored | core/test/vault_test.go |
| 2039 | TAGGED | TST-CORE-916 | PENDING | TestWatchdog_20_3_10_SystemTicker_1HourInterval | core/test/watchdog_test.go |
| 2040 | TAGGED | TST-CORE-915 | PENDING | TestWatchdog_20_3_9_SingleSweepCleansAuditAndCrashLogs | core/test/watchdog_test.go |
| 2041 | TAGGED | TST-CORE-914 | PENDING | TestWatchdog_20_3_8_ConnectorLiveness | core/test/watchdog_test.go |
| 2042 | TAGGED | TST-CORE-917 | PENDING | TestWatchdog_20_3_11_DiskUsageCheck | core/test/watchdog_test.go |
| 2043 | TAGGED | TST-CORE-482 | PENDING | TestWS_9_1_1_WSUpgradeAccepted | core/test/ws_test.go |
| 2044 | TAGGED | TST-CORE-483 | PENDING | TestWS_9_1_2_Ed25519AuthViaMarkAuthenticated | core/test/ws_test.go |
| 2045 | TAGGED | TST-CORE-484 | PENDING | TestWS_9_1_3_UnauthenticatedUpgradeRejected | core/test/ws_test.go |
| 2046 | TAGGED | TST-CORE-487 | PENDING | TestWS_9_1_6_PreAuthIdentityCarriesDeviceName | core/test/ws_test.go |
| 2047 | TAGGED | TST-CORE-488 | PENDING | TestWS_9_1_7_GracefulDisconnect | core/test/ws_test.go |
| 2048 | TAGGED | TST-CORE-489 | PENDING | TestWS_9_1_8_AbnormalDisconnect | core/test/ws_test.go |
| 2049 | TAGGED | TST-CORE-490 | PENDING | TestWS_9_2_1_QueryMessage | core/test/ws_test.go |
| 2050 | TAGGED | TST-CORE-491 | PENDING | TestWS_9_2_2_QueryWithPersonaField | core/test/ws_test.go |
| 2051 | TAGGED | TST-CORE-492 | PENDING | TestWS_9_2_3_CommandMessage | core/test/ws_test.go |
| 2052 | TAGGED | TST-CORE-493 | PENDING | TestWS_9_2_4_ACKMessage | core/test/ws_test.go |
| 2053 | TAGGED | TST-CORE-494 | PENDING | TestWS_9_2_5_PongMessage | core/test/ws_test.go |
| 2054 | TAGGED | TST-CORE-495 | PENDING | TestWS_9_2_6_MissingIDField | core/test/ws_test.go |
| 2055 | TAGGED | TST-CORE-496 | PENDING | TestWS_9_2_7_UnknownMessageType | core/test/ws_test.go |
| 2056 | TAGGED | TST-CORE-497 | PENDING | TestWS_9_3_1_WhisperStreamChunked | core/test/ws_test.go |
| 2057 | TAGGED | TST-CORE-498 | PENDING | TestWS_9_3_2_WhisperFinalResponse | core/test/ws_test.go |
| 2058 | TAGGED | TST-CORE-499 | PENDING | TestWS_9_3_3_ProactiveWhisper | core/test/ws_test.go |
| 2059 | TAGGED | TST-CORE-500 | PENDING | TestWS_9_3_4_SystemNotification | core/test/ws_test.go |
| 2060 | TAGGED | TST-CORE-501 | PENDING | TestWS_9_3_5_ErrorResponse | core/test/ws_test.go |
| 2061 | TAGGED | TST-CORE-502 | PENDING | TestWS_9_3_6_ReplyToMeansResponse | core/test/ws_test.go |
| 2062 | TAGGED | TST-CORE-503 | PENDING | TestWS_9_3_7_NoReplyToMeansProactive | core/test/ws_test.go |
| 2063 | TAGGED | TST-CORE-504 | PENDING | TestWS_9_3_8_WhisperStreamTerminatedByFinalWhisper | core/test/ws_test.go |
| 2064 | TAGGED | TST-CORE-505 | PENDING | TestWS_9_4_1_CoreSendsPingEvery30s | core/test/ws_test.go |
| 2065 | TAGGED | TST-CORE-506 | PENDING | TestWS_9_4_2_ClientRespondsWithPong | core/test/ws_test.go |
| 2066 | TAGGED | TST-CORE-507 | PENDING | TestWS_9_4_3_PongTimeout10Seconds | core/test/ws_test.go |
| 2067 | TAGGED | TST-CORE-508 | PENDING | TestWS_9_4_4_ThreeMissedPongsDisconnect | core/test/ws_test.go |
| 2068 | TAGGED | TST-CORE-509 | PENDING | TestWS_9_4_5_PongResetsCounter | core/test/ws_test.go |
| 2069 | TAGGED | TST-CORE-510 | PENDING | TestWS_9_4_6_PingIncludesTimestamp | core/test/ws_test.go |
| 2070 | TAGGED | TST-CORE-511 | PENDING | TestWS_9_5_1_ClientTemporarilyDisconnected | core/test/ws_test.go |
| 2071 | TAGGED | TST-CORE-512 | PENDING | TestWS_9_5_2_BufferCapMax50 | core/test/ws_test.go |
| 2072 | TAGGED | TST-CORE-513 | PENDING | TestWS_9_5_3_BufferOrderingPreserved | core/test/ws_test.go |
| 2073 | TAGGED | TST-CORE-514 | PENDING | TestWS_9_5_4_BufferTTL5Minutes | core/test/ws_test.go |
| 2074 | TAGGED | TST-CORE-515 | PENDING | TestWS_9_5_5_ClientACKsBufferedMessages | core/test/ws_test.go |
| 2075 | TAGGED | TST-CORE-516 | PENDING | TestWS_9_5_6_BufferPerDevice | core/test/ws_test.go |
| 2076 | TAGGED | TST-CORE-517 | PENDING | TestWS_9_5_7_BufferWithinTTLAllDelivered | core/test/ws_test.go |
| 2077 | TAGGED | TST-CORE-518 | PENDING | TestWS_9_5_8_WhyFiveMinNotLonger | core/test/ws_test.go |
| 2078 | TAGGED | TST-CORE-519 | PENDING | TestWS_9_5_9_ReconnectionRequiresReAuth | core/test/ws_test.go |
| 2079 | TAGGED | TST-CORE-911 | PENDING | TestWS_9_5_10_FCMWakeupPayloadEmpty | core/test/ws_test.go |
| 2080 | TAGGED | TST-CORE-912 | PENDING | TestWS_9_5_11_Ed25519AuthUpdatesTracking | core/test/ws_test.go |
| 2081 | TAGGED | TST-CORE-913 | PENDING | TestWS_9_5_12_DevicePushViaAuthenticatedWebSocket | core/test/ws_test.go |
| 2082 | PENDING | -- | PENDING | TestWS_9_6_1_PreAuthSkipsTokenHandshake | core/test/ws_test.go |
| 2083 | PENDING | -- | PENDING | TestWS_9_6_2_EmptyPreAuthRejected | core/test/ws_test.go |
| 2084 | PENDING | -- | PENDING | TestWS_9_6_3_SignedUpgradeThroughMiddleware | core/test/ws_test.go |
| 2085 | PENDING | -- | PENDING | TestWS_9_6_4_UnsignedUpgradeRejectedByMiddleware | core/test/ws_test.go |
| 2086 | PENDING | -- | PENDING | TestWS_9_6_5_BearerTokenUpgradeRejectedByAuthz | core/test/ws_test.go |
| 2087 | PENDING | -- | PENDING | TestIsHostAllowed | core/internal/adapter/transport/transport_test.go |
| 2088 | PENDING | -- | PENDING | TestPairing_10_RevokeDeviceMethodNotAllowed | core/internal/handler/device_test.go |
| 2089 | PENDING | -- | PENDING | TestIdentity_3_HandleVerifyValidSignature | core/internal/handler/identity_test.go |
| 2090 | PENDING | -- | PENDING | TestIdentity_3_HandleVerifyTamperedSignature | core/internal/handler/identity_test.go |
| 2091 | PENDING | -- | PENDING | TestIdentity_3_HandleVerifyWrongData | core/internal/handler/identity_test.go |
| 2092 | PENDING | -- | PENDING | TestIdentity_3_HandleVerifyNoVerificationMethod | core/internal/handler/identity_test.go |
| 2093 | PENDING | -- | PENDING | TestIdentity_3_HandleVerifyInvalidMultibasePrefix | core/internal/handler/identity_test.go |
| 2094 | PENDING | -- | PENDING | TestIdentity_3_HandleVerifyInvalidMulticodecPrefix | core/internal/handler/identity_test.go |
| 2095 | PENDING | -- | PENDING | TestIdentity_3_HandleVerifyInvalidDID | core/internal/handler/identity_test.go |
| 2096 | PENDING | -- | PENDING | TestTransport_7_IngestNaClIngressRouterNoDuplicate | core/internal/handler/message_test.go |
| 2097 | PENDING | -- | PENDING | TestTransport_7_IngestNaClNoIngressRouterDirectPath | core/internal/handler/message_test.go |
| 2098 | PENDING | -- | PENDING | TestTransport_7_IngestNaClEmptyBody | core/internal/handler/message_test.go |
| 2099 | PENDING | -- | PENDING | TestTransport_7_IngestNaClIngressRouterLockedVault | core/internal/handler/message_test.go |
| 2100 | PENDING | -- | PENDING | TestTransport_7_ProcessPendingEmptySpoolAndDeadDrop | core/internal/handler/message_test.go |
| 2101 | PENDING | -- | PENDING | TestTransport_7_ProcessPendingSweepsDeadDrop | core/internal/handler/message_test.go |
| 2102 | PENDING | -- | PENDING | TestDeriveProvenance_DeviceUser | core/internal/handler/staging_test.go |
| 2103 | PENDING | -- | PENDING | TestDeriveProvenance_DeviceAgent | core/internal/handler/staging_test.go |
| 2104 | PENDING | -- | PENDING | TestDeriveProvenance_BrainForward | core/internal/handler/staging_test.go |
| 2105 | PENDING | -- | PENDING | TestDeriveProvenance_BrainForwardWithConnectorID | core/internal/handler/staging_test.go |
| 2106 | PENDING | -- | PENDING | TestDeriveProvenance_ConnectorService | core/internal/handler/staging_test.go |
| 2107 | PENDING | -- | PENDING | TestDeriveProvenance_NonBrainServiceNoConnectorID | core/internal/handler/staging_test.go |
| 2108 | PENDING | -- | PENDING | TestDeriveProvenance_BrainInternal | core/internal/handler/staging_test.go |
| 2109 | PENDING | -- | PENDING | TestDeriveProvenance_Admin | core/internal/handler/staging_test.go |
| 2110 | PENDING | -- | PENDING | TestDeriveProvenance_ConnectorSpoofTelegram | core/internal/handler/staging_test.go |
| 2111 | PENDING | -- | PENDING | TestHandleIngest_MethodNotAllowed | core/internal/handler/staging_test.go |
| 2112 | PENDING | -- | PENDING | TestHandleIngest_InvalidJSON | core/internal/handler/staging_test.go |
| 2113 | PENDING | -- | PENDING | TestDeriveProvenance_CoreServiceForwards | core/internal/handler/staging_test.go |
| 2114 | PENDING | -- | PENDING | TestHandleClaim_MethodNotAllowed | core/internal/handler/staging_test.go |
| 2115 | PENDING | -- | PENDING | TestHandleResolve_MissingID | core/internal/handler/staging_test.go |
| 2116 | PENDING | -- | PENDING | TestHandleFail_MethodNotAllowed | core/internal/handler/staging_test.go |
| 2117 | PENDING | -- | PENDING | TestHandleStatus_ReturnsStatusAndPersona | core/internal/handler/staging_test.go |
| 2118 | PENDING | -- | PENDING | TestHandleStatus_ReturnsStatusWithoutPersona | core/internal/handler/staging_test.go |
| 2119 | PENDING | -- | PENDING | TestHandleStatus_NotFound | core/internal/handler/staging_test.go |
| 2120 | PENDING | -- | PENDING | TestHandleStatus_MethodNotAllowed | core/internal/handler/staging_test.go |
| 2121 | PENDING | -- | PENDING | TestHandleStatus_EmptyID | core/internal/handler/staging_test.go |
| 2122 | PENDING | -- | PENDING | TestHandleStatus_FallbackToGetStatus | core/internal/handler/staging_test.go |
| 2123 | PENDING | -- | PENDING | TestResolveRequest_UserOriginTelegram | core/internal/handler/staging_test.go |
| 2124 | PENDING | -- | PENDING | TestResolveRequest_UserOriginEmpty | core/internal/handler/staging_test.go |
| 2125 | PENDING | -- | PENDING | TestResolveRequest_UserOriginNonBrainIgnored | core/internal/handler/staging_test.go |
| 2126 | PENDING | -- | PENDING | TestTraceHandler_Query | core/internal/handler/trace_test.go |
| 2127 | PENDING | -- | PENDING | TestTraceHandler_AdminOnly | core/internal/handler/trace_test.go |
| 2128 | PENDING | -- | PENDING | TestTraceHandler_NilStore | core/internal/handler/trace_test.go |
| 2129 | PENDING | -- | PENDING | TestTraceHandler_EmptyReqID | core/internal/handler/trace_test.go |
| 2130 | PENDING | -- | PENDING | TestTracer_Emit | core/internal/handler/trace_test.go |
| 2131 | PENDING | -- | PENDING | TestTracer_NilSafe | core/internal/handler/trace_test.go |
| 2132 | PENDING | -- | PENDING | TestTracer_NoReqID | core/internal/handler/trace_test.go |
| 2133 | PENDING | -- | PENDING | TestInjectUserOrigin_AllowlistedValues | core/internal/handler/vault_test.go |
| 2134 | PENDING | -- | PENDING | TestInjectUserOrigin_UnknownValueRejected | core/internal/handler/vault_test.go |
| 2135 | PENDING | -- | PENDING | TestInjectUserOrigin_EmptyString | core/internal/handler/vault_test.go |
| 2136 | PENDING | -- | PENDING | TestInjectUserOrigin_NonBrainCallerIgnored | core/internal/handler/vault_test.go |
| 2137 | PENDING | -- | PENDING | TestInjectUserOrigin_AmbiguousAgentDID | core/internal/handler/vault_test.go |
| 2138 | TAGGED | TST-CORE-1226 | PENDING | TestFC1_DeviceBlockedFromUserSettings | core/internal/handler/vault_test.go |
| 2139 | TAGGED | TST-CORE-1227 | PENDING | TestFC1_DeviceBlockedFromAdminPrefixKeys | core/internal/handler/vault_test.go |
| 2140 | TAGGED | TST-CORE-1228 | PENDING | TestFC1_DeviceAllowedOnSafeKeys | core/internal/handler/vault_test.go |
| 2141 | TAGGED | TST-CORE-1229 | PENDING | TestFC1_AdminNotBlockedFromUserSettings | core/internal/handler/vault_test.go |
| 2142 | TAGGED | TST-CORE-1230 | PENDING | TestGH6_ClientErrorEscapesQuotes | core/internal/handler/vault_test.go |
| 2143 | TAGGED | TST-CORE-1231 | PENDING | TestGH6_ClientErrorEscapesControlChars | core/internal/handler/vault_test.go |
| 2144 | TAGGED | TST-CORE-1232 | PENDING | TestGH11_ImportPathTraversalBlocked | core/internal/handler/vault_test.go |
| 2145 | PENDING | -- | PENDING | TestTask_8_OutboxFailedMessageRetriedAfterBackoff | core/internal/service/transport_test.go |
| 2146 | PENDING | -- | PENDING | TestTask_8_OutboxMaxRetriesSkipped | core/internal/service/transport_test.go |
| 2147 | PENDING | -- | PENDING | TestTask_8_OutboxSuccessfulRetryMarksDelivered | core/internal/service/transport_test.go |
| 2148 | PENDING | -- | PENDING | TestTask_8_OutboxRetryCountIncrementsOnFailure | core/internal/service/transport_test.go |
| 2149 | PENDING | -- | PENDING | TestTask_8_OutboxMessagesAboveMaxRetriesNeverDelivered | core/internal/service/transport_test.go |
| 2150 | PENDING | -- | PENDING | TestTask_8_OutboxRetryBelowMaxIsProcessed | core/internal/service/transport_test.go |
| 2151 | PENDING | -- | PENDING | TestVault_4_GetItemSuccess | core/internal/service/vault_test.go |
| 2152 | PENDING | -- | PENDING | TestVault_4_GetItemNotFound | core/internal/service/vault_test.go |
| 2153 | PENDING | -- | PENDING | TestVault_4_GetItemLockedPersona | core/internal/service/vault_test.go |
| 2154 | PENDING | -- | PENDING | TestVault_4_GetItemGatekeeperDenied | core/internal/service/vault_test.go |
| 2155 | PENDING | -- | PENDING | TestVault_4_GetKVSuccess | core/internal/service/vault_test.go |
| 2156 | PENDING | -- | PENDING | TestVault_4_GetKVNotFound | core/internal/service/vault_test.go |
| 2157 | PENDING | -- | PENDING | TestVault_4_GetKVPrefixesKey | core/internal/service/vault_test.go |
| 2158 | PENDING | -- | PENDING | TestVault_4_GetItemGatekeeperReceivesItemIDAsTarget | core/internal/service/vault_test.go |
| 2159 | PENDING | -- | PENDING | TestHybridSearch_TrustWeighting_CaveatedDemoted | core/internal/service/vault_test.go |
| 2160 | PENDING | -- | PENDING | TestHybridSearch_TrustWeighting_SelfBoosted | core/internal/service/vault_test.go |
| 2161 | PENDING | -- | PENDING | TestHybridSearch_TrustWeighting_LowConfidencePenalty | core/internal/service/vault_test.go |
| 2162 | PENDING | -- | PENDING | TestHybridSearch_TrustWeighting_CompoundModifiers | core/internal/service/vault_test.go |
| 2163 | PENDING | -- | PENDING | TestHybridSearch_TrustWeighting_NormalUnchanged | core/internal/service/vault_test.go |

## APPVIEW (0/618 tagged -- 0%)

| # | Status | Current Tag | Test Description | File |
|---|--------|------------|-----------------|------|
| 1 | PENDING | -- | UT-TS-001: all-positive attestations -> high score | appview/tests/unit/01-scorer-algorithms.test.ts |
| 2 | PENDING | -- | UT-TS-002: all-negative attestations -> low score | appview/tests/unit/01-scorer-algorithms.test.ts |
| 3 | PENDING | -- | UT-TS-003: mixed sentiment -> mid-range score | appview/tests/unit/01-scorer-algorithms.test.ts |
| 4 | PENDING | -- | UT-TS-004: zero attestations -> neutral default | appview/tests/unit/01-scorer-algorithms.test.ts |
| 5 | PENDING | -- | UT-TS-005: no vouches -> low vouch component | appview/tests/unit/01-scorer-algorithms.test.ts |
| 6 | PENDING | -- | UT-TS-006: 10 vouches -> near-maximum vouch signal | appview/tests/unit/01-scorer-algorithms.test.ts |
| 7 | PENDING | -- | UT-TS-007: logarithmic vouch diminishing returns | appview/tests/unit/01-scorer-algorithms.test.ts |
| 8 | PENDING | -- | UT-TS-008: high-confidence vouch bonus | appview/tests/unit/01-scorer-algorithms.test.ts |
| 9 | PENDING | -- | UT-TS-009: no review history -> zero reviewer score | appview/tests/unit/01-scorer-algorithms.test.ts |
| 10 | PENDING | -- | UT-TS-010: high deletion rate -> harsh penalty | appview/tests/unit/01-scorer-algorithms.test.ts |
| 11 | PENDING | -- | UT-TS-011: high evidence rate -> bonus | appview/tests/unit/01-scorer-algorithms.test.ts |
| 12 | PENDING | -- | UT-TS-012: helpful ratio -> positive signal | appview/tests/unit/01-scorer-algorithms.test.ts |
| 13 | PENDING | -- | UT-TS-013: network component logarithmic | appview/tests/unit/01-scorer-algorithms.test.ts |
| 14 | PENDING | -- | UT-TS-014: delegation inbound bonus | appview/tests/unit/01-scorer-algorithms.test.ts |
| 15 | PENDING | -- | UT-TS-015: critical flag -> 70% reduction | appview/tests/unit/01-scorer-algorithms.test.ts |
| 16 | PENDING | -- | UT-TS-016: serious flag -> 40% reduction | appview/tests/unit/01-scorer-algorithms.test.ts |
| 17 | PENDING | -- | UT-TS-017: warning flag -> 15% reduction | appview/tests/unit/01-scorer-algorithms.test.ts |
| 18 | PENDING | -- | UT-TS-018: multiple flags compound | appview/tests/unit/01-scorer-algorithms.test.ts |
| 19 | PENDING | -- | UT-TS-019: tombstone threshold -> 60% penalty | appview/tests/unit/01-scorer-algorithms.test.ts |
| 20 | PENDING | -- | UT-TS-020: damping factor applied (Fix 12) | appview/tests/unit/01-scorer-algorithms.test.ts |
| 21 | PENDING | -- | UT-TS-021: damping guarantees minimum floor | appview/tests/unit/01-scorer-algorithms.test.ts |
| 22 | PENDING | -- | UT-TS-022: score clamped to [0, 1] | appview/tests/unit/01-scorer-algorithms.test.ts |
| 23 | PENDING | -- | UT-TS-023: score clamped to [0, 1] (low end) | appview/tests/unit/01-scorer-algorithms.test.ts |
| 24 | PENDING | -- | UT-TS-024: recency decay — fresh attestation weighted more | appview/tests/unit/01-scorer-algorithms.test.ts |
| 25 | PENDING | -- | UT-TS-025: evidence multiplier (1.3x) | appview/tests/unit/01-scorer-algorithms.test.ts |
| 26 | PENDING | -- | UT-TS-026: verified multiplier (1.5x) | appview/tests/unit/01-scorer-algorithms.test.ts |
| 27 | PENDING | -- | UT-TS-027: bilateral/cosignature multiplier (1.4x) | appview/tests/unit/01-scorer-algorithms.test.ts |
| 28 | PENDING | -- | UT-TS-028: Fix 12: zero-trust default | appview/tests/unit/01-scorer-algorithms.test.ts |
| 29 | PENDING | -- | UT-TS-029: Fix 12: vouch-gating | appview/tests/unit/01-scorer-algorithms.test.ts |
| 30 | PENDING | -- | UT-TS-030: Fix 12: vouch-gating passes | appview/tests/unit/01-scorer-algorithms.test.ts |
| 31 | PENDING | -- | UT-TS-031: Fix 12: sybil resistance | appview/tests/unit/01-scorer-algorithms.test.ts |
| 32 | PENDING | -- | UT-TS-032: confidence — zero signals | appview/tests/unit/01-scorer-algorithms.test.ts |
| 33 | PENDING | -- | UT-TS-033: confidence — few signals | appview/tests/unit/01-scorer-algorithms.test.ts |
| 34 | PENDING | -- | UT-TS-034: confidence — some signals | appview/tests/unit/01-scorer-algorithms.test.ts |
| 35 | PENDING | -- | UT-TS-035: confidence — moderate signals | appview/tests/unit/01-scorer-algorithms.test.ts |
| 36 | PENDING | -- | UT-TS-036: confidence — many signals | appview/tests/unit/01-scorer-algorithms.test.ts |
| 37 | PENDING | -- | UT-TS-037: confidence — high signals | appview/tests/unit/01-scorer-algorithms.test.ts |
| 38 | PENDING | -- | UT-TS-038: component weights sum to 1.0 | appview/tests/unit/01-scorer-algorithms.test.ts |
| 39 | PENDING | -- | UT-TS-039: neutral sentiment counted as half positive | appview/tests/unit/01-scorer-algorithms.test.ts |
| 40 | PENDING | -- | UT-RQ-001: corroboration rate calculation | appview/tests/unit/01-scorer-algorithms.test.ts |
| 41 | PENDING | -- | UT-RQ-002: deletion rate calculation | appview/tests/unit/01-scorer-algorithms.test.ts |
| 42 | PENDING | -- | UT-RQ-003: evidence rate calculation | appview/tests/unit/01-scorer-algorithms.test.ts |
| 43 | PENDING | -- | UT-RQ-004: helpful ratio — all helpful | appview/tests/unit/01-scorer-algorithms.test.ts |
| 44 | PENDING | -- | UT-RQ-005: helpful ratio — no reactions | appview/tests/unit/01-scorer-algorithms.test.ts |
| 45 | PENDING | -- | UT-RQ-006: revocation rate | appview/tests/unit/01-scorer-algorithms.test.ts |
| 46 | PENDING | -- | UT-RQ-007: agent-generated flag detection | appview/tests/unit/01-scorer-algorithms.test.ts |
| 47 | PENDING | -- | UT-RQ-008: active domains extraction | appview/tests/unit/01-scorer-algorithms.test.ts |
| 48 | PENDING | -- | UT-RQ-009: coordination flag count propagation | appview/tests/unit/01-scorer-algorithms.test.ts |
| 49 | PENDING | -- | UT-RQ-010: zero attestations -> zero rates | appview/tests/unit/01-scorer-algorithms.test.ts |
| 50 | PENDING | -- | UT-SA-001: weighted score calculation | appview/tests/unit/01-scorer-algorithms.test.ts |
| 51 | PENDING | -- | UT-SA-002: confidence from attestation count | appview/tests/unit/01-scorer-algorithms.test.ts |
| 52 | PENDING | -- | UT-SA-003: dimension summary aggregation | appview/tests/unit/01-scorer-algorithms.test.ts |
| 53 | PENDING | -- | UT-SA-004: authenticity consensus — majority positive | appview/tests/unit/01-scorer-algorithms.test.ts |
| 54 | PENDING | -- | UT-SA-005: authenticity consensus — split opinion | appview/tests/unit/01-scorer-algorithms.test.ts |
| 55 | PENDING | -- | UT-SA-006: would-recommend rate | appview/tests/unit/01-scorer-algorithms.test.ts |
| 56 | PENDING | -- | UT-SA-007: attestation velocity | appview/tests/unit/01-scorer-algorithms.test.ts |
| 57 | PENDING | -- | UT-SA-008: empty attestation list | appview/tests/unit/01-scorer-algorithms.test.ts |
| 58 | PENDING | -- | UT-SA-009: verified attestation count | appview/tests/unit/01-scorer-algorithms.test.ts |
| 59 | PENDING | -- | UT-SA-010: lastAttestationAt tracking | appview/tests/unit/01-scorer-algorithms.test.ts |
| 60 | PENDING | -- | UT-AD-001: coordination detection — temporal burst | appview/tests/unit/01-scorer-algorithms.test.ts |
| 61 | PENDING | -- | UT-AD-002: coordination detection — below threshold | appview/tests/unit/01-scorer-algorithms.test.ts |
| 62 | PENDING | -- | UT-AD-003: sybil cluster detection — correlated timing | appview/tests/unit/01-scorer-algorithms.test.ts |
| 63 | PENDING | -- | UT-AD-004: sybil detection — minimum cluster size | appview/tests/unit/01-scorer-algorithms.test.ts |
| 64 | PENDING | -- | UT-AD-005: statistical outlier — sentiment flip | appview/tests/unit/01-scorer-algorithms.test.ts |
| 65 | PENDING | -- | UT-AD-006: no anomalies in normal traffic | appview/tests/unit/01-scorer-algorithms.test.ts |
| 66 | PENDING | -- | UT-RC-001: proceed — high trust, no flags | appview/tests/unit/01-scorer-algorithms.test.ts |
| 67 | PENDING | -- | UT-RC-002: caution — moderate trust | appview/tests/unit/01-scorer-algorithms.test.ts |
| 68 | PENDING | -- | UT-RC-003: verify — low trust, active flags | appview/tests/unit/01-scorer-algorithms.test.ts |
| 69 | PENDING | -- | UT-RC-004: avoid — very low trust, critical flag | appview/tests/unit/01-scorer-algorithms.test.ts |
| 70 | PENDING | -- | UT-RC-005: context: before-transaction -> stricter | appview/tests/unit/01-scorer-algorithms.test.ts |
| 71 | PENDING | -- | UT-RC-006: context: general-lookup -> lenient | appview/tests/unit/01-scorer-algorithms.test.ts |
| 72 | PENDING | -- | UT-RC-007: graph context boosts trusted | appview/tests/unit/01-scorer-algorithms.test.ts |
| 73 | PENDING | -- | UT-RC-008: no scores -> unknown | appview/tests/unit/01-scorer-algorithms.test.ts |
| 74 | PENDING | -- | UT-RC-009: reasoning includes flag types | appview/tests/unit/01-scorer-algorithms.test.ts |
| 75 | PENDING | -- | UT-RC-010: authenticity suspicious -> lower trust | appview/tests/unit/01-scorer-algorithms.test.ts |
| 76 | PENDING | -- | UT-RC-011: domain-specific score used when available | appview/tests/unit/01-scorer-algorithms.test.ts |
| 77 | PENDING | -- | UT-RC-012: graph timeout handled gracefully | appview/tests/unit/01-scorer-algorithms.test.ts |
| 78 | PENDING | -- | UT-RV-001: valid attestation record | appview/tests/unit/02-ingester-components.test.ts |
| 79 | PENDING | -- | UT-RV-002: missing required field (subject) | appview/tests/unit/02-ingester-components.test.ts |
| 80 | PENDING | -- | UT-RV-003: missing required field (createdAt) | appview/tests/unit/02-ingester-components.test.ts |
| 81 | PENDING | -- | UT-RV-004: invalid sentiment enum | appview/tests/unit/02-ingester-components.test.ts |
| 82 | PENDING | -- | UT-RV-005: text exceeds max length | appview/tests/unit/02-ingester-components.test.ts |
| 83 | PENDING | -- | UT-RV-006: tags exceeds max count | appview/tests/unit/02-ingester-components.test.ts |
| 84 | PENDING | -- | UT-RV-007: tag exceeds max length | appview/tests/unit/02-ingester-components.test.ts |
| 85 | PENDING | -- | UT-RV-008: dimensions exceeds max count | appview/tests/unit/02-ingester-components.test.ts |
| 86 | PENDING | -- | UT-RV-009: evidence exceeds max count | appview/tests/unit/02-ingester-components.test.ts |
| 87 | PENDING | -- | UT-RV-010: valid vouch record | appview/tests/unit/02-ingester-components.test.ts |
| 88 | PENDING | -- | UT-RV-011: invalid vouch confidence | appview/tests/unit/02-ingester-components.test.ts |
| 89 | PENDING | -- | UT-RV-012: valid reaction record | appview/tests/unit/02-ingester-components.test.ts |
| 90 | PENDING | -- | UT-RV-013: invalid reaction enum | appview/tests/unit/02-ingester-components.test.ts |
| 91 | PENDING | -- | UT-RV-014: valid report record | appview/tests/unit/02-ingester-components.test.ts |
| 92 | PENDING | -- | UT-RV-015: invalid report type enum | appview/tests/unit/02-ingester-components.test.ts |
| 93 | PENDING | -- | UT-RV-016: report text exceeds max | appview/tests/unit/02-ingester-components.test.ts |
| 94 | PENDING | -- | UT-RV-017: report evidence max count | appview/tests/unit/02-ingester-components.test.ts |
| 95 | PENDING | -- | UT-RV-018: unknown collection -> error | appview/tests/unit/02-ingester-components.test.ts |
| 96 | PENDING | -- | UT-RV-019: valid attestation with optional fields | appview/tests/unit/02-ingester-components.test.ts |
| 97 | PENDING | -- | UT-RV-020: subject ref — all type variants | appview/tests/unit/02-ingester-components.test.ts |
| 98 | PENDING | -- | UT-RV-021: subject ref — invalid type | appview/tests/unit/02-ingester-components.test.ts |
| 99 | PENDING | -- | UT-RV-022: subject name max length | appview/tests/unit/02-ingester-components.test.ts |
| 100 | PENDING | -- | UT-RV-023: dimension rating — valid enum values | appview/tests/unit/02-ingester-components.test.ts |
| 101 | PENDING | -- | UT-RV-024: dimension rating — invalid value | appview/tests/unit/02-ingester-components.test.ts |
| 102 | PENDING | -- | UT-RV-025: evidence item — valid structure | appview/tests/unit/02-ingester-components.test.ts |
| 103 | PENDING | -- | UT-RV-026: evidence description max length | appview/tests/unit/02-ingester-components.test.ts |
| 104 | PENDING | -- | UT-RV-027: mention — valid structure | appview/tests/unit/02-ingester-components.test.ts |
| 105 | PENDING | -- | UT-RV-028: mentions exceeds max count | appview/tests/unit/02-ingester-components.test.ts |
| 106 | PENDING | -- | UT-RV-029: relatedAttestations max count | appview/tests/unit/02-ingester-components.test.ts |
| 107 | PENDING | -- | UT-RV-030: cosignature — valid structure | appview/tests/unit/02-ingester-components.test.ts |
| 108 | PENDING | -- | UT-RV-031: cosignature — missing sig field | appview/tests/unit/02-ingester-components.test.ts |
| 109 | PENDING | -- | UT-RV-032: confidence enum — all valid values | appview/tests/unit/02-ingester-components.test.ts |
| 110 | PENDING | -- | UT-RV-033: confidence — invalid value | appview/tests/unit/02-ingester-components.test.ts |
| 111 | PENDING | -- | UT-RV-034: all 19 collection types — valid minimal records | appview/tests/unit/02-ingester-components.test.ts |
| 112 | PENDING | -- | UT-RV-035: extra fields ignored (passthrough) | appview/tests/unit/02-ingester-components.test.ts |
| 113 | PENDING | -- | UT-RV-036: relatedRecords max on report | appview/tests/unit/02-ingester-components.test.ts |
| 114 | PENDING | -- | UT-RL-001: first record not rate limited | appview/tests/unit/02-ingester-components.test.ts |
| 115 | PENDING | -- | UT-RL-002: 50th record not rate limited | appview/tests/unit/02-ingester-components.test.ts |
| 116 | PENDING | -- | UT-RL-003: Fix 11: 51st record rate limited | appview/tests/unit/02-ingester-components.test.ts |
| 117 | PENDING | -- | UT-RL-004: Fix 11: quarantine flag set on first limit | appview/tests/unit/02-ingester-components.test.ts |
| 118 | PENDING | -- | UT-RL-005: subsequent records still rate limited | appview/tests/unit/02-ingester-components.test.ts |
| 119 | PENDING | -- | UT-RL-006: different DIDs independent | appview/tests/unit/02-ingester-components.test.ts |
| 120 | PENDING | -- | UT-RL-007: getQuarantinedDids returns flagged DIDs | appview/tests/unit/02-ingester-components.test.ts |
| 121 | PENDING | -- | UT-RL-008: LRU eviction under max capacity | appview/tests/unit/02-ingester-components.test.ts |
| 122 | PENDING | -- | UT-RL-009: sliding window — TTL expiry resets count | appview/tests/unit/02-ingester-components.test.ts |
| 123 | PENDING | -- | UT-RL-010: counter increments on every call | appview/tests/unit/02-ingester-components.test.ts |
| 124 | PENDING | -- | UT-BQ-001: push triggers processing | appview/tests/unit/02-ingester-components.test.ts |
| 125 | PENDING | -- | UT-BQ-002: concurrent workers capped at MAX_CONCURRENCY | appview/tests/unit/02-ingester-components.test.ts |
| 126 | PENDING | -- | UT-BQ-003: Fix 5: backpressure — ws.pause() at MAX_QUEUE_SIZE | appview/tests/unit/02-ingester-components.test.ts |
| 127 | PENDING | -- | UT-BQ-004: Fix 5: hysteresis — ws.resume() at 50% | appview/tests/unit/02-ingester-components.test.ts |
| 128 | PENDING | -- | UT-BQ-005: no oscillation — resume only once below 50% | appview/tests/unit/02-ingester-components.test.ts |
| 129 | PENDING | -- | UT-BQ-006: Fix 7: getSafeCursor — no in-flight | appview/tests/unit/02-ingester-components.test.ts |
| 130 | PENDING | -- | UT-BQ-007: Fix 7: getSafeCursor — with in-flight | appview/tests/unit/02-ingester-components.test.ts |
| 131 | PENDING | -- | UT-BQ-008: Fix 7: low watermark prevents data loss | appview/tests/unit/02-ingester-components.test.ts |
| 132 | PENDING | -- | UT-BQ-009: error in processFn doesn\ | appview/tests/unit/02-ingester-components.test.ts |
| 133 | PENDING | -- | UT-BQ-010: depth/active/inFlight accessors | appview/tests/unit/02-ingester-components.test.ts |
| 134 | PENDING | -- | UT-BQ-011: pump resumes after worker completes | appview/tests/unit/02-ingester-components.test.ts |
| 135 | PENDING | -- | UT-BQ-012: metrics emitted correctly | appview/tests/unit/02-ingester-components.test.ts |
| 136 | PENDING | -- | UT-BQ-013: HIGH-04: failed item timestamp pinned in getSafeCursor | appview/tests/unit/02-ingester-components.test.ts |
| 137 | PENDING | -- | UT-BQ-014: MEDIUM-06: getSafeCursor scans all queued items for minimum | appview/tests/unit/02-ingester-components.test.ts |
| 138 | PENDING | -- | UT-HR-001: routeHandler — attestation | appview/tests/unit/02-ingester-components.test.ts |
| 139 | PENDING | -- | UT-HR-002: routeHandler — vouch | appview/tests/unit/02-ingester-components.test.ts |
| 140 | PENDING | -- | UT-HR-003: routeHandler — all 19 collections registered | appview/tests/unit/02-ingester-components.test.ts |
| 141 | PENDING | -- | UT-HR-004: routeHandler — unknown collection | appview/tests/unit/02-ingester-components.test.ts |
| 142 | PENDING | -- | UT-HR-005: routeHandler — non-dina collection | appview/tests/unit/02-ingester-components.test.ts |
| 143 | PENDING | -- | UT-HR-006: handler interface — handleCreate exists | appview/tests/unit/02-ingester-components.test.ts |
| 144 | PENDING | -- | UT-HR-007: handler interface — handleDelete exists | appview/tests/unit/02-ingester-components.test.ts |
| 145 | PENDING | -- | UT-DH-001: getSourceTable — attestation -> attestations table | appview/tests/unit/02-ingester-components.test.ts |
| 146 | PENDING | -- | UT-DH-002: getSourceTable — vouch -> vouches table | appview/tests/unit/02-ingester-components.test.ts |
| 147 | PENDING | -- | UT-DH-003: Fix 13: all 18 record types mapped | appview/tests/unit/02-ingester-components.test.ts |
| 148 | PENDING | -- | UT-DH-004: getSourceTable — unknown collection -> null | appview/tests/unit/02-ingester-components.test.ts |
| 149 | PENDING | -- | UT-DH-005: getSourceTable — media -> media table | appview/tests/unit/02-ingester-components.test.ts |
| 150 | PENDING | -- | UT-DH-006: COLLECTION_TABLE_MAP completeness | appview/tests/unit/02-ingester-components.test.ts |
| 151 | PENDING | -- | UT-TE-001: vouch high confidence -> weight 1.0 | appview/tests/unit/02-ingester-components.test.ts |
| 152 | PENDING | -- | UT-TE-002: vouch moderate -> weight 0.6 | appview/tests/unit/02-ingester-components.test.ts |
| 153 | PENDING | -- | UT-TE-003: vouch low -> weight 0.3 | appview/tests/unit/02-ingester-components.test.ts |
| 154 | PENDING | -- | UT-TE-004: endorsement worked-together -> weight 0.8 | appview/tests/unit/02-ingester-components.test.ts |
| 155 | PENDING | -- | UT-TE-005: endorsement observed-output -> weight 0.4 | appview/tests/unit/02-ingester-components.test.ts |
| 156 | PENDING | -- | UT-TE-006: delegation -> weight 0.9 | appview/tests/unit/02-ingester-components.test.ts |
| 157 | PENDING | -- | UT-TE-007: cosigned attestation -> weight 0.3 (positive-attestation edge) | appview/tests/unit/02-ingester-components.test.ts |
| 158 | PENDING | -- | UT-TE-008: positive attestation DID subject -> weight 0.3 | appview/tests/unit/02-ingester-components.test.ts |
| 159 | PENDING | -- | UT-TE-009: negative attestation DID subject -> no trust edge (HIGH-07) | appview/tests/unit/02-ingester-components.test.ts |
| 160 | PENDING | -- | UT-TE-010: non-DID subject attestation -> no trust edge | appview/tests/unit/02-ingester-components.test.ts |
| 161 | PENDING | -- | UT-URI-001: parse valid AT URI | appview/tests/unit/03-shared-utilities.test.ts |
| 162 | PENDING | -- | UT-URI-002: parse AT URI — did:web | appview/tests/unit/03-shared-utilities.test.ts |
| 163 | PENDING | -- | UT-URI-003: construct AT URI | appview/tests/unit/03-shared-utilities.test.ts |
| 164 | PENDING | -- | UT-URI-004: invalid URI — missing protocol | appview/tests/unit/03-shared-utilities.test.ts |
| 165 | PENDING | -- | UT-URI-005: invalid URI — missing collection | appview/tests/unit/03-shared-utilities.test.ts |
| 166 | PENDING | -- | UT-URI-006: invalid URI — empty string | appview/tests/unit/03-shared-utilities.test.ts |
| 167 | PENDING | -- | UT-URI-007: round-trip: parse -> construct -> parse | appview/tests/unit/03-shared-utilities.test.ts |
| 168 | PENDING | -- | UT-URI-008: special characters in rkey | appview/tests/unit/03-shared-utilities.test.ts |
| 169 | PENDING | -- | UT-DI-001: Fix 10: Tier 1 — DID produces global ID | appview/tests/unit/03-shared-utilities.test.ts |
| 170 | PENDING | -- | UT-DI-002: Fix 10: Tier 1 — same DID, different authors -> same ID | appview/tests/unit/03-shared-utilities.test.ts |
| 171 | PENDING | -- | UT-DI-003: Fix 10: Tier 1 — URI produces global ID | appview/tests/unit/03-shared-utilities.test.ts |
| 172 | PENDING | -- | UT-DI-004: Fix 10: Tier 1 — same URI, different authors -> same ID | appview/tests/unit/03-shared-utilities.test.ts |
| 173 | PENDING | -- | UT-DI-005: Fix 10: Tier 1 — identifier produces global ID | appview/tests/unit/03-shared-utilities.test.ts |
| 174 | PENDING | -- | UT-DI-006: Fix 10: Tier 1 — priority: DID > URI > identifier | appview/tests/unit/03-shared-utilities.test.ts |
| 175 | PENDING | -- | UT-DI-007: Fix 10: Tier 1 — priority: URI > identifier | appview/tests/unit/03-shared-utilities.test.ts |
| 176 | PENDING | -- | UT-DI-008: Fix 10: Tier 2 — name-only -> author-scoped | appview/tests/unit/03-shared-utilities.test.ts |
| 177 | PENDING | -- | UT-DI-009: Fix 10: Tier 2 — same name, different authors -> different IDs | appview/tests/unit/03-shared-utilities.test.ts |
| 178 | PENDING | -- | UT-DI-010: Fix 10: Tier 2 — same name, same author -> same ID | appview/tests/unit/03-shared-utilities.test.ts |
| 179 | PENDING | -- | UT-DI-011: case normalization | appview/tests/unit/03-shared-utilities.test.ts |
| 180 | PENDING | -- | UT-DI-012: whitespace normalization | appview/tests/unit/03-shared-utilities.test.ts |
| 181 | PENDING | -- | UT-DI-013: ID format — prefix | appview/tests/unit/03-shared-utilities.test.ts |
| 182 | PENDING | -- | UT-DI-014: ID format — length | appview/tests/unit/03-shared-utilities.test.ts |
| 183 | PENDING | -- | UT-DI-015: name fallback order | appview/tests/unit/03-shared-utilities.test.ts |
| 184 | PENDING | -- | UT-DI-016: name fallback —  | appview/tests/unit/03-shared-utilities.test.ts |
| 185 | PENDING | -- | UT-DI-017: different subject types -> different IDs (Tier 2) | appview/tests/unit/03-shared-utilities.test.ts |
| 186 | PENDING | -- | UT-RT-001: succeeds on first try -> no retry | appview/tests/unit/03-shared-utilities.test.ts |
| 187 | PENDING | -- | UT-RT-002: fails once then succeeds -> one retry | appview/tests/unit/03-shared-utilities.test.ts |
| 188 | PENDING | -- | UT-RT-003: exhausts all retries -> throws | appview/tests/unit/03-shared-utilities.test.ts |
| 189 | PENDING | -- | UT-RT-004: exponential backoff timing | appview/tests/unit/03-shared-utilities.test.ts |
| 190 | PENDING | -- | UT-RT-005: max delay cap | appview/tests/unit/03-shared-utilities.test.ts |
| 191 | PENDING | -- | UT-BA-001: single batch — within limit | appview/tests/unit/03-shared-utilities.test.ts |
| 192 | PENDING | -- | UT-BA-002: multiple batches | appview/tests/unit/03-shared-utilities.test.ts |
| 193 | PENDING | -- | UT-BA-003: empty input | appview/tests/unit/03-shared-utilities.test.ts |
| 194 | PENDING | -- | UT-BA-004: exact batch boundary | appview/tests/unit/03-shared-utilities.test.ts |
| 195 | PENDING | -- | UT-ER-001: AppError — message and code | appview/tests/unit/03-shared-utilities.test.ts |
| 196 | PENDING | -- | UT-ER-002: ValidationError extends AppError | appview/tests/unit/03-shared-utilities.test.ts |
| 197 | PENDING | -- | UT-ER-003: NotFoundError extends AppError | appview/tests/unit/03-shared-utilities.test.ts |
| 198 | PENDING | -- | UT-ER-004: error serialization | appview/tests/unit/03-shared-utilities.test.ts |
| 199 | PENDING | -- | UT-ENV-001: valid environment — all required | appview/tests/unit/04-configuration.test.ts |
| 200 | PENDING | -- | UT-ENV-002: missing DATABASE_URL -> falls back to default | appview/tests/unit/04-configuration.test.ts |
| 201 | PENDING | -- | UT-ENV-003: DATABASE_URL — any string accepted | appview/tests/unit/04-configuration.test.ts |
| 202 | PENDING | -- | UT-ENV-004: defaults applied — JETSTREAM_URL | appview/tests/unit/04-configuration.test.ts |
| 203 | PENDING | -- | UT-ENV-005: defaults applied — DATABASE_POOL_MAX | appview/tests/unit/04-configuration.test.ts |
| 204 | PENDING | -- | UT-ENV-006: defaults applied — PORT | appview/tests/unit/04-configuration.test.ts |
| 205 | PENDING | -- | UT-ENV-007: defaults applied — LOG_LEVEL | appview/tests/unit/04-configuration.test.ts |
| 206 | PENDING | -- | UT-ENV-008: invalid LOG_LEVEL enum | appview/tests/unit/04-configuration.test.ts |
| 207 | PENDING | -- | UT-ENV-009: numeric coercion — DATABASE_POOL_MAX | appview/tests/unit/04-configuration.test.ts |
| 208 | PENDING | -- | UT-ENV-010: numeric coercion — PORT | appview/tests/unit/04-configuration.test.ts |
| 209 | PENDING | -- | UT-ENV-011: defaults applied — DATABASE_POOL_MIN | appview/tests/unit/04-configuration.test.ts |
| 210 | PENDING | -- | UT-ENV-012: defaults applied — RATE_LIMIT_RPM | appview/tests/unit/04-configuration.test.ts |
| 211 | PENDING | -- | UT-ENV-013: defaults applied — NEXT_PUBLIC_BASE_URL | appview/tests/unit/04-configuration.test.ts |
| 212 | PENDING | -- | UT-ENV-014: MEDIUM-11: NODE_ENV field defaults to production | appview/tests/unit/04-configuration.test.ts |
| 213 | PENDING | -- | UT-ENV-015: MEDIUM-11: production mode requires stricter DATABASE_URL | appview/tests/unit/04-configuration.test.ts |
| 214 | PENDING | -- | UT-CON-001: scoring weights sum to 1.0 | appview/tests/unit/04-configuration.test.ts |
| 215 | PENDING | -- | UT-CON-002: multipliers > 1.0 | appview/tests/unit/04-configuration.test.ts |
| 216 | PENDING | -- | UT-CON-003: page sizes within bounds | appview/tests/unit/04-configuration.test.ts |
| 217 | PENDING | -- | UT-CON-004: tombstone threshold positive | appview/tests/unit/04-configuration.test.ts |
| 218 | PENDING | -- | UT-CON-005: halflife positive | appview/tests/unit/04-configuration.test.ts |
| 219 | PENDING | -- | UT-LEX-001: TRUST_COLLECTIONS has 19 entries | appview/tests/unit/04-configuration.test.ts |
| 220 | PENDING | -- | UT-LEX-002: all entries prefixed with  | appview/tests/unit/04-configuration.test.ts |
| 221 | PENDING | -- | UT-LEX-003: no duplicate entries | appview/tests/unit/04-configuration.test.ts |
| 222 | PENDING | -- | UT-LEX-004: expected collections present | appview/tests/unit/04-configuration.test.ts |
| 223 | PENDING | -- | UT-LEX-005: type safety — TrustCollection type | appview/tests/unit/04-configuration.test.ts |
| 224 | PENDING | -- | UT-SWR-001: Fix 6: fresh hit -- serve from cache | appview/tests/unit/05-api-cache.test.ts |
| 225 | PENDING | -- | UT-SWR-002: Fix 6: total miss -- fetch and cache | appview/tests/unit/05-api-cache.test.ts |
| 226 | PENDING | -- | UT-SWR-003: Fix 6: stale hit -- serve stale, refresh in background | appview/tests/unit/05-api-cache.test.ts |
| 227 | PENDING | -- | UT-SWR-004: Fix 6: promise coalescing -- concurrent requests | appview/tests/unit/05-api-cache.test.ts |
| 228 | PENDING | -- | UT-SWR-005: promise coalescing -- different keys independent | appview/tests/unit/05-api-cache.test.ts |
| 229 | PENDING | -- | UT-SWR-006: background refresh failure -- stale data preserved | appview/tests/unit/05-api-cache.test.ts |
| 230 | PENDING | -- | UT-SWR-007: total miss failure -- error propagated | appview/tests/unit/05-api-cache.test.ts |
| 231 | PENDING | -- | UT-SWR-008: Fix 8: O(1) LRU eviction | appview/tests/unit/05-api-cache.test.ts |
| 232 | PENDING | -- | UT-SWR-009: cache key generation -- resolveKey | appview/tests/unit/05-api-cache.test.ts |
| 233 | PENDING | -- | UT-SWR-010: cache key -- optional params omitted | appview/tests/unit/05-api-cache.test.ts |
| 234 | PENDING | -- | UT-SWR-011: CACHE_TTLS correctness | appview/tests/unit/05-api-cache.test.ts |
| 235 | PENDING | -- | UT-SWR-012: TTL boundary -- entry at exact expiry time | appview/tests/unit/05-api-cache.test.ts |
| 236 | PENDING | -- | UT-SWR-013: in-flight map cleaned up on success | appview/tests/unit/05-api-cache.test.ts |
| 237 | PENDING | -- | UT-SWR-014: in-flight map cleaned up on error | appview/tests/unit/05-api-cache.test.ts |
| 238 | PENDING | -- | UT-JC-001: kind =  | appview/tests/unit/06-jetstream-consumer.test.ts |
| 239 | PENDING | -- | UT-JC-002: kind =  | appview/tests/unit/06-jetstream-consumer.test.ts |
| 240 | PENDING | -- | UT-JC-003: kind =  | appview/tests/unit/06-jetstream-consumer.test.ts |
| 241 | PENDING | -- | UT-JC-004: kind =  | appview/tests/unit/06-jetstream-consumer.test.ts |
| 242 | PENDING | -- | UT-JC-005: kind =  | appview/tests/unit/06-jetstream-consumer.test.ts |
| 243 | PENDING | -- | UT-JC-006: non-trust collection -> skipped | appview/tests/unit/06-jetstream-consumer.test.ts |
| 244 | PENDING | -- | UT-JC-007: Fix 11: rate-limited DID -> event dropped | appview/tests/unit/06-jetstream-consumer.test.ts |
| 245 | PENDING | -- | UT-JC-008: HIGH-06: rate limiting applies to all operations including delete | appview/tests/unit/06-jetstream-consumer.test.ts |
| 246 | PENDING | -- | UT-JC-009: validation failure -> event skipped | appview/tests/unit/06-jetstream-consumer.test.ts |
| 247 | PENDING | -- | UT-JC-010: unknown handler -> event skipped | appview/tests/unit/06-jetstream-consumer.test.ts |
| 248 | PENDING | -- | UT-JC-011: HIGH-02/03: update = pure upsert (no delete) | appview/tests/unit/06-jetstream-consumer.test.ts |
| 249 | PENDING | -- | UT-JC-012: cursor save interval -- every 100 events | appview/tests/unit/06-jetstream-consumer.test.ts |
| 250 | PENDING | -- | UT-JC-013: cursor save interval -- 99 events -> no save | appview/tests/unit/06-jetstream-consumer.test.ts |
| 251 | PENDING | -- | UT-JC-014: Fix 7: cursor value = queue.getSafeCursor | appview/tests/unit/06-jetstream-consumer.test.ts |
| 252 | PENDING | -- | UT-JC-015: highestSeenTimeUs tracks maximum | appview/tests/unit/06-jetstream-consumer.test.ts |
| 253 | PENDING | -- | UT-JC-016: reconnect backoff -- exponential delay | appview/tests/unit/06-jetstream-consumer.test.ts |
| 254 | PENDING | -- | UT-JC-017: reconnect resets on successful connection | appview/tests/unit/06-jetstream-consumer.test.ts |
| 255 | PENDING | -- | UT-JC-018: graceful shutdown -- saves final cursor | appview/tests/unit/06-jetstream-consumer.test.ts |
| 256 | PENDING | -- | UT-JC-019: graceful shutdown -- closes WebSocket | appview/tests/unit/06-jetstream-consumer.test.ts |
| 257 | PENDING | -- | UT-JC-020: account takendown event -> logged | appview/tests/unit/06-jetstream-consumer.test.ts |
| 258 | PENDING | -- | UT-JC-021: JSON parse error -> logged, not crashed | appview/tests/unit/06-jetstream-consumer.test.ts |
| 259 | PENDING | -- | UT-JC-022: account deleted event -> logged | appview/tests/unit/06-jetstream-consumer.test.ts |
| 260 | PENDING | -- | UT-JC-023: account suspended event -> logged | appview/tests/unit/06-jetstream-consumer.test.ts |
| 261 | PENDING | -- | UT-JC-024: HIGH-05: queue push failure logged with metric | appview/tests/unit/06-jetstream-consumer.test.ts |
| 262 | PENDING | -- | UT-JC-025: HIGH-06: rate limiting blocks updates too | appview/tests/unit/06-jetstream-consumer.test.ts |
| 263 | PENDING | -- | UT-SCH-001: all 9 jobs registered | appview/tests/unit/07-scorer-jobs.test.ts |
| 264 | PENDING | -- | UT-SCH-002: refresh-profiles runs every 5 min | appview/tests/unit/07-scorer-jobs.test.ts |
| 265 | PENDING | -- | UT-SCH-003: refresh-subject-scores runs every 5 min | appview/tests/unit/07-scorer-jobs.test.ts |
| 266 | PENDING | -- | UT-SCH-004: detect-coordination runs every 30 min | appview/tests/unit/07-scorer-jobs.test.ts |
| 267 | PENDING | -- | UT-SCH-005: detect-sybil runs every 6 hours | appview/tests/unit/07-scorer-jobs.test.ts |
| 268 | PENDING | -- | UT-SCH-006: decay-scores runs daily at 3 AM | appview/tests/unit/07-scorer-jobs.test.ts |
| 269 | PENDING | -- | UT-SCH-007: cleanup-expired runs daily at 4 AM | appview/tests/unit/07-scorer-jobs.test.ts |
| 270 | PENDING | -- | UT-SCH-008: refresh-reviewer-stats runs every 15 min | appview/tests/unit/07-scorer-jobs.test.ts |
| 271 | PENDING | -- | UT-SCH-009: refresh-domain-scores runs every hour | appview/tests/unit/07-scorer-jobs.test.ts |
| 272 | PENDING | -- | UT-SCH-010: process-tombstones runs every 10 min | appview/tests/unit/07-scorer-jobs.test.ts |
| 273 | PENDING | -- | UT-SCH-011: job error -> caught and logged | appview/tests/unit/07-scorer-jobs.test.ts |
| 274 | PENDING | -- | UT-SCH-012: job duration tracked | appview/tests/unit/07-scorer-jobs.test.ts |
| 275 | PENDING | -- | UT-SCH-013: job error metric incremented | appview/tests/unit/07-scorer-jobs.test.ts |
| 276 | PENDING | -- | UT-DS-001: recent attestation -- no decay | appview/tests/unit/07-scorer-jobs.test.ts |
| 277 | PENDING | -- | UT-DS-002: old attestation -- decayed | appview/tests/unit/07-scorer-jobs.test.ts |
| 278 | PENDING | -- | UT-DS-003: halflife calculation | appview/tests/unit/07-scorer-jobs.test.ts |
| 279 | PENDING | -- | UT-DS-004: very old attestation -- near zero | appview/tests/unit/07-scorer-jobs.test.ts |
| 280 | PENDING | -- | UT-RP-001: valid params -- subject only | appview/tests/unit/08-xrpc-params.test.ts |
| 281 | PENDING | -- | UT-RP-002: valid params -- all fields | appview/tests/unit/08-xrpc-params.test.ts |
| 282 | PENDING | -- | UT-RP-003: missing subject -> error | appview/tests/unit/08-xrpc-params.test.ts |
| 283 | PENDING | -- | UT-RP-004: invalid context enum | appview/tests/unit/08-xrpc-params.test.ts |
| 284 | PENDING | -- | UT-RP-005: all context values valid | appview/tests/unit/08-xrpc-params.test.ts |
| 285 | PENDING | -- | UT-SP-001: valid params -- q only | appview/tests/unit/08-xrpc-params.test.ts |
| 286 | PENDING | -- | UT-SP-002: valid params -- all filters | appview/tests/unit/08-xrpc-params.test.ts |
| 287 | PENDING | -- | UT-SP-003: limit bounds -- too high | appview/tests/unit/08-xrpc-params.test.ts |
| 288 | PENDING | -- | UT-SP-004: limit bounds -- too low | appview/tests/unit/08-xrpc-params.test.ts |
| 289 | PENDING | -- | UT-SP-005: limit default | appview/tests/unit/08-xrpc-params.test.ts |
| 290 | PENDING | -- | UT-SP-006: sort default | appview/tests/unit/08-xrpc-params.test.ts |
| 291 | PENDING | -- | UT-SP-007: invalid sort enum | appview/tests/unit/08-xrpc-params.test.ts |
| 292 | PENDING | -- | UT-SP-008: invalid sentiment enum | appview/tests/unit/08-xrpc-params.test.ts |
| 293 | PENDING | -- | UT-SP-009: invalid subjectType enum | appview/tests/unit/08-xrpc-params.test.ts |
| 294 | PENDING | -- | UT-SP-010: tags -- comma-separated parsing | appview/tests/unit/08-xrpc-params.test.ts |
| 295 | PENDING | -- | UT-SP-011: MEDIUM-03: minConfidence filter accepted | appview/tests/unit/08-xrpc-params.test.ts |
| 296 | PENDING | -- | IT-ATT-001: create attestation — basic insert | appview/tests/integration/01-ingester-handlers.test.ts |
| 297 | PENDING | -- | IT-ATT-002: create attestation — all optional fields | appview/tests/integration/01-ingester-handlers.test.ts |
| 298 | PENDING | -- | IT-ATT-003: subject resolved via Tier 1 (DID) | appview/tests/integration/01-ingester-handlers.test.ts |
| 299 | PENDING | -- | IT-ATT-004: subject resolved via Tier 1 (URI) | appview/tests/integration/01-ingester-handlers.test.ts |
| 300 | PENDING | -- | IT-ATT-005: subject resolved via Tier 1 (identifier) | appview/tests/integration/01-ingester-handlers.test.ts |
| 301 | PENDING | -- | IT-ATT-006: Fix 10: subject resolved via Tier 2 (name-only) | appview/tests/integration/01-ingester-handlers.test.ts |
| 302 | PENDING | -- | IT-ATT-007: Fix 10: same name, different authors — different subjects | appview/tests/integration/01-ingester-handlers.test.ts |
| 303 | PENDING | -- | IT-ATT-008: Fix 10: same name, same author — same subject | appview/tests/integration/01-ingester-handlers.test.ts |
| 304 | PENDING | -- | IT-ATT-009: Fix 10: same DID, different authors — same subject (Tier 1) | appview/tests/integration/01-ingester-handlers.test.ts |
| 305 | PENDING | -- | IT-ATT-010: mention edges created | appview/tests/integration/01-ingester-handlers.test.ts |
| 306 | PENDING | -- | IT-ATT-011: mention edges idempotent on replay | appview/tests/integration/01-ingester-handlers.test.ts |
| 307 | PENDING | -- | IT-ATT-012: Fix 9: dirty flags set — subject | appview/tests/integration/01-ingester-handlers.test.ts |
| 308 | PENDING | -- | IT-ATT-013: Fix 9: dirty flags set — author profile | appview/tests/integration/01-ingester-handlers.test.ts |
| 309 | PENDING | -- | IT-ATT-014: Fix 9: dirty flags set — mentioned DIDs | appview/tests/integration/01-ingester-handlers.test.ts |
| 310 | PENDING | -- | IT-ATT-015: Fix 9: dirty flags set — subject DID | appview/tests/integration/01-ingester-handlers.test.ts |
| 311 | PENDING | -- | IT-ATT-016: search content populated | appview/tests/integration/01-ingester-handlers.test.ts |
| 312 | PENDING | -- | IT-ATT-017: tsvector index functional | appview/tests/integration/01-ingester-handlers.test.ts |
| 313 | PENDING | -- | IT-ATT-018: Fix 1: idempotent upsert — replay same event | appview/tests/integration/01-ingester-handlers.test.ts |
| 314 | PENDING | -- | IT-ATT-019: Fix 1: upsert updates changed fields | appview/tests/integration/01-ingester-handlers.test.ts |
| 315 | PENDING | -- | IT-ATT-020: cosigner DID extracted | appview/tests/integration/01-ingester-handlers.test.ts |
| 316 | PENDING | -- | IT-ATT-021: agent-generated flag | appview/tests/integration/01-ingester-handlers.test.ts |
| 317 | PENDING | -- | IT-ATT-022: tags stored as array | appview/tests/integration/01-ingester-handlers.test.ts |
| 318 | PENDING | -- | IT-ATT-023: domain nullable | appview/tests/integration/01-ingester-handlers.test.ts |
| 319 | PENDING | -- | IT-VCH-001: create vouch — basic insert | appview/tests/integration/01-ingester-handlers.test.ts |
| 320 | PENDING | -- | IT-VCH-002: Fix 1: idempotent upsert | appview/tests/integration/01-ingester-handlers.test.ts |
| 321 | PENDING | -- | IT-VCH-003: trust edge created | appview/tests/integration/01-ingester-handlers.test.ts |
| 322 | PENDING | -- | IT-VCH-004: trust edge weight varies by confidence | appview/tests/integration/01-ingester-handlers.test.ts |
| 323 | PENDING | -- | IT-VCH-005: dirty flags set — subject DID | appview/tests/integration/01-ingester-handlers.test.ts |
| 324 | PENDING | -- | IT-VCH-006: dirty flags set — author DID | appview/tests/integration/01-ingester-handlers.test.ts |
| 325 | PENDING | -- | IT-END-001: create endorsement — basic insert | appview/tests/integration/01-ingester-handlers.test.ts |
| 326 | PENDING | -- | IT-END-002: Fix 1: idempotent upsert | appview/tests/integration/01-ingester-handlers.test.ts |
| 327 | PENDING | -- | IT-END-003: trust edge created | appview/tests/integration/01-ingester-handlers.test.ts |
| 328 | PENDING | -- | IT-END-004: dirty flags set | appview/tests/integration/01-ingester-handlers.test.ts |
| 329 | PENDING | -- | IT-FLG-001: create flag — basic insert | appview/tests/integration/01-ingester-handlers.test.ts |
| 330 | PENDING | -- | IT-FLG-002: Fix 1: idempotent upsert | appview/tests/integration/01-ingester-handlers.test.ts |
| 331 | PENDING | -- | IT-FLG-003: dirty flags set | appview/tests/integration/01-ingester-handlers.test.ts |
| 332 | PENDING | -- | IT-RPL-001: create reply — basic insert | appview/tests/integration/01-ingester-handlers.test.ts |
| 333 | PENDING | -- | IT-RPL-002: reply with intent  | appview/tests/integration/01-ingester-handlers.test.ts |
| 334 | PENDING | -- | IT-RPL-003: Fix 1: idempotent upsert | appview/tests/integration/01-ingester-handlers.test.ts |
| 335 | PENDING | -- | IT-RXN-001: create reaction — basic insert | appview/tests/integration/01-ingester-handlers.test.ts |
| 336 | PENDING | -- | IT-RXN-002: Fix 1: idempotent — onConflictDoNothing | appview/tests/integration/01-ingester-handlers.test.ts |
| 337 | PENDING | -- | IT-RXN-003: all reaction types | appview/tests/integration/01-ingester-handlers.test.ts |
| 338 | PENDING | -- | IT-RPT-001: create report — basic insert | appview/tests/integration/01-ingester-handlers.test.ts |
| 339 | PENDING | -- | IT-RPT-002: Fix 1: idempotent upsert | appview/tests/integration/01-ingester-handlers.test.ts |
| 340 | PENDING | -- | IT-RPT-003: all report types stored | appview/tests/integration/01-ingester-handlers.test.ts |
| 341 | PENDING | -- | IT-REV-001: create revocation — marks attestation as revoked | appview/tests/integration/01-ingester-handlers.test.ts |
| 342 | PENDING | -- | IT-REV-002: Fix 1: idempotent upsert | appview/tests/integration/01-ingester-handlers.test.ts |
| 343 | PENDING | -- | IT-REV-003: dirty flags set for revoked attestation\ | appview/tests/integration/01-ingester-handlers.test.ts |
| 344 | PENDING | -- | IT-DLG-001: create delegation — basic insert | appview/tests/integration/01-ingester-handlers.test.ts |
| 345 | PENDING | -- | IT-DLG-002: trust edge created | appview/tests/integration/01-ingester-handlers.test.ts |
| 346 | PENDING | -- | IT-DLG-003: Fix 1: idempotent upsert | appview/tests/integration/01-ingester-handlers.test.ts |
| 347 | PENDING | -- | IT-HND-001: collection handler — create + idempotent | appview/tests/integration/01-ingester-handlers.test.ts |
| 348 | PENDING | -- | IT-HND-002: media handler — create + idempotent | appview/tests/integration/01-ingester-handlers.test.ts |
| 349 | PENDING | -- | IT-HND-003: subject handler — create + idempotent | appview/tests/integration/01-ingester-handlers.test.ts |
| 350 | PENDING | -- | IT-HND-004: amendment handler — create + marks original | appview/tests/integration/01-ingester-handlers.test.ts |
| 351 | PENDING | -- | IT-HND-005: verification handler — create + idempotent | appview/tests/integration/01-ingester-handlers.test.ts |
| 352 | PENDING | -- | IT-HND-006: review-request handler — create + idempotent | appview/tests/integration/01-ingester-handlers.test.ts |
| 353 | PENDING | -- | IT-HND-007: comparison handler — create + idempotent | appview/tests/integration/01-ingester-handlers.test.ts |
| 354 | PENDING | -- | IT-HND-008: subject-claim handler — create + idempotent | appview/tests/integration/01-ingester-handlers.test.ts |
| 355 | PENDING | -- | IT-HND-009: trust-policy handler — create + idempotent | appview/tests/integration/01-ingester-handlers.test.ts |
| 356 | PENDING | -- | IT-HND-010: notification-prefs handler — create + idempotent | appview/tests/integration/01-ingester-handlers.test.ts |
| 357 | PENDING | -- | IT-DEL-001: clean delete — no disputes, no tombstone | appview/tests/integration/02-deletion-tombstones.test.ts |
| 358 | PENDING | -- | IT-DEL-002: clean delete — trust edge removed | appview/tests/integration/02-deletion-tombstones.test.ts |
| 359 | PENDING | -- | IT-DEL-003: clean delete metrics | appview/tests/integration/02-deletion-tombstones.test.ts |
| 360 | PENDING | -- | IT-DEL-004: disputed — has report → tombstone | appview/tests/integration/02-deletion-tombstones.test.ts |
| 361 | PENDING | -- | IT-DEL-005: disputed — has dispute reply → tombstone | appview/tests/integration/02-deletion-tombstones.test.ts |
| 362 | PENDING | -- | IT-DEL-006: disputed — has suspicious reaction → tombstone | appview/tests/integration/02-deletion-tombstones.test.ts |
| 363 | PENDING | -- | IT-DEL-007: tombstone preserves metadata | appview/tests/integration/02-deletion-tombstones.test.ts |
| 364 | PENDING | -- | IT-DEL-008: tombstone — durationDays calculated | appview/tests/integration/02-deletion-tombstones.test.ts |
| 365 | PENDING | -- | IT-DEL-009: tombstone — hadEvidence flag | appview/tests/integration/02-deletion-tombstones.test.ts |
| 366 | PENDING | -- | IT-DEL-010: tombstone — hadCosignature flag | appview/tests/integration/02-deletion-tombstones.test.ts |
| 367 | PENDING | -- | IT-DEL-011: tombstone — record still deleted | appview/tests/integration/02-deletion-tombstones.test.ts |
| 368 | PENDING | -- | IT-DEL-012: tombstone metrics | appview/tests/integration/02-deletion-tombstones.test.ts |
| 369 | PENDING | -- | IT-DEL-013: Fix 13: delete vouch → queries vouches table | appview/tests/integration/02-deletion-tombstones.test.ts |
| 370 | PENDING | -- | IT-DEL-014: Fix 13: delete flag → queries flags table | appview/tests/integration/02-deletion-tombstones.test.ts |
| 371 | PENDING | -- | IT-DEL-015: Fix 13: delete endorsement → queries endorsements table | appview/tests/integration/02-deletion-tombstones.test.ts |
| 372 | PENDING | -- | IT-DEL-016: Fix 13: delete reply → queries replies table | appview/tests/integration/02-deletion-tombstones.test.ts |
| 373 | PENDING | -- | IT-DEL-017: Fix 13: delete delegation → queries delegations table | appview/tests/integration/02-deletion-tombstones.test.ts |
| 374 | PENDING | -- | IT-DEL-018: Fix 13: delete report → queries report_records table | appview/tests/integration/02-deletion-tombstones.test.ts |
| 375 | PENDING | -- | IT-DEL-019: Fix 13: each deleted handler type → row actually removed | appview/tests/integration/02-deletion-tombstones.test.ts |
| 376 | PENDING | -- | IT-DEL-020: Fix 13: wrong table would miss tombstone | appview/tests/integration/02-deletion-tombstones.test.ts |
| 377 | PENDING | -- | IT-TE-001: vouch create → trust edge added | appview/tests/integration/03-trust-edge-sync.test.ts |
| 378 | PENDING | -- | IT-TE-002: endorsement create → trust edge added | appview/tests/integration/03-trust-edge-sync.test.ts |
| 379 | PENDING | -- | IT-TE-003: delegation create → trust edge added | appview/tests/integration/03-trust-edge-sync.test.ts |
| 380 | PENDING | -- | IT-TE-004: cosigned attestation → trust edge added | appview/tests/integration/03-trust-edge-sync.test.ts |
| 381 | PENDING | -- | IT-TE-005: positive DID attestation → trust edge added | appview/tests/integration/03-trust-edge-sync.test.ts |
| 382 | PENDING | -- | IT-TE-006: vouch delete → trust edge removed | appview/tests/integration/03-trust-edge-sync.test.ts |
| 383 | PENDING | -- | IT-TE-007: endorsement delete → trust edge removed | appview/tests/integration/03-trust-edge-sync.test.ts |
| 384 | PENDING | -- | IT-TE-008: delegation delete → trust edge removed | appview/tests/integration/03-trust-edge-sync.test.ts |
| 385 | PENDING | -- | IT-TE-009: Fix 1: idempotent edge creation | appview/tests/integration/03-trust-edge-sync.test.ts |
| 386 | PENDING | -- | IT-TE-010: multiple edge types from same author to same target | appview/tests/integration/03-trust-edge-sync.test.ts |
| 387 | PENDING | -- | IT-TE-011: negative DID attestation → no trust edge | appview/tests/integration/03-trust-edge-sync.test.ts |
| 388 | PENDING | -- | IT-TE-012: delete record with no trust edge → no-op | appview/tests/integration/03-trust-edge-sync.test.ts |
| 389 | PENDING | -- | IT-SUB-001: Fix 2: 50 concurrent creates → exactly 1 subject | appview/tests/integration/04-subject-resolution.test.ts |
| 390 | PENDING | -- | IT-SUB-002: Fix 2: concurrent creates — no errors | appview/tests/integration/04-subject-resolution.test.ts |
| 391 | PENDING | -- | IT-SUB-003: Fix 2: concurrent creates — all return same ID | appview/tests/integration/04-subject-resolution.test.ts |
| 392 | PENDING | -- | IT-SUB-004: Fix 10: progressive identifier enrichment | appview/tests/integration/04-subject-resolution.test.ts |
| 393 | PENDING | -- | IT-SUB-005: Fix 10: Tier 1 DID → globally deterministic | appview/tests/integration/04-subject-resolution.test.ts |
| 394 | PENDING | -- | IT-SUB-006: Fix 10: Tier 2 name-only → author-scoped | appview/tests/integration/04-subject-resolution.test.ts |
| 395 | PENDING | -- | IT-SUB-007: Fix 10: Tier 2 same author same name → deduplicated | appview/tests/integration/04-subject-resolution.test.ts |
| 396 | PENDING | -- | IT-SUB-008: simple merge — A → B | appview/tests/integration/04-subject-resolution.test.ts |
| 397 | PENDING | -- | IT-SUB-009: chain merge — A → B → C | appview/tests/integration/04-subject-resolution.test.ts |
| 398 | PENDING | -- | IT-SUB-010: cycle detection — A → B → A | appview/tests/integration/04-subject-resolution.test.ts |
| 399 | PENDING | -- | IT-SUB-011: max depth exceeded | appview/tests/integration/04-subject-resolution.test.ts |
| 400 | PENDING | -- | IT-SUB-012: processMerge — self-merge rejected | appview/tests/integration/04-subject-resolution.test.ts |
| 401 | PENDING | -- | IT-SUB-013: processMerge — cycle prevention | appview/tests/integration/04-subject-resolution.test.ts |
| 402 | PENDING | -- | IT-SUB-014: processMerge — both subjects marked dirty | appview/tests/integration/04-subject-resolution.test.ts |
| 403 | PENDING | -- | IT-SUB-015: resolve endpoint follows canonical chain | appview/tests/integration/04-subject-resolution.test.ts |
| 404 | PENDING | -- | IT-IDP-001: Fix 1: replay attestation 10 times → 1 row | appview/tests/integration/05-idempotency.test.ts |
| 405 | PENDING | -- | IT-IDP-002: Fix 1: replay vouch 10 times → 1 row | appview/tests/integration/05-idempotency.test.ts |
| 406 | PENDING | -- | IT-IDP-003: Fix 1: replay reaction → onConflictDoNothing | appview/tests/integration/05-idempotency.test.ts |
| 407 | PENDING | -- | IT-IDP-004: Fix 1: replay with changed data → updated | appview/tests/integration/05-idempotency.test.ts |
| 408 | PENDING | -- | IT-IDP-005: Fix 1: all 19 handler types — replay safe | appview/tests/integration/05-idempotency.test.ts |
| 409 | PENDING | -- | IT-IDP-006: Fix 1: crash simulation — cursor replay | appview/tests/integration/05-idempotency.test.ts |
| 410 | PENDING | -- | IT-IDP-007: Fix 1: concurrent replay — same event from two workers | appview/tests/integration/05-idempotency.test.ts |
| 411 | PENDING | -- | IT-BP-001: Fix 5: burst of 5000 events → bounded queue | appview/tests/integration/06-backpressure-watermark.test.ts |
| 412 | PENDING | -- | IT-BP-002: Fix 5: ws.pause() called at threshold | appview/tests/integration/06-backpressure-watermark.test.ts |
| 413 | PENDING | -- | IT-BP-003: Fix 5: ws.resume() at 50% drain | appview/tests/integration/06-backpressure-watermark.test.ts |
| 414 | PENDING | -- | IT-BP-004: Fix 5: all events eventually processed | appview/tests/integration/06-backpressure-watermark.test.ts |
| 415 | PENDING | -- | IT-BP-005: Fix 5: memory bounded | appview/tests/integration/06-backpressure-watermark.test.ts |
| 416 | PENDING | -- | IT-LW-001: Fix 7: slow event + fast event → cursor = slow - 1 | appview/tests/integration/06-backpressure-watermark.test.ts |
| 417 | PENDING | -- | IT-LW-002: Fix 7: all events complete → cursor = highestSeen | appview/tests/integration/06-backpressure-watermark.test.ts |
| 418 | PENDING | -- | IT-LW-003: Fix 7: crash mid-processing → replay from low watermark | appview/tests/integration/06-backpressure-watermark.test.ts |
| 419 | PENDING | -- | IT-LW-004: Fix 7: replay from low watermark → no data loss | appview/tests/integration/06-backpressure-watermark.test.ts |
| 420 | PENDING | -- | IT-LW-005: Fix 7: graceful shutdown saves low watermark | appview/tests/integration/06-backpressure-watermark.test.ts |
| 421 | PENDING | -- | IT-RL-001: Fix 11: 50 records → all written to DB | appview/tests/integration/07-rate-limiter.test.ts |
| 422 | PENDING | -- | IT-RL-002: Fix 11: 51st record → dropped, no DB write | appview/tests/integration/07-rate-limiter.test.ts |
| 423 | PENDING | -- | IT-RL-003: Fix 11: rate-limited DID → zero DB I/O | appview/tests/integration/07-rate-limiter.test.ts |
| 424 | PENDING | -- | IT-RL-004: Fix 11: quarantine feeds sybil detection | appview/tests/integration/07-rate-limiter.test.ts |
| 425 | PENDING | -- | IT-RL-005: Fix 11: different DIDs not affected | appview/tests/integration/07-rate-limiter.test.ts |
| 426 | PENDING | -- | IT-GR-001: direct trust edge exists → shortestPath = 1 | appview/tests/integration/08-graph-queries.test.ts |
| 427 | PENDING | -- | IT-GR-002: no direct edge → shortestPath != 1 | appview/tests/integration/08-graph-queries.test.ts |
| 428 | PENDING | -- | IT-GR-003: trusted attestors — 1 hop | appview/tests/integration/08-graph-queries.test.ts |
| 429 | PENDING | -- | IT-GR-004: trusted attestors — limit by MAX_EDGES_PER_HOP | appview/tests/integration/08-graph-queries.test.ts |
| 430 | PENDING | -- | IT-GR-005: trusted attestors — only non-revoked edges counted | appview/tests/integration/08-graph-queries.test.ts |
| 431 | PENDING | -- | IT-GR-006: two-hop path exists → shortestPath = 2 | appview/tests/integration/08-graph-queries.test.ts |
| 432 | PENDING | -- | IT-GR-007: prefers 1-hop over 2-hop | appview/tests/integration/08-graph-queries.test.ts |
| 433 | PENDING | -- | IT-GR-008: no 2-hop path → node not in graph | appview/tests/integration/08-graph-queries.test.ts |
| 434 | PENDING | -- | IT-GR-009: 2-hop fan-out capped at MAX_EDGES_PER_HOP | appview/tests/integration/08-graph-queries.test.ts |
| 435 | PENDING | -- | IT-GR-010: mutual connections — simple case | appview/tests/integration/08-graph-queries.test.ts |
| 436 | PENDING | -- | IT-GR-011: mutual connections — zero | appview/tests/integration/08-graph-queries.test.ts |
| 437 | PENDING | -- | IT-GR-012: mutual connections — multiple | appview/tests/integration/08-graph-queries.test.ts |
| 438 | PENDING | -- | IT-GR-013: Fix 3: super-node fan-out capped | appview/tests/integration/08-graph-queries.test.ts |
| 439 | PENDING | -- | IT-GR-014: Fix 3: statement timeout → graceful null | appview/tests/integration/08-graph-queries.test.ts |
| 440 | PENDING | -- | IT-GR-015: Fix 3: rest of resolve response proceeds | appview/tests/integration/08-graph-queries.test.ts |
| 441 | PENDING | -- | IT-GR-016: Fix 4: timeout doesn\ | appview/tests/integration/08-graph-queries.test.ts |
| 442 | PENDING | -- | IT-GR-017: Fix 4: SET LOCAL scoped to transaction | appview/tests/integration/08-graph-queries.test.ts |
| 443 | PENDING | -- | IT-GR-018: graph visualization — getGraphAroundDid | appview/tests/integration/08-graph-queries.test.ts |
| 444 | PENDING | -- | IT-GR-019: graph visualization — domain filter | appview/tests/integration/08-graph-queries.test.ts |
| 445 | PENDING | -- | IT-GR-020: graph visualization — depth cap at 2 | appview/tests/integration/08-graph-queries.test.ts |
| 446 | PENDING | -- | IT-SC-001: Fix 9: only dirty profiles processed | appview/tests/integration/09-scorer-jobs.test.ts |
| 447 | PENDING | -- | IT-SC-002: Fix 9: clean profiles not updated | appview/tests/integration/09-scorer-jobs.test.ts |
| 448 | PENDING | -- | IT-SC-003: Fix 9: dirty flag flipped to false after processing | appview/tests/integration/09-scorer-jobs.test.ts |
| 449 | PENDING | -- | IT-SC-004: Fix 9: BATCH_SIZE respected | appview/tests/integration/09-scorer-jobs.test.ts |
| 450 | PENDING | -- | IT-SC-005: Fix 9: overflow detection | appview/tests/integration/09-scorer-jobs.test.ts |
| 451 | PENDING | -- | IT-SC-006: no dirty profiles → no-op | appview/tests/integration/09-scorer-jobs.test.ts |
| 452 | PENDING | -- | IT-SC-007: new DID → profile created by dirty flag | appview/tests/integration/09-scorer-jobs.test.ts |
| 453 | PENDING | -- | IT-SC-008: profile fields computed correctly | appview/tests/integration/09-scorer-jobs.test.ts |
| 454 | PENDING | -- | IT-SC-009: overallTrustScore computed via computeTrustScore | appview/tests/integration/09-scorer-jobs.test.ts |
| 455 | PENDING | -- | IT-SC-010: error in one profile doesn\ | appview/tests/integration/09-scorer-jobs.test.ts |
| 456 | PENDING | -- | IT-SC-011: Fix 9: only dirty subjects processed | appview/tests/integration/09-scorer-jobs.test.ts |
| 457 | PENDING | -- | IT-SC-012: Fix 9: dirty flag flipped | appview/tests/integration/09-scorer-jobs.test.ts |
| 458 | PENDING | -- | IT-SC-013: subject score aggregation | appview/tests/integration/09-scorer-jobs.test.ts |
| 459 | PENDING | -- | IT-SC-014: dimension summary aggregation | appview/tests/integration/09-scorer-jobs.test.ts |
| 460 | PENDING | -- | IT-SC-015: attestation velocity computed | appview/tests/integration/09-scorer-jobs.test.ts |
| 461 | PENDING | -- | IT-SC-016: verified attestation count | appview/tests/integration/09-scorer-jobs.test.ts |
| 462 | PENDING | -- | IT-SC-017: Fix 12: iterative scoring converges within 5 ticks | appview/tests/integration/09-scorer-jobs.test.ts |
| 463 | PENDING | -- | IT-SC-018: Fix 12: unvouched sybils → zero weight | appview/tests/integration/09-scorer-jobs.test.ts |
| 464 | PENDING | -- | IT-SC-019: Fix 12: one real vouch breaks sybil ceiling | appview/tests/integration/09-scorer-jobs.test.ts |
| 465 | PENDING | -- | IT-SC-020: Fix 12: damping factor prevents collapse | appview/tests/integration/09-scorer-jobs.test.ts |
| 466 | PENDING | -- | IT-SC-021: Fix 12: vouch-gating — scored but unvouched = zero | appview/tests/integration/09-scorer-jobs.test.ts |
| 467 | PENDING | -- | IT-SC-022: temporal burst detected | appview/tests/integration/09-scorer-jobs.test.ts |
| 468 | PENDING | -- | IT-SC-023: normal traffic not flagged | appview/tests/integration/09-scorer-jobs.test.ts |
| 469 | PENDING | -- | IT-SC-024: coordination window — 48 hours | appview/tests/integration/09-scorer-jobs.test.ts |
| 470 | PENDING | -- | IT-SC-025: coordination flags propagated to profiles | appview/tests/integration/09-scorer-jobs.test.ts |
| 471 | PENDING | -- | IT-SC-026: sybil cluster — minimum 3 DIDs | appview/tests/integration/09-scorer-jobs.test.ts |
| 472 | PENDING | -- | IT-SC-027: 2 correlated DIDs — below threshold | appview/tests/integration/09-scorer-jobs.test.ts |
| 473 | PENDING | -- | IT-SC-028: quarantined DIDs accelerate detection | appview/tests/integration/09-scorer-jobs.test.ts |
| 474 | PENDING | -- | IT-SC-029: tombstone patterns aggregated per DID | appview/tests/integration/09-scorer-jobs.test.ts |
| 475 | PENDING | -- | IT-SC-030: tombstone threshold → trust penalty | appview/tests/integration/09-scorer-jobs.test.ts |
| 476 | PENDING | -- | IT-SC-031: old scores decayed | appview/tests/integration/09-scorer-jobs.test.ts |
| 477 | PENDING | -- | IT-SC-032: recent scores not decayed | appview/tests/integration/09-scorer-jobs.test.ts |
| 478 | PENDING | -- | IT-SC-033: expired delegations removed | appview/tests/integration/09-scorer-jobs.test.ts |
| 479 | PENDING | -- | IT-SC-034: expired review requests removed | appview/tests/integration/09-scorer-jobs.test.ts |
| 480 | PENDING | -- | IT-SC-035: non-expired records untouched | appview/tests/integration/09-scorer-jobs.test.ts |
| 481 | PENDING | -- | IT-SC-036: reviewer stats computed from attestations | appview/tests/integration/09-scorer-jobs.test.ts |
| 482 | PENDING | -- | IT-SC-037: reviewer stats — agent detection | appview/tests/integration/09-scorer-jobs.test.ts |
| 483 | PENDING | -- | IT-SC-038: reviewer stats — active domains extracted | appview/tests/integration/09-scorer-jobs.test.ts |
| 484 | PENDING | -- | IT-SC-039: domain scores computed per DID per domain | appview/tests/integration/09-scorer-jobs.test.ts |
| 485 | PENDING | -- | IT-SC-040: domain score uses domain-specific attestations only | appview/tests/integration/09-scorer-jobs.test.ts |
| 486 | PENDING | -- | IT-SC-041: domain scores — DID with no domain attestations | appview/tests/integration/09-scorer-jobs.test.ts |
| 487 | PENDING | -- | IT-SC-042: MEDIUM-08: process-tombstones sets coordinationFlagCount idempotently | appview/tests/integration/09-scorer-jobs.test.ts |
| 488 | PENDING | -- | IT-SC-043: MEDIUM-07: detect-sybil resolves DIDs via subjects table join | appview/tests/integration/09-scorer-jobs.test.ts |
| 489 | PENDING | -- | IT-SC-044: HIGH-10: refresh-profiles uses verifications table for isVerified | appview/tests/integration/09-scorer-jobs.test.ts |
| 490 | PENDING | -- | IT-API-001: resolve -- DID subject with scores | appview/tests/integration/10-api-endpoints.test.ts |
| 491 | PENDING | -- | IT-API-002: resolve -- subject not found | appview/tests/integration/10-api-endpoints.test.ts |
| 492 | PENDING | -- | IT-API-003: resolve -- invalid params | appview/tests/integration/10-api-endpoints.test.ts |
| 493 | PENDING | -- | IT-API-004: resolve -- DID profile included | appview/tests/integration/10-api-endpoints.test.ts |
| 494 | PENDING | -- | IT-API-005: resolve -- flags included | appview/tests/integration/10-api-endpoints.test.ts |
| 495 | PENDING | -- | IT-API-006: resolve -- graph context (with requesterDid) | appview/tests/integration/10-api-endpoints.test.ts |
| 496 | PENDING | -- | IT-API-007: resolve -- graph context null (no requesterDid) | appview/tests/integration/10-api-endpoints.test.ts |
| 497 | PENDING | -- | IT-API-008: resolve -- authenticity consensus | appview/tests/integration/10-api-endpoints.test.ts |
| 498 | PENDING | -- | IT-API-009: resolve -- recommendation computed | appview/tests/integration/10-api-endpoints.test.ts |
| 499 | PENDING | -- | IT-API-010: resolve -- context affects recommendation | appview/tests/integration/10-api-endpoints.test.ts |
| 500 | PENDING | -- | IT-API-010a: resolve -- malformed subject JSON -> error | appview/tests/integration/10-api-endpoints.test.ts |
| 501 | PENDING | -- | IT-API-010b: resolve -- domain-specific score used when available | appview/tests/integration/10-api-endpoints.test.ts |
| 502 | PENDING | -- | IT-API-011: Fix 6: concurrent resolves coalesced | appview/tests/integration/10-api-endpoints.test.ts |
| 503 | PENDING | -- | IT-API-012: Fix 6: stale-while-revalidate | appview/tests/integration/10-api-endpoints.test.ts |
| 504 | PENDING | -- | IT-API-013: Fix 6: different subjects -> separate entries | appview/tests/integration/10-api-endpoints.test.ts |
| 505 | PENDING | -- | IT-API-014: Fix 6: cache key includes requesterDid | appview/tests/integration/10-api-endpoints.test.ts |
| 506 | PENDING | -- | IT-API-015: search -- full-text query (category filter fallback) | appview/tests/integration/10-api-endpoints.test.ts |
| 507 | PENDING | -- | IT-API-016: search -- category filter | appview/tests/integration/10-api-endpoints.test.ts |
| 508 | PENDING | -- | IT-API-017: search -- domain filter | appview/tests/integration/10-api-endpoints.test.ts |
| 509 | PENDING | -- | IT-API-018: search -- sentiment filter | appview/tests/integration/10-api-endpoints.test.ts |
| 510 | PENDING | -- | IT-API-019: search -- authorDid filter | appview/tests/integration/10-api-endpoints.test.ts |
| 511 | PENDING | -- | IT-API-020: search -- tags filter | appview/tests/integration/10-api-endpoints.test.ts |
| 512 | PENDING | -- | IT-API-021: search -- date range (since/until) | appview/tests/integration/10-api-endpoints.test.ts |
| 513 | PENDING | -- | IT-API-022: search -- sort by recent | appview/tests/integration/10-api-endpoints.test.ts |
| 514 | PENDING | -- | IT-API-023: search -- sort by relevant (with q) falls back | appview/tests/integration/10-api-endpoints.test.ts |
| 515 | PENDING | -- | IT-API-024: search -- pagination cursor | appview/tests/integration/10-api-endpoints.test.ts |
| 516 | PENDING | -- | IT-API-025: search -- limit respected | appview/tests/integration/10-api-endpoints.test.ts |
| 517 | PENDING | -- | IT-API-026: search -- excludes revoked attestations | appview/tests/integration/10-api-endpoints.test.ts |
| 518 | PENDING | -- | IT-API-027: search -- empty results | appview/tests/integration/10-api-endpoints.test.ts |
| 519 | PENDING | -- | IT-API-028: search -- invalid params (limit exceeds max) | appview/tests/integration/10-api-endpoints.test.ts |
| 520 | PENDING | -- | IT-API-029: search -- subjectType filter | appview/tests/integration/10-api-endpoints.test.ts |
| 521 | PENDING | -- | IT-API-030: search -- minConfidence filter | appview/tests/integration/10-api-endpoints.test.ts |
| 522 | PENDING | -- | IT-API-031: get profile -- existing DID | appview/tests/integration/10-api-endpoints.test.ts |
| 523 | PENDING | -- | IT-API-032: get profile -- non-existent DID | appview/tests/integration/10-api-endpoints.test.ts |
| 524 | PENDING | -- | IT-API-033: get profile -- includes reviewer stats | appview/tests/integration/10-api-endpoints.test.ts |
| 525 | PENDING | -- | IT-API-034: get profile -- includes trust score | appview/tests/integration/10-api-endpoints.test.ts |
| 526 | PENDING | -- | IT-API-035: get attestations -- by subject | appview/tests/integration/10-api-endpoints.test.ts |
| 527 | PENDING | -- | IT-API-036: get attestations -- by author | appview/tests/integration/10-api-endpoints.test.ts |
| 528 | PENDING | -- | IT-API-037: get attestations -- pagination | appview/tests/integration/10-api-endpoints.test.ts |
| 529 | PENDING | -- | IT-API-038: get attestations -- includes thread replies | appview/tests/integration/10-api-endpoints.test.ts |
| 530 | PENDING | -- | IT-API-039: get graph -- center DID | appview/tests/integration/10-api-endpoints.test.ts |
| 531 | PENDING | -- | IT-API-040: get graph -- depth limit | appview/tests/integration/10-api-endpoints.test.ts |
| 532 | PENDING | -- | IT-API-041: get graph -- domain filter | appview/tests/integration/10-api-endpoints.test.ts |
| 533 | PENDING | -- | IT-API-042: get graph -- empty graph | appview/tests/integration/10-api-endpoints.test.ts |
| 534 | PENDING | -- | IT-API-043: MEDIUM-01: resolve rejects overlong subject | appview/tests/integration/10-api-endpoints.test.ts |
| 535 | PENDING | -- | IT-API-044: MEDIUM-05: resolve only returns active flags | appview/tests/integration/10-api-endpoints.test.ts |
| 536 | PENDING | -- | IT-API-045: MEDIUM-04/HIGH-08: search uses composite cursor for stable pagination | appview/tests/integration/10-api-endpoints.test.ts |
| 537 | PENDING | -- | IT-API-046: MEDIUM-04: get-attestations cursor actually filters results | appview/tests/integration/10-api-endpoints.test.ts |
| 538 | PENDING | -- | IT-DB-001: migrations run cleanly | appview/tests/integration/11-database-schema.test.ts |
| 539 | PENDING | -- | IT-DB-002: all 27 tables exist | appview/tests/integration/11-database-schema.test.ts |
| 540 | PENDING | -- | IT-DB-003: attestations -- primary key on uri | appview/tests/integration/11-database-schema.test.ts |
| 541 | PENDING | -- | IT-DB-004: trust_edges -- unique on sourceUri | appview/tests/integration/11-database-schema.test.ts |
| 542 | PENDING | -- | IT-DB-005: tombstones -- unique on originalUri | appview/tests/integration/11-database-schema.test.ts |
| 543 | PENDING | -- | IT-DB-006: subjects -- primary key on id | appview/tests/integration/11-database-schema.test.ts |
| 544 | PENDING | -- | IT-DB-007: did_profiles -- primary key on did | appview/tests/integration/11-database-schema.test.ts |
| 545 | PENDING | -- | IT-DB-008: subject_scores -- primary key on subjectId | appview/tests/integration/11-database-schema.test.ts |
| 546 | PENDING | -- | IT-DB-009: subject_scores -- foreign key to subjects | appview/tests/integration/11-database-schema.test.ts |
| 547 | PENDING | -- | IT-DB-010: attestations indexes exist | appview/tests/integration/11-database-schema.test.ts |
| 548 | PENDING | -- | IT-DB-011: trust_edges indexes exist | appview/tests/integration/11-database-schema.test.ts |
| 549 | PENDING | -- | IT-DB-012: Fix 9: partial index on needs_recalc (did_profiles) | appview/tests/integration/11-database-schema.test.ts |
| 550 | PENDING | -- | IT-DB-013: Fix 9: partial index on subject_scores | appview/tests/integration/11-database-schema.test.ts |
| 551 | PENDING | -- | IT-DB-014: GIN index on tags | appview/tests/integration/11-database-schema.test.ts |
| 552 | PENDING | -- | IT-DB-015: GIN index on identifiers_json | appview/tests/integration/11-database-schema.test.ts |
| 553 | PENDING | -- | IT-DB-016: tsvector search index | appview/tests/integration/11-database-schema.test.ts |
| 554 | PENDING | -- | IT-DB-017: partial index on author_scoped_did | appview/tests/integration/11-database-schema.test.ts |
| 555 | PENDING | -- | IT-DB-018: partial index on canonical_subject_id | appview/tests/integration/11-database-schema.test.ts |
| 556 | PENDING | -- | IT-DB-019: tombstone indexes exist | appview/tests/integration/11-database-schema.test.ts |
| 557 | PENDING | -- | IT-DB-020: subjects DID index exists | appview/tests/integration/11-database-schema.test.ts |
| 558 | PENDING | -- | IT-DB-021: domain_scores table exists with indexes | appview/tests/integration/11-database-schema.test.ts |
| 559 | PENDING | -- | IT-DB-022: attestation lookup by subject -- uses index | appview/tests/integration/11-database-schema.test.ts |
| 560 | PENDING | -- | IT-DB-023: trust_edge lookup by from_did -- uses index | appview/tests/integration/11-database-schema.test.ts |
| 561 | PENDING | -- | IT-DB-024: dirty flag query -- uses partial index | appview/tests/integration/11-database-schema.test.ts |
| 562 | PENDING | -- | IT-DB-025: full-text search -- uses GIN index | appview/tests/integration/11-database-schema.test.ts |
| 563 | PENDING | -- | IT-DF-001: markDirty -- creates subject_scores row if not exists | appview/tests/integration/12-dirty-flags.test.ts |
| 564 | PENDING | -- | IT-DF-002: markDirty -- creates did_profiles row if not exists | appview/tests/integration/12-dirty-flags.test.ts |
| 565 | PENDING | -- | IT-DF-003: markDirty -- sets existing row dirty | appview/tests/integration/12-dirty-flags.test.ts |
| 566 | PENDING | -- | IT-DF-004: markDirty -- author always marked | appview/tests/integration/12-dirty-flags.test.ts |
| 567 | PENDING | -- | IT-DF-005: markDirty -- subject DID marked (when DID type) | appview/tests/integration/12-dirty-flags.test.ts |
| 568 | PENDING | -- | IT-DF-006: markDirty -- cosigner marked | appview/tests/integration/12-dirty-flags.test.ts |
| 569 | PENDING | -- | IT-DF-007: markDirty -- mentioned DIDs marked | appview/tests/integration/12-dirty-flags.test.ts |
| 570 | PENDING | -- | IT-DF-008: markDirty -- subject_scores marked | appview/tests/integration/12-dirty-flags.test.ts |
| 571 | PENDING | -- | IT-DF-009: cascade: attestation -> dirty -> scorer refresh -> clean | appview/tests/integration/12-dirty-flags.test.ts |
| 572 | PENDING | -- | IT-CUR-001: loadCursor -- no prior cursor -> 0 | appview/tests/integration/13-cursor-management.test.ts |
| 573 | PENDING | -- | IT-CUR-002: saveCursor -> loadCursor round-trip | appview/tests/integration/13-cursor-management.test.ts |
| 574 | PENDING | -- | IT-CUR-003: saveCursor -- upsert on conflict | appview/tests/integration/13-cursor-management.test.ts |
| 575 | PENDING | -- | IT-CUR-004: cursor per service URL | appview/tests/integration/13-cursor-management.test.ts |
| 576 | PENDING | -- | IT-CUR-005: Fix 7: low watermark cursor value | appview/tests/integration/13-cursor-management.test.ts |
| 577 | PENDING | -- | IT-CUR-006: HIGH-04: cursor includes failed event timestamps | appview/tests/integration/13-cursor-management.test.ts |
| 578 | PENDING | -- | IT-BF-001: backfill from mock PDS -- single DID | appview/tests/integration/14-backfill-script.test.ts |
| 579 | PENDING | -- | IT-BF-002: backfill -- idempotent replay | appview/tests/integration/14-backfill-script.test.ts |
| 580 | PENDING | -- | IT-BF-003: backfill -- multiple collections | appview/tests/integration/14-backfill-script.test.ts |
| 581 | PENDING | -- | IT-BF-004: backfill -- rate limiting applied | appview/tests/integration/14-backfill-script.test.ts |
| 582 | PENDING | -- | IT-BF-005: backfill -- invalid records skipped | appview/tests/integration/14-backfill-script.test.ts |
| 583 | PENDING | -- | IT-BF-006: backfill -- concurrent PDS connections | appview/tests/integration/14-backfill-script.test.ts |
| 584 | PENDING | -- | IT-BF-007: backfill -- PDS failure does not stop others | appview/tests/integration/14-backfill-script.test.ts |
| 585 | PENDING | -- | IT-BF-008: backfill -- pagination (cursor-based) | appview/tests/integration/14-backfill-script.test.ts |
| 586 | PENDING | -- | IT-BF-009: backfill -> live transition seamless | appview/tests/integration/14-backfill-script.test.ts |
| 587 | PENDING | -- | IT-BF-010: backfill -- filterDids limits scope | appview/tests/integration/14-backfill-script.test.ts |
| 588 | PENDING | -- | IT-LBL-001: fake-review detector -- correlated timing | appview/tests/integration/15-label-service.test.ts |
| 589 | PENDING | -- | IT-LBL-002: ai-generated detector -- undisclosed | appview/tests/integration/15-label-service.test.ts |
| 590 | PENDING | -- | IT-LBL-003: self-promotion detector | appview/tests/integration/15-label-service.test.ts |
| 591 | PENDING | -- | IT-LBL-004: coordinated detector | appview/tests/integration/15-label-service.test.ts |
| 592 | PENDING | -- | IT-LBL-005: conflict-of-interest detector | appview/tests/integration/15-label-service.test.ts |
| 593 | PENDING | -- | IT-LBL-006: no labels for clean reviews | appview/tests/integration/15-label-service.test.ts |
| 594 | PENDING | -- | IT-DCK-001: postgres container healthy | appview/tests/integration/16-docker-integration.test.ts |
| 595 | PENDING | -- | IT-DCK-002: jetstream container healthy | appview/tests/integration/16-docker-integration.test.ts |
| 596 | PENDING | -- | IT-DCK-003: ingester connects to postgres + jetstream | appview/tests/integration/16-docker-integration.test.ts |
| 597 | PENDING | -- | IT-DCK-004: scorer connects to postgres | appview/tests/integration/16-docker-integration.test.ts |
| 598 | PENDING | -- | IT-DCK-005: web container serves health endpoint | appview/tests/integration/16-docker-integration.test.ts |
| 599 | PENDING | -- | IT-DCK-006: migrations run on startup | appview/tests/integration/16-docker-integration.test.ts |
| 600 | PENDING | -- | IT-DCK-007: HIGH-11: migrate service configuration exists | appview/tests/integration/16-docker-integration.test.ts |
| 601 | PENDING | -- | IT-DCK-008: HIGH-08: search_vector migration creates tsvector column | appview/tests/integration/16-docker-integration.test.ts |
| 602 | PENDING | -- | IT-DCK-009: HIGH-09: web server health endpoint responds | appview/tests/integration/16-docker-integration.test.ts |
| 603 | PENDING | -- | IT-E2E-001: attestation -> ingester -> DB -> scorer -> API -> page | appview/tests/integration/17-end-to-end-flows.test.ts |
| 604 | PENDING | -- | IT-E2E-002: vouch -> trust edge -> graph query | appview/tests/integration/17-end-to-end-flows.test.ts |
| 605 | PENDING | -- | IT-E2E-003: disputed delete -> tombstone -> profile penalty | appview/tests/integration/17-end-to-end-flows.test.ts |
| 606 | PENDING | -- | IT-E2E-004: subject merge -> canonical resolution | appview/tests/integration/17-end-to-end-flows.test.ts |
| 607 | PENDING | -- | IT-E2E-005: search flow | appview/tests/integration/17-end-to-end-flows.test.ts |
| 608 | PENDING | -- | IT-E2E-006: subject page renders | appview/tests/integration/17-end-to-end-flows.test.ts |
| 609 | PENDING | -- | IT-E2E-007: subject page shows score | appview/tests/integration/17-end-to-end-flows.test.ts |
| 610 | PENDING | -- | IT-E2E-008: subject page shows dimensions | appview/tests/integration/17-end-to-end-flows.test.ts |
| 611 | PENDING | -- | IT-E2E-009: search page -- text query | appview/tests/integration/17-end-to-end-flows.test.ts |
| 612 | PENDING | -- | IT-E2E-010: search page -- filter by category | appview/tests/integration/17-end-to-end-flows.test.ts |
| 613 | PENDING | -- | IT-E2E-011: search page -- pagination | appview/tests/integration/17-end-to-end-flows.test.ts |
| 614 | PENDING | -- | IT-WEB-001: HIGH-09: /health endpoint contract | appview/tests/integration/18-web-server.test.ts |
| 615 | PENDING | -- | IT-WEB-002: HIGH-09: resolve route validates params via ResolveParams | appview/tests/integration/18-web-server.test.ts |
| 616 | PENDING | -- | IT-WEB-003: HIGH-09: search route validates params via SearchParams | appview/tests/integration/18-web-server.test.ts |
| 617 | PENDING | -- | IT-WEB-004: HIGH-09: all 5 XRPC routes have valid param schemas | appview/tests/integration/18-web-server.test.ts |
| 618 | PENDING | -- | IT-WEB-005: HIGH-09: unknown XRPC method returns error shape | appview/tests/integration/18-web-server.test.ts |

## LEGACY (0/220 tagged -- 0%)

| # | Status | Current Tag | Name Status | Test Function | File |
|---|--------|------------|-------------|---------------|------|
| 1 | PENDING | -- | PENDING | test_empty_dir_reports_all_missing | tests/test_bootstrap.py |
| 2 | PENDING | -- | PENDING | test_complete_install_passes | tests/test_bootstrap.py |
| 3 | PENDING | -- | PENDING | test_empty_key_dirs_detected | tests/test_bootstrap.py |
| 4 | PENDING | -- | PENDING | test_missing_single_file_detected | tests/test_bootstrap.py |
| 5 | PENDING | -- | PENDING | test_backfills_missing_session | tests/test_bootstrap.py |
| 6 | PENDING | -- | PENDING | test_backfills_missing_ports | tests/test_bootstrap.py |
| 7 | PENDING | -- | PENDING | test_backfills_pds_secrets | tests/test_bootstrap.py |
| 8 | PENDING | -- | PENDING | test_skips_existing_keys | tests/test_bootstrap.py |
| 9 | PENDING | -- | PENDING | test_core_port_avoids_existing_pds_port | tests/test_bootstrap.py |
| 10 | PENDING | -- | PENDING | test_pds_port_avoids_existing_core_port | tests/test_bootstrap.py |
| 11 | PENDING | -- | PENDING | test_compose_project_name_backfilled_independently | tests/test_bootstrap.py |
| 12 | PENDING | -- | PENDING | test_backfills_missing_pds_port_independently | tests/test_bootstrap.py |
| 13 | PENDING | -- | PENDING | test_backfills_missing_pds_secrets_independently | tests/test_bootstrap.py |
| 14 | PENDING | -- | PENDING | test_has_llm_provider_detects_each | tests/test_bootstrap.py |
| 15 | PENDING | -- | PENDING | test_has_llm_provider_returns_false_when_empty | tests/test_bootstrap.py |
| 16 | PENDING | -- | PENDING | test_has_telegram_detects_token | tests/test_bootstrap.py |
| 17 | PENDING | -- | PENDING | test_has_telegram_returns_false_when_missing | tests/test_bootstrap.py |
| 18 | PENDING | -- | PENDING | test_install_sh_sources_modules_from_any_cwd | tests/test_bootstrap.py |
| 19 | PENDING | -- | PENDING | test_refuses_install_non_interactive | tests/test_bootstrap.py |
| 20 | PENDING | -- | PENDING | test_refuses_partial_install_non_interactive | tests/test_bootstrap.py |
| 21 | PENDING | -- | PENDING | test_ensure_required_env_called_on_startup | tests/test_bootstrap.py |
| 22 | PENDING | -- | PENDING | test_prints_did_document | tests/test_chat_integration.py |
| 23 | PENDING | -- | PENDING | test_did_document_has_correct_did | tests/test_chat_integration.py |
| 24 | PENDING | -- | PENDING | test_verification_method_type | tests/test_chat_integration.py |
| 25 | PENDING | -- | PENDING | test_verify_signed_verdict | tests/test_chat_integration.py |
| 26 | PENDING | -- | PENDING | test_verify_nonexistent_video | tests/test_chat_integration.py |
| 27 | PENDING | -- | PENDING | test_verify_unsigned_verdict | tests/test_chat_integration.py |
| 28 | PENDING | -- | PENDING | test_verify_tampered_signature | tests/test_chat_integration.py |
| 29 | PENDING | -- | PENDING | test_verify_with_wrong_identity | tests/test_chat_integration.py |
| 30 | PENDING | -- | PENDING | test_history_empty | tests/test_chat_integration.py |
| 31 | PENDING | -- | PENDING | test_history_shows_signed_indicator | tests/test_chat_integration.py |
| 32 | PENDING | -- | PENDING | test_history_unsigned_no_indicator | tests/test_chat_integration.py |
| 33 | PENDING | -- | PENDING | test_history_shows_ceramic_indicator | tests/test_chat_integration.py |
| 34 | PENDING | -- | PENDING | test_url_handler_signs_verdict_transcript_path | tests/test_chat_integration.py |
| 35 | PENDING | -- | PENDING | test_url_handler_signature_verifies | tests/test_chat_integration.py |
| 36 | PENDING | -- | PENDING | test_url_handler_video_path | tests/test_chat_integration.py |
| 37 | PENDING | -- | PENDING | test_dual_write_stores_stream_id | tests/test_chat_integration.py |
| 38 | PENDING | -- | PENDING | test_vault_publish_called_with_correct_args | tests/test_chat_integration.py |
| 39 | PENDING | -- | PENDING | test_chromadb_still_works_on_vault_failure | tests/test_chat_integration.py |
| 40 | PENDING | -- | PENDING | test_vault_disabled_message | tests/test_chat_integration.py |
| 41 | PENDING | -- | PENDING | test_vault_disabled_when_not_enabled | tests/test_chat_integration.py |
| 42 | PENDING | -- | PENDING | test_vault_shows_status | tests/test_chat_integration.py |
| 43 | PENDING | -- | PENDING | test_banner_version | tests/test_chat_integration.py |
| 44 | PENDING | -- | PENDING | test_banner_mentions_identity_command | tests/test_chat_integration.py |
| 45 | PENDING | -- | PENDING | test_banner_mentions_verify_command | tests/test_chat_integration.py |
| 46 | PENDING | -- | PENDING | test_banner_mentions_vault_command | tests/test_chat_integration.py |
| 47 | PENDING | -- | PENDING | test_banner_shows_provider_info | tests/test_chat_integration.py |
| 48 | PENDING | -- | PENDING | test_banner_shows_vault_status | tests/test_chat_integration.py |
| 49 | PENDING | -- | PENDING | test_identity_command_routes | tests/test_chat_integration.py |
| 50 | PENDING | -- | PENDING | test_verify_command_without_arg | tests/test_chat_integration.py |
| 51 | PENDING | -- | PENDING | test_vault_command_routes | tests/test_chat_integration.py |
| 52 | PENDING | -- | PENDING | test_unknown_command_lists_all_commands | tests/test_chat_integration.py |
| 53 | PENDING | -- | PENDING | test_quit_command | tests/test_chat_integration.py |
| 54 | PENDING | -- | PENDING | test_eof_exits | tests/test_chat_integration.py |
| 55 | PENDING | -- | PENDING | test_keyboard_interrupt_exits | tests/test_chat_integration.py |
| 56 | PENDING | -- | PENDING | test_starts_with_did_key_z | tests/test_did_key.py |
| 57 | PENDING | -- | PENDING | test_multibase_prefix_z_means_base58btc | tests/test_did_key.py |
| 58 | PENDING | -- | PENDING | test_encoded_key_decodes_to_correct_prefix | tests/test_did_key.py |
| 59 | PENDING | -- | PENDING | test_encoded_key_contains_public_key | tests/test_did_key.py |
| 60 | PENDING | -- | PENDING | test_deterministic | tests/test_did_key.py |
| 61 | PENDING | -- | PENDING | test_different_identities_produce_different_dids | tests/test_did_key.py |
| 62 | PENDING | -- | PENDING | test_did_key_starts_with_z6Mk | tests/test_did_key.py |
| 63 | PENDING | -- | PENDING | test_reload_identity_same_did | tests/test_did_key.py |
| 64 | PENDING | -- | PENDING | test_document_id_matches_did | tests/test_did_key.py |
| 65 | PENDING | -- | PENDING | test_has_one_verification_method | tests/test_did_key.py |
| 66 | PENDING | -- | PENDING | test_verification_method_type | tests/test_did_key.py |
| 67 | PENDING | -- | PENDING | test_verification_method_controller | tests/test_did_key.py |
| 68 | PENDING | -- | PENDING | test_verification_method_id_format | tests/test_did_key.py |
| 69 | PENDING | -- | PENDING | test_authentication_references_vm | tests/test_did_key.py |
| 70 | PENDING | -- | PENDING | test_assertion_method_references_vm | tests/test_did_key.py |
| 71 | PENDING | -- | PENDING | test_public_key_multibase_starts_with_z | tests/test_did_key.py |
| 72 | PENDING | -- | PENDING | test_public_key_multibase_decodes_to_pubkey | tests/test_did_key.py |
| 73 | PENDING | -- | PENDING | test_context_is_w3c_compliant | tests/test_did_key.py |
| 74 | PENDING | -- | PENDING | test_json_output_uses_aliases | tests/test_did_key.py |
| 75 | PENDING | -- | PENDING | test_full_json_is_valid | tests/test_did_key.py |
| 76 | PENDING | -- | PENDING | test_create_with_alias | tests/test_did_models.py |
| 77 | PENDING | -- | PENDING | test_create_with_field_name | tests/test_did_models.py |
| 78 | PENDING | -- | PENDING | test_serialize_uses_alias | tests/test_did_models.py |
| 79 | PENDING | -- | PENDING | test_serialize_without_alias | tests/test_did_models.py |
| 80 | PENDING | -- | PENDING | test_default_context | tests/test_did_models.py |
| 81 | PENDING | -- | PENDING | test_serialize_with_at_context | tests/test_did_models.py |
| 82 | PENDING | -- | PENDING | test_serialize_verification_method_alias | tests/test_did_models.py |
| 83 | PENDING | -- | PENDING | test_json_roundtrip | tests/test_did_models.py |
| 84 | PENDING | -- | PENDING | test_multiple_verification_methods | tests/test_did_models.py |
| 85 | PENDING | -- | PENDING | test_generates_keypair_on_first_run | tests/test_identity.py |
| 86 | PENDING | -- | PENDING | test_creates_directory_if_missing | tests/test_identity.py |
| 87 | PENDING | -- | PENDING | test_private_key_permissions | tests/test_identity.py |
| 88 | PENDING | -- | PENDING | test_public_key_is_32_bytes | tests/test_identity.py |
| 89 | PENDING | -- | PENDING | test_private_key_seed_is_32_bytes | tests/test_identity.py |
| 90 | PENDING | -- | PENDING | test_pem_files_are_valid_pem | tests/test_identity.py |
| 91 | PENDING | -- | PENDING | test_reload_produces_same_public_key | tests/test_identity.py |
| 92 | PENDING | -- | PENDING | test_reload_produces_same_private_seed | tests/test_identity.py |
| 93 | PENDING | -- | PENDING | test_two_separate_dirs_produce_different_keys | tests/test_identity.py |
| 94 | PENDING | -- | PENDING | test_sign_returns_bytes | tests/test_identity.py |
| 95 | PENDING | -- | PENDING | test_signature_is_64_bytes | tests/test_identity.py |
| 96 | PENDING | -- | PENDING | test_verify_valid_signature | tests/test_identity.py |
| 97 | PENDING | -- | PENDING | test_verify_tampered_data | tests/test_identity.py |
| 98 | PENDING | -- | PENDING | test_verify_tampered_signature | tests/test_identity.py |
| 99 | PENDING | -- | PENDING | test_verify_wrong_identity | tests/test_identity.py |
| 100 | PENDING | -- | PENDING | test_sign_empty_data | tests/test_identity.py |
| 101 | PENDING | -- | PENDING | test_sign_large_data | tests/test_identity.py |
| 102 | PENDING | -- | PENDING | test_deterministic_signatures | tests/test_identity.py |
| 103 | PENDING | -- | PENDING | test_public_key_property | tests/test_identity.py |
| 104 | PENDING | -- | PENDING | test_store_and_count | tests/test_memory_integration.py |
| 105 | PENDING | -- | PENDING | test_store_unsigned_no_signature_metadata | tests/test_memory_integration.py |
| 106 | PENDING | -- | PENDING | test_upsert_idempotent | tests/test_memory_integration.py |
| 107 | PENDING | -- | PENDING | test_store_signed_verdict | tests/test_memory_integration.py |
| 108 | PENDING | -- | PENDING | test_stored_signature_matches | tests/test_memory_integration.py |
| 109 | PENDING | -- | PENDING | test_stored_did_matches | tests/test_memory_integration.py |
| 110 | PENDING | -- | PENDING | test_stored_canonical_is_valid_json | tests/test_memory_integration.py |
| 111 | PENDING | -- | PENDING | test_stored_canonical_excludes_signature | tests/test_memory_integration.py |
| 112 | PENDING | -- | PENDING | test_signature_verifies_from_stored_data | tests/test_memory_integration.py |
| 113 | PENDING | -- | PENDING | test_returns_none_for_missing_id | tests/test_memory_integration.py |
| 114 | PENDING | -- | PENDING | test_returns_correct_verdict | tests/test_memory_integration.py |
| 115 | PENDING | -- | PENDING | test_returns_document_text | tests/test_memory_integration.py |
| 116 | PENDING | -- | PENDING | test_multiple_verdicts_correct_retrieval | tests/test_memory_integration.py |
| 117 | PENDING | -- | PENDING | test_mixed_storage | tests/test_memory_integration.py |
| 118 | PENDING | -- | PENDING | test_signed_has_metadata | tests/test_memory_integration.py |
| 119 | PENDING | -- | PENDING | test_list_recent_works_with_mixed | tests/test_memory_integration.py |
| 120 | PENDING | -- | PENDING | test_search_works_with_mixed | tests/test_memory_integration.py |
| 121 | PENDING | -- | PENDING | test_empty_store | tests/test_memory_integration.py |
| 122 | PENDING | -- | PENDING | test_returns_metadata_with_signature | tests/test_memory_integration.py |
| 123 | PENDING | -- | PENDING | test_empty_store | tests/test_memory_integration.py |
| 124 | PENDING | -- | PENDING | test_returns_results | tests/test_memory_integration.py |
| 125 | PENDING | -- | PENDING | test_signature_fields_default_to_none | tests/test_models.py |
| 126 | PENDING | -- | PENDING | test_signature_fields_optional | tests/test_models.py |
| 127 | PENDING | -- | PENDING | test_signature_fields_can_be_set | tests/test_models.py |
| 128 | PENDING | -- | PENDING | test_signature_fields_mutable | tests/test_models.py |
| 129 | PENDING | -- | PENDING | test_json_includes_signature_when_set | tests/test_models.py |
| 130 | PENDING | -- | PENDING | test_json_includes_null_when_unset | tests/test_models.py |
| 131 | PENDING | -- | PENDING | test_model_dump_exclude_signature_fields | tests/test_models.py |
| 132 | PENDING | -- | PENDING | test_stream_id_defaults_to_none | tests/test_models.py |
| 133 | PENDING | -- | PENDING | test_stream_id_can_be_set | tests/test_models.py |
| 134 | PENDING | -- | PENDING | test_stream_id_mutable | tests/test_models.py |
| 135 | PENDING | -- | PENDING | test_json_includes_stream_id_when_set | tests/test_models.py |
| 136 | PENDING | -- | PENDING | test_valid_buy_verdict | tests/test_models.py |
| 137 | PENDING | -- | PENDING | test_valid_wait_verdict | tests/test_models.py |
| 138 | PENDING | -- | PENDING | test_valid_avoid_verdict | tests/test_models.py |
| 139 | PENDING | -- | PENDING | test_invalid_verdict_value | tests/test_models.py |
| 140 | PENDING | -- | PENDING | test_confidence_score_range | tests/test_models.py |
| 141 | PENDING | -- | PENDING | test_confidence_score_negative | tests/test_models.py |
| 142 | PENDING | -- | PENDING | test_hidden_warnings_default_empty | tests/test_models.py |
| 143 | PENDING | -- | PENDING | test_json_roundtrip | tests/test_models.py |
| 144 | PENDING | -- | PENDING | test_valid_ollama_spec | tests/test_providers.py |
| 145 | PENDING | -- | PENDING | test_valid_gemini_spec | tests/test_providers.py |
| 146 | PENDING | -- | PENDING | test_provider_normalized_to_lower | tests/test_providers.py |
| 147 | PENDING | -- | PENDING | test_invalid_no_slash | tests/test_providers.py |
| 148 | PENDING | -- | PENDING | test_invalid_empty_provider | tests/test_providers.py |
| 149 | PENDING | -- | PENDING | test_invalid_empty_model | tests/test_providers.py |
| 150 | PENDING | -- | PENDING | test_spec_with_multiple_slashes | tests/test_providers.py |
| 151 | PENDING | -- | PENDING | test_raises_when_nothing_configured | tests/test_providers.py |
| 152 | PENDING | -- | PENDING | test_light_model_created | tests/test_providers.py |
| 153 | PENDING | -- | PENDING | test_heavy_model_is_none | tests/test_providers.py |
| 154 | PENDING | -- | PENDING | test_verdict_model_falls_back_to_light | tests/test_providers.py |
| 155 | PENDING | -- | PENDING | test_chat_model_uses_light | tests/test_providers.py |
| 156 | PENDING | -- | PENDING | test_cannot_analyze_video | tests/test_providers.py |
| 157 | PENDING | -- | PENDING | test_embed_provider_inferred_from_light | tests/test_providers.py |
| 158 | PENDING | -- | PENDING | test_status_lines_show_single_model | tests/test_providers.py |
| 159 | PENDING | -- | PENDING | test_heavy_model_created | tests/test_providers.py |
| 160 | PENDING | -- | PENDING | test_light_model_is_none | tests/test_providers.py |
| 161 | PENDING | -- | PENDING | test_verdict_model_uses_heavy | tests/test_providers.py |
| 162 | PENDING | -- | PENDING | test_chat_model_falls_back_to_heavy | tests/test_providers.py |
| 163 | PENDING | -- | PENDING | test_can_analyze_video_gemini | tests/test_providers.py |
| 164 | PENDING | -- | PENDING | test_cannot_analyze_video_ollama_heavy | tests/test_providers.py |
| 165 | PENDING | -- | PENDING | test_embed_provider_inferred_from_heavy | tests/test_providers.py |
| 166 | PENDING | -- | PENDING | test_both_models_created | tests/test_providers.py |
| 167 | PENDING | -- | PENDING | test_verdict_uses_heavy | tests/test_providers.py |
| 168 | PENDING | -- | PENDING | test_chat_uses_light | tests/test_providers.py |
| 169 | PENDING | -- | PENDING | test_can_analyze_video_when_heavy_is_gemini | tests/test_providers.py |
| 170 | PENDING | -- | PENDING | test_cannot_analyze_video_when_heavy_is_ollama | tests/test_providers.py |
| 171 | PENDING | -- | PENDING | test_embed_provider_prefers_light | tests/test_providers.py |
| 172 | PENDING | -- | PENDING | test_status_lines_show_both | tests/test_providers.py |
| 173 | PENDING | -- | PENDING | test_embed_provider_from_explicit | tests/test_providers.py |
| 174 | PENDING | -- | PENDING | test_embed_model_from_explicit | tests/test_providers.py |
| 175 | PENDING | -- | PENDING | test_gemini_creates_google_model | tests/test_providers.py |
| 176 | PENDING | -- | PENDING | test_ollama_creates_openai_chat_model | tests/test_providers.py |
| 177 | PENDING | -- | PENDING | test_unknown_provider_raises | tests/test_providers.py |
| 178 | PENDING | -- | PENDING | test_returns_json_string | tests/test_signing.py |
| 179 | PENDING | -- | PENDING | test_excludes_signature_hex | tests/test_signing.py |
| 180 | PENDING | -- | PENDING | test_excludes_signer_did | tests/test_signing.py |
| 181 | PENDING | -- | PENDING | test_keys_are_sorted | tests/test_signing.py |
| 182 | PENDING | -- | PENDING | test_no_whitespace_separators | tests/test_signing.py |
| 183 | PENDING | -- | PENDING | test_deterministic | tests/test_signing.py |
| 184 | PENDING | -- | PENDING | test_includes_all_verdict_fields | tests/test_signing.py |
| 185 | PENDING | -- | PENDING | test_excludes_stream_id | tests/test_signing.py |
| 186 | PENDING | -- | PENDING | test_different_verdicts_produce_different_canonical | tests/test_signing.py |
| 187 | PENDING | -- | PENDING | test_empty_lists_included | tests/test_signing.py |
| 188 | PENDING | -- | PENDING | test_returns_tuple | tests/test_signing.py |
| 189 | PENDING | -- | PENDING | test_signature_hex_is_hex_string | tests/test_signing.py |
| 190 | PENDING | -- | PENDING | test_signature_hex_is_128_chars | tests/test_signing.py |
| 191 | PENDING | -- | PENDING | test_signer_did_starts_with_did_key | tests/test_signing.py |
| 192 | PENDING | -- | PENDING | test_deterministic | tests/test_signing.py |
| 193 | PENDING | -- | PENDING | test_different_verdict_different_signature | tests/test_signing.py |
| 194 | PENDING | -- | PENDING | test_different_identity_different_signature | tests/test_signing.py |
| 195 | PENDING | -- | PENDING | test_valid_signature | tests/test_signing.py |
| 196 | PENDING | -- | PENDING | test_tampered_canonical_json | tests/test_signing.py |
| 197 | PENDING | -- | PENDING | test_tampered_signature | tests/test_signing.py |
| 198 | PENDING | -- | PENDING | test_wrong_identity | tests/test_signing.py |
| 199 | PENDING | -- | PENDING | test_invalid_hex_raises | tests/test_signing.py |
| 200 | PENDING | -- | PENDING | test_signature_fields_dont_affect_verification | tests/test_signing.py |
| 201 | PENDING | -- | PENDING | test_sign_then_verify | tests/test_signing.py |
| 202 | PENDING | -- | PENDING | test_sign_set_fields_then_verify | tests/test_signing.py |
| 203 | PENDING | -- | PENDING | test_roundtrip_through_json | tests/test_signing.py |
| 204 | PENDING | -- | PENDING | test_disabled_when_no_url | tests/test_vault.py |
| 205 | PENDING | -- | PENDING | test_publish_returns_none_when_disabled | tests/test_vault.py |
| 206 | PENDING | -- | PENDING | test_synced_count_zero_when_disabled | tests/test_vault.py |
| 207 | PENDING | -- | PENDING | test_connected_false_when_disabled | tests/test_vault.py |
| 208 | PENDING | -- | PENDING | test_health_check_success | tests/test_vault.py |
| 209 | PENDING | -- | PENDING | test_health_check_failure | tests/test_vault.py |
| 210 | PENDING | -- | PENDING | test_health_check_returns_false_when_disabled | tests/test_vault.py |
| 211 | PENDING | -- | PENDING | test_publish_returns_stream_id | tests/test_vault.py |
| 212 | PENDING | -- | PENDING | test_publish_updates_index | tests/test_vault.py |
| 213 | PENDING | -- | PENDING | test_publish_persists_index_to_disk | tests/test_vault.py |
| 214 | PENDING | -- | PENDING | test_publish_sdk_exception_returns_none | tests/test_vault.py |
| 215 | PENDING | -- | PENDING | test_publish_when_disconnected_returns_none | tests/test_vault.py |
| 216 | PENDING | -- | PENDING | test_empty_on_fresh_vault | tests/test_vault.py |
| 217 | PENDING | -- | PENDING | test_index_survives_reload | tests/test_vault.py |
| 218 | PENDING | -- | PENDING | test_disabled_status | tests/test_vault.py |
| 219 | PENDING | -- | PENDING | test_enabled_connected_status | tests/test_vault.py |
| 220 | PENDING | -- | PENDING | test_enabled_disconnected_status | tests/test_vault.py |

