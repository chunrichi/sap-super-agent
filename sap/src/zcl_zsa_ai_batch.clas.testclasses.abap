CLASS ltc_zsa_ai_batch DEFINITION FOR TESTING
  RISK LEVEL HARMLESS
  DURATION SHORT.
  PRIVATE SECTION.
    METHODS payload_mapping FOR TESTING.
    METHODS claim_mapping FOR TESTING.
    METHODS gateway_request_mapping FOR TESTING.
    METHODS gateway_response_mapping FOR TESTING.
    METHODS result_succeeded_mapping FOR TESTING.
    METHODS result_failed_mapping FOR TESTING.
    METHODS hmac_known_vector FOR TESTING.
    METHODS auth_header_construction FOR TESTING.
    METHODS control_status_classification FOR TESTING.
    METHODS gateway_failure_classification FOR TESTING.
    METHODS transport_error_classification FOR TESTING.
    METHODS lease_renewal_calculation FOR TESTING.
    METHODS effective_timeout_selection FOR TESTING.
    METHODS batch_limit_clamping FOR TESTING.
    METHODS result_delivery_idempotency FOR TESTING.
ENDCLASS.

CLASS ltc_zsa_ai_batch IMPLEMENTATION.
  METHOD payload_mapping.
    " First control plane response body from docs/003 section 4.8.4; all values
    " are fictional test data (no real gateway address, key or SAP system).
    DATA(lv_json) = `{"jobs":[{"id":"job-1","stageRunId":"stage-1","demandId":"demand-1",` &&
                    `"attempt":2,"stageKey":"requirement_analysis","state":"queued",` &&
                    `"payload":{"stageRunId":"stage-1","demandId":"demand-1",` &&
                    `"stageKey":"requirement_analysis","stageName":"Requirement analysis",` &&
                    `"attempt":2,"promptVersion":"v1","systemPrompt":"You are a test.",` &&
                    `"prompt":"Analyze this demand.","model":"test-model",` &&
                    `"outputSchema":"schema-v1","timeoutMs":120000,"maxOutputTokens":1000},` &&
                    `"claimId":null,"leaseExpiresAt":null,"result":null,"lastError":null,` &&
                    `"createdAt":"2026-11-05T08:00:00Z","updatedAt":"2026-11-05T08:00:00Z"}],` &&
                    `"serverTime":"2026-11-05T08:00:01Z"}`.

    DATA(ls_response) = zcl_zsa_ai_batch=>parse_jobs_response( lv_json ).
    cl_abap_unit_assert=>assert_true( act = ls_response-ok
                                      msg = `next response parsed` ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_response-jobs ) exp = 1 ).

    DATA(ls_job) = ls_response-jobs[ 1 ].
    cl_abap_unit_assert=>assert_equals( act = ls_job-id exp = `job-1` ).
    cl_abap_unit_assert=>assert_equals( act = ls_job-stage_key exp = `requirement_analysis` ).
    cl_abap_unit_assert=>assert_equals( act = ls_job-attempt exp = 2 ).
    cl_abap_unit_assert=>assert_equals( act = ls_job-state exp = `queued` ).
    cl_abap_unit_assert=>assert_equals( act = ls_job-payload-system_prompt
                                        exp = `You are a test.` ).
    cl_abap_unit_assert=>assert_equals( act = ls_job-payload-prompt
                                        exp = `Analyze this demand.` ).
    cl_abap_unit_assert=>assert_equals( act = ls_job-payload-model exp = `test-model` ).
    cl_abap_unit_assert=>assert_equals( act = ls_job-payload-timeout_ms exp = 120000 ).
    cl_abap_unit_assert=>assert_equals( act = ls_job-payload-max_output_tokens exp = 1000 ).
  ENDMETHOD.

  METHOD claim_mapping.
    DATA(lv_json) = `{"job":{"id":"job-1","stageRunId":"stage-1","attempt":1,` &&
                    `"stageKey":"intake","state":"claimed","payload":{}},` &&
                    `"claimId":"claim-1","lease":{"expiresAt":"2026-11-05T08:10:00Z",` &&
                    `"renewIntervalMs":300000},"serverTime":"2026-11-05T08:00:00Z"}`.

    DATA(ls_response) = zcl_zsa_ai_batch=>parse_claim_response( lv_json ).
    cl_abap_unit_assert=>assert_true( act = ls_response-ok
                                      msg = `claim response parsed` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-claim_id exp = `claim-1` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-lease-expires_at
                                        exp = `2026-11-05T08:10:00Z` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-lease-renew_interval_ms
                                        exp = 300000 ).
  ENDMETHOD.

  METHOD gateway_request_mapping.
    DATA(lv_body) = zcl_zsa_ai_batch=>build_gateway_request(
      iv_model         = `test-model`
      iv_system_prompt = `You are a test.`
      iv_prompt        = `Say "hello" now.` ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_body exp = `*"model":"test-model"*` ).
    cl_abap_unit_assert=>assert_char_cp(
      act = lv_body
      exp = `*"messages":[{"role":"system","content":"You are a test."},` &&
            `{"role":"user","content":"Say \"hello\" now."}]*`
      msg = `system message first, then the user prompt, both JSON escaped` ).
    DATA(lv_max_pos) = find( val = lv_body sub = `max_tokens` ).
    cl_abap_unit_assert=>assert_equals( act = lv_max_pos exp = 0
                                        msg = `max_tokens omitted when not requested` ).

    DATA(lv_body_max) = zcl_zsa_ai_batch=>build_gateway_request(
      iv_model             = `test-model`
      iv_system_prompt     = `sys`
      iv_prompt            = `user`
      iv_max_output_tokens = 1000 ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_body_max exp = `*"max_tokens":1000*` ).
  ENDMETHOD.

  METHOD gateway_response_mapping.
    DATA(lv_json) = `{"id":"chatcmpl-test","object":"chat.completion","model":"test-model",` &&
                    `"choices":[{"index":0,` &&
                    `"message":{"role":"assistant","content":"Hello world"},` &&
                    `"finish_reason":"stop"}],` &&
                    `"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`.

    DATA(ls_parsed) = zcl_zsa_ai_batch=>parse_gateway_response( lv_json ).
    cl_abap_unit_assert=>assert_true( act = ls_parsed-ok
                                      msg = `OpenAI compatible completion parsed` ).
    cl_abap_unit_assert=>assert_equals( act = ls_parsed-output_text exp = `Hello world` ).
    cl_abap_unit_assert=>assert_equals( act = ls_parsed-usage-prompt_tokens exp = 11 ).
    cl_abap_unit_assert=>assert_equals( act = ls_parsed-usage-completion_tokens exp = 7 ).
    cl_abap_unit_assert=>assert_equals( act = ls_parsed-usage-total_tokens exp = 18 ).
    cl_abap_unit_assert=>assert_equals( act = ls_parsed-usage-model exp = `test-model` ).
  ENDMETHOD.

  METHOD result_succeeded_mapping.
    DATA ls_usage TYPE zcl_zsa_ai_batch=>ty_usage.
    ls_usage-prompt_tokens = 11.
    ls_usage-completion_tokens = 7.
    ls_usage-total_tokens = 18.
    ls_usage-model = `test-model`.
    DATA(lv_body) = zcl_zsa_ai_batch=>build_result_succeeded(
      iv_claim_id    = `claim-1`
      iv_output_text = `Hello "world"`
      is_usage       = ls_usage
      iv_duration_ms = 1234 ).

    cl_abap_unit_assert=>assert_char_cp( act = lv_body exp = `*"claimId":"claim-1"*` ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_body exp = `*"status":"succeeded"*` ).
    cl_abap_unit_assert=>assert_char_cp(
      act = lv_body exp = `*"outputText":"Hello \"world\""*`
      msg = `model output is reported verbatim and JSON escaped` ).
    cl_abap_unit_assert=>assert_char_cp(
      act = lv_body
      exp = `*"usage":{"promptTokens":11,"completionTokens":7,` &&
            `"totalTokens":18,"model":"test-model"}*` ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_body exp = `*"durationMs":1234*` ).
  ENDMETHOD.

  METHOD result_failed_mapping.
    DATA(lv_body) = zcl_zsa_ai_batch=>build_result_failed(
      iv_claim_id    = `claim-1`
      iv_code        = zcl_zsa_ai_batch=>c_err_timeout
      iv_message     = `AI gateway call failed before a response was received`
      iv_retryable   = abap_true
      iv_duration_ms = 2000 ).

    cl_abap_unit_assert=>assert_char_cp( act = lv_body exp = `*"claimId":"claim-1"*` ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_body exp = `*"status":"failed"*` ).
    cl_abap_unit_assert=>assert_char_cp(
      act = lv_body exp = `*"code":"GATEWAY_TIMEOUT"*` ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_body exp = `*"retryable":true*` ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_body exp = `*"durationMs":2000*` ).
    DATA(lv_prompt_pos) = find( val = lv_body sub = `systemPrompt` ).
    cl_abap_unit_assert=>assert_equals( act = lv_prompt_pos exp = 0
                                        msg = `failed result never carries prompt text` ).
  ENDMETHOD.

  METHOD hmac_known_vector.
    " RFC 4231 test case 2 (HMAC-SHA256, ASCII key/data), same signing rule as
    " ZCL_ZSA_EVENT_PUSH and packages/sap-adapter/src/signature.ts.
    DATA(lv_sig) = zcl_zsa_ai_batch=>signature_hex(
      iv_secret = `Jefe`
      iv_body   = `what do ya want for nothing?` ).
    cl_abap_unit_assert=>assert_equals(
      act = lv_sig
      exp = `sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843` ).
  ENDMETHOD.

  METHOD auth_header_construction.
    DATA(lv_body) = `{"limit":5}`.
    DATA(lt_headers) = zcl_zsa_ai_batch=>build_auth_headers(
      iv_secret    = `test-secret`
      iv_body      = lv_body
      iv_timestamp = `2026-11-05T08:00:00Z`
      iv_delivery  = `zsa-ai-next-test` ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_headers ) exp = 3 ).

    DATA(ls_signature) = lt_headers[ 1 ].
    cl_abap_unit_assert=>assert_equals( act = ls_signature-header_name
                                        exp = `X-SA-Signature` ).
    cl_abap_unit_assert=>assert_equals(
      act = ls_signature-header_value
      exp = zcl_zsa_ai_batch=>signature_hex( iv_secret = `test-secret` iv_body = lv_body )
      msg = `signature covers the raw request body` ).

    DATA(ls_timestamp) = lt_headers[ 2 ].
    cl_abap_unit_assert=>assert_equals( act = ls_timestamp-header_name
                                        exp = `X-SA-Timestamp` ).
    cl_abap_unit_assert=>assert_equals( act = ls_timestamp-header_value
                                        exp = `2026-11-05T08:00:00Z` ).

    DATA(ls_delivery) = lt_headers[ 3 ].
    cl_abap_unit_assert=>assert_equals( act = ls_delivery-header_name
                                        exp = `X-SA-Delivery` ).
    cl_abap_unit_assert=>assert_equals( act = ls_delivery-header_value
                                        exp = `zsa-ai-next-test` ).
  ENDMETHOD.

  METHOD control_status_classification.
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_ai_batch=>classify_control_status( 200 )
      exp = zcl_zsa_ai_batch=>c_status_ok ).
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_ai_batch=>classify_control_status( 409 )
      exp = zcl_zsa_ai_batch=>c_status_conflict
      msg = `a live lease or a stale claim is a conflict, not a retry` ).
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_ai_batch=>classify_control_status( 401 )
      exp = zcl_zsa_ai_batch=>c_status_auth ).
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_ai_batch=>classify_control_status( 429 )
      exp = zcl_zsa_ai_batch=>c_status_retryable ).
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_ai_batch=>classify_control_status( 503 )
      exp = zcl_zsa_ai_batch=>c_status_retryable ).
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_ai_batch=>classify_control_status( 400 )
      exp = zcl_zsa_ai_batch=>c_status_fatal ).
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_ai_batch=>classify_control_status( 404 )
      exp = zcl_zsa_ai_batch=>c_status_fatal ).
  ENDMETHOD.

  METHOD gateway_failure_classification.
    DATA(ls_error) = zcl_zsa_ai_batch=>classify_gateway_failure(
      iv_status = 429 iv_transport_error = `` ).
    cl_abap_unit_assert=>assert_equals( act = ls_error-code
                                        exp = zcl_zsa_ai_batch=>c_err_rate_limited ).
    cl_abap_unit_assert=>assert_true( act = ls_error-retryable
                                      msg = `429 is retried locally` ).

    ls_error = zcl_zsa_ai_batch=>classify_gateway_failure( iv_status = 503
                                                           iv_transport_error = `` ).
    cl_abap_unit_assert=>assert_equals( act = ls_error-code
                                        exp = zcl_zsa_ai_batch=>c_err_unavailable ).
    cl_abap_unit_assert=>assert_true( act = ls_error-retryable ).

    ls_error = zcl_zsa_ai_batch=>classify_gateway_failure( iv_status = 401
                                                           iv_transport_error = `` ).
    cl_abap_unit_assert=>assert_equals( act = ls_error-code
                                        exp = zcl_zsa_ai_batch=>c_err_auth ).
    cl_abap_unit_assert=>assert_false( act = ls_error-retryable
                                       msg = `bad key or model must alert, not retry` ).

    ls_error = zcl_zsa_ai_batch=>classify_gateway_failure( iv_status = 400
                                                           iv_transport_error = `` ).
    cl_abap_unit_assert=>assert_equals( act = ls_error-code
                                        exp = zcl_zsa_ai_batch=>c_err_bad_request ).
    cl_abap_unit_assert=>assert_false( act = ls_error-retryable ).

    ls_error = zcl_zsa_ai_batch=>classify_gateway_failure( iv_status = 404
                                                           iv_transport_error = `` ).
    cl_abap_unit_assert=>assert_equals( act = ls_error-code
                                        exp = zcl_zsa_ai_batch=>c_err_model_not_found ).
    cl_abap_unit_assert=>assert_false( act = ls_error-retryable ).

    ls_error = zcl_zsa_ai_batch=>classify_gateway_failure(
      iv_status = 0 iv_transport_error = `Timeout while waiting for the HTTP response` ).
    cl_abap_unit_assert=>assert_equals( act = ls_error-code
                                        exp = zcl_zsa_ai_batch=>c_err_timeout ).
    cl_abap_unit_assert=>assert_true( act = ls_error-retryable ).

    ls_error = zcl_zsa_ai_batch=>classify_gateway_failure( iv_status = 200
                                                           iv_transport_error = `` ).
    cl_abap_unit_assert=>assert_equals( act = ls_error-code
                                        exp = zcl_zsa_ai_batch=>c_err_empty_output ).
    cl_abap_unit_assert=>assert_true( act = ls_error-retryable ).
  ENDMETHOD.

  METHOD transport_error_classification.
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_ai_batch=>classify_transport_error( `HTTP timeout during receive` )
      exp = zcl_zsa_ai_batch=>c_err_timeout ).
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_ai_batch=>classify_transport_error( `Connection refused` )
      exp = zcl_zsa_ai_batch=>c_err_transport ).
  ENDMETHOD.

  METHOD lease_renewal_calculation.
    DATA lv_date TYPE d.
    DATA lv_time TYPE t.
    DATA lv_from TYPE timestampl.
    lv_date = '20261105'.
    lv_time = '080000'.
    CONVERT DATE lv_date TIME lv_time INTO TIME STAMP lv_from TIME ZONE 'UTC'.

    DATA(lv_due) = zcl_zsa_ai_batch=>heartbeat_due( iv_from              = lv_from
                                                    iv_renew_interval_ms = 300000 ).
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_json=>timestamp_to_iso( lv_due )
      exp = `2026-11-05T08:05:00Z`
      msg = `renew at the interval carried by the claim lease` ).

    " A missing lease interval must not result in a heartbeat loop.
    DATA(lv_due_min) = zcl_zsa_ai_batch=>heartbeat_due( iv_from              = lv_from
                                                        iv_renew_interval_ms = 0 ).
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_json=>timestamp_to_iso( lv_due_min )
      exp = `2026-11-05T08:00:01Z` ).
  ENDMETHOD.

  METHOD effective_timeout_selection.
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_ai_batch=>effective_timeout_ms( iv_payload_timeout_ms = 120000
                                                    iv_cfg_timeout_ms     = 60000 )
      exp = 60000
      msg = `AI_TIMEOUT_MS caps the payload hint` ).
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_ai_batch=>effective_timeout_ms( iv_payload_timeout_ms = 0
                                                    iv_cfg_timeout_ms     = 90000 )
      exp = 90000 ).
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_ai_batch=>effective_timeout_ms( iv_payload_timeout_ms = 45000
                                                    iv_cfg_timeout_ms     = 0 )
      exp = 45000 ).
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_ai_batch=>effective_timeout_ms( iv_payload_timeout_ms = 0
                                                    iv_cfg_timeout_ms     = 0 )
      exp = zcl_zsa_ai_batch=>c_default_timeout_ms ).
  ENDMETHOD.

  METHOD batch_limit_clamping.
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_ai_batch=>clamp_limit( 0 )
      exp = zcl_zsa_ai_batch=>c_default_limit ).
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_ai_batch=>clamp_limit( 100 )
      exp = zcl_zsa_ai_batch=>c_max_limit ).
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_ai_batch=>clamp_limit( 7 ) exp = 7 ).
  ENDMETHOD.

  METHOD result_delivery_idempotency.
    DATA(lv_first) = zcl_zsa_ai_batch=>result_delivery( `claim-1` ).
    DATA(lv_second) = zcl_zsa_ai_batch=>result_delivery( `claim-1` ).
    DATA(lv_other) = zcl_zsa_ai_batch=>result_delivery( `claim-2` ).
    cl_abap_unit_assert=>assert_equals(
      act = lv_first exp = lv_second
      msg = `result retries for one claim reuse the X-SA-Delivery idempotency key` ).
    cl_abap_unit_assert=>assert_true(
      act = COND abap_bool( WHEN lv_first <> lv_other THEN abap_true ELSE abap_false )
      msg = `different claims get different idempotency keys` ).
  ENDMETHOD.
ENDCLASS.
