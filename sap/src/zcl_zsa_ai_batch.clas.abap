CLASS zcl_zsa_ai_batch DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    " -----------------------------------------------------------------------
    " S5 / M3: SAP batch AI executor (docs/003 section 4.8, docs/004 7.1).
    "
    " The control plane still owns the stage state machine, prompt rendering,
    " output validation and gates. This class is only the SAP side of the job
    " protocol: pull jobs -> claim -> call the enterprise AI gateway
    " (OpenAI compatible /chat/completions) -> heartbeat -> report the raw
    " model output back. It never parses or validates business output and it
    " never logs prompt or output bodies (only ids, lengths, durations, status
    " and error codes).
    "
    " Endpoints (all POST, HMAC via X-SA-Signature / X-SA-Timestamp /
    " X-SA-Delivery, reuse of the SAP webhook secret, no Bearer token):
    "   /api/v1/sap/ai-jobs/next
    "   /api/v1/sap/ai-jobs/{id}/claim
    "   /api/v1/sap/ai-jobs/{id}/heartbeat
    "   /api/v1/sap/ai-jobs/{id}/result
    " -----------------------------------------------------------------------

    CONSTANTS c_default_limit TYPE i VALUE 5.
    CONSTANTS c_max_limit TYPE i VALUE 50.
    CONSTANTS c_max_rounds TYPE i VALUE 10.
    CONSTANTS c_gateway_max_attempts TYPE i VALUE 3.
    CONSTANTS c_result_attempts TYPE i VALUE 2.
    CONSTANTS c_result_retry_delay_secs TYPE i VALUE 2.
    CONSTANTS c_default_timeout_ms TYPE i VALUE 120000.
    CONSTANTS c_max_duration_ms TYPE i VALUE 3600000.
    CONSTANTS c_max_error_chars TYPE i VALUE 4000.
    CONSTANTS c_max_output_chars TYPE i VALUE 2000000.
    CONSTANTS c_min_heartbeat_secs TYPE i VALUE 1.

    CONSTANTS c_path_jobs_prefix TYPE string VALUE `/api/v1/sap/ai-jobs/`.
    CONSTANTS c_path_next TYPE string VALUE `/api/v1/sap/ai-jobs/next`.
    CONSTANTS c_path_claim TYPE string VALUE `/claim`.
    CONSTANTS c_path_heartbeat TYPE string VALUE `/heartbeat`.
    CONSTANTS c_path_result TYPE string VALUE `/result`.
    CONSTANTS c_path_chat_completions TYPE string VALUE `/chat/completions`.

    CONSTANTS c_outcome_done TYPE string VALUE `done`.
    CONSTANTS c_outcome_failed TYPE string VALUE `failed`.
    CONSTANTS c_outcome_skipped TYPE string VALUE `skipped`.
    CONSTANTS c_outcome_error TYPE string VALUE `error`.
    CONSTANTS c_outcome_abort TYPE string VALUE `abort`.

    CONSTANTS c_status_ok TYPE string VALUE `ok`.
    CONSTANTS c_status_conflict TYPE string VALUE `conflict`.
    CONSTANTS c_status_auth TYPE string VALUE `auth`.
    CONSTANTS c_status_retryable TYPE string VALUE `retryable`.
    CONSTANTS c_status_fatal TYPE string VALUE `fatal`.

    CONSTANTS c_err_transport TYPE string VALUE `GATEWAY_TRANSPORT`.
    CONSTANTS c_err_timeout TYPE string VALUE `GATEWAY_TIMEOUT`.
    CONSTANTS c_err_rate_limited TYPE string VALUE `GATEWAY_RATE_LIMITED`.
    CONSTANTS c_err_unavailable TYPE string VALUE `GATEWAY_UNAVAILABLE`.
    CONSTANTS c_err_auth TYPE string VALUE `GATEWAY_AUTH_FAILED`.
    CONSTANTS c_err_bad_request TYPE string VALUE `GATEWAY_BAD_REQUEST`.
    CONSTANTS c_err_model_not_found TYPE string VALUE `GATEWAY_MODEL_NOT_FOUND`.
    CONSTANTS c_err_empty_output TYPE string VALUE `GATEWAY_EMPTY_OUTPUT`.
    CONSTANTS c_err_output_too_large TYPE string VALUE `GATEWAY_OUTPUT_TOO_LARGE`.
    CONSTANTS c_err_not_configured TYPE string VALUE `GATEWAY_NOT_CONFIGURED`.

    TYPES: BEGIN OF ty_usage,
             prompt_tokens     TYPE i,
             completion_tokens TYPE i,
             total_tokens      TYPE i,
             model             TYPE string,
           END OF ty_usage.

    TYPES: BEGIN OF ty_job_payload,
             stage_run_id      TYPE string,
             demand_id         TYPE string,
             stage_key         TYPE string,
             stage_name        TYPE string,
             attempt           TYPE i,
             prompt_version    TYPE string,
             system_prompt     TYPE string,
             prompt            TYPE string,
             model             TYPE string,
             output_schema     TYPE string,
             timeout_ms        TYPE i,
             max_output_tokens TYPE i,
           END OF ty_job_payload.

    TYPES: BEGIN OF ty_job,
             id               TYPE string,
             stage_run_id     TYPE string,
             demand_id        TYPE string,
             attempt          TYPE i,
             stage_key        TYPE string,
             state            TYPE string,
             payload          TYPE ty_job_payload,
             claim_id         TYPE string,
             lease_expires_at TYPE string,
             created_at       TYPE string,
             updated_at       TYPE string,
           END OF ty_job.
    TYPES ty_jobs TYPE STANDARD TABLE OF ty_job WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_lease,
             expires_at        TYPE string,
             renew_interval_ms TYPE i,
           END OF ty_lease.

    TYPES: BEGIN OF ty_next_response,
             ok          TYPE abap_bool,
             jobs        TYPE ty_jobs,
             server_time TYPE string,
           END OF ty_next_response.

    TYPES: BEGIN OF ty_claim_response,
             ok          TYPE abap_bool,
             job         TYPE ty_job,
             claim_id    TYPE string,
             lease       TYPE ty_lease,
             server_time TYPE string,
           END OF ty_claim_response.

    TYPES: BEGIN OF ty_gateway_parse,
             ok          TYPE abap_bool,
             output_text TYPE string,
             usage       TYPE ty_usage,
           END OF ty_gateway_parse.

    TYPES: BEGIN OF ty_job_error,
             code      TYPE string,
             message   TYPE string,
             retryable TYPE abap_bool,
           END OF ty_job_error.

    TYPES: BEGIN OF ty_header,
             header_name  TYPE string,
             header_value TYPE string,
           END OF ty_header.
    TYPES ty_headers TYPE STANDARD TABLE OF ty_header WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_run_result,
             jobs_seen   TYPE i,
             jobs_done   TYPE i,
             jobs_failed TYPE i,
             errors      TYPE i,
           END OF ty_run_result.

    " S5 job -> gateway -> result loop (called by ZSA_AI_BATCH_RUN / SM36).
    CLASS-METHODS run_batch
      IMPORTING iv_limit TYPE i DEFAULT 5
      RETURNING VALUE(rs_result) TYPE ty_run_result.

    " HMAC-SHA256 over the raw request body, header format `sha256=<hex>`.
    " Delegates to ZCL_ZSA_EVENT_PUSH so both SAP -> control plane paths sign
    " with exactly the same rule (docs/003 section 4.1/4.5/4.8).
    CLASS-METHODS signature_hex
      IMPORTING iv_secret          TYPE string
                iv_body            TYPE string
      RETURNING VALUE(rv_signature) TYPE string.

    " X-SA-Signature / X-SA-Timestamp / X-SA-Delivery header set.
    CLASS-METHODS build_auth_headers
      IMPORTING iv_secret         TYPE string
                iv_body           TYPE string
                iv_timestamp      TYPE string
                iv_delivery       TYPE string
      RETURNING VALUE(rt_headers) TYPE ty_headers.

    " Parse the job payload mapping from the control plane responses.
    CLASS-METHODS parse_jobs_response
      IMPORTING iv_json           TYPE string
      RETURNING VALUE(rs_response) TYPE ty_next_response.

    CLASS-METHODS parse_claim_response
      IMPORTING iv_json           TYPE string
      RETURNING VALUE(rs_response) TYPE ty_claim_response.

    " Parse an OpenAI compatible chat completion response supplied by the
    " enterprise gateway (snake_case keys: choices[0].message.content, usage).
    CLASS-METHODS parse_gateway_response
      IMPORTING iv_json           TYPE string
      RETURNING VALUE(rs_response) TYPE ty_gateway_parse.

    " Build the OpenAI compatible request body: model + [system, user] messages.
    CLASS-METHODS build_gateway_request
      IMPORTING iv_model                TYPE string
                iv_system_prompt        TYPE string
                iv_prompt               TYPE string
                iv_max_output_tokens    TYPE i DEFAULT 0
      RETURNING VALUE(rv_body)          TYPE string.

    " Result payload mapping (docs/003 section 4.8.4). Bodies are built with
    " ZCL_ZSA_JSON escaping so the shape matches the control plane schema.
    CLASS-METHODS build_result_succeeded
      IMPORTING iv_claim_id    TYPE string
                iv_output_text TYPE string
                is_usage       TYPE ty_usage
                iv_duration_ms TYPE i
      RETURNING VALUE(rv_body) TYPE string.

    CLASS-METHODS build_result_failed
      IMPORTING iv_claim_id    TYPE string
                iv_code        TYPE string
                iv_message     TYPE string
                iv_retryable   TYPE abap_bool
                iv_duration_ms TYPE i
      RETURNING VALUE(rv_body) TYPE string.

    " Error classification: 4xx configuration problems are terminal, 429/5xx/
    " transport (timeout) problems are retryable.
    CLASS-METHODS classify_control_status
      IMPORTING iv_status       TYPE i
      RETURNING VALUE(rv_class) TYPE string.

    CLASS-METHODS classify_gateway_failure
      IMPORTING iv_status          TYPE i
                iv_transport_error TYPE string
      RETURNING VALUE(rs_error)    TYPE ty_job_error.

    CLASS-METHODS classify_transport_error
      IMPORTING iv_transport_error TYPE string
      RETURNING VALUE(rv_code)     TYPE string.

    " Lease renewal point: now + renewIntervalMs (half a lease by contract).
    CLASS-METHODS heartbeat_due
      IMPORTING iv_from               TYPE timestampl
                iv_renew_interval_ms  TYPE i
      RETURNING VALUE(rv_tstmp)      TYPE timestampl.

    " Effective gateway timeout = min(payload timeoutMs, AI_TIMEOUT_MS).
    CLASS-METHODS effective_timeout_ms
      IMPORTING iv_payload_timeout_ms TYPE i
                iv_cfg_timeout_ms     TYPE i
      RETURNING VALUE(rv_timeout_ms)  TYPE i.

    CLASS-METHODS clamp_limit
      IMPORTING iv_limit       TYPE i
      RETURNING VALUE(rv_limit) TYPE i.

    " Idempotent delivery key: every retry of the same result for one claim
    " reuses this key so the control plane can deduplicate it.
    CLASS-METHODS result_delivery
      IMPORTING iv_claim_id       TYPE string
      RETURNING VALUE(rv_delivery) TYPE string.

  PRIVATE SECTION.
    TYPES: BEGIN OF ty_http_result,
             status TYPE i,
             body   TYPE string,
             error  TYPE string,
           END OF ty_http_result.

    TYPES: BEGIN OF ty_next_result,
             ok         TYPE abap_bool,
             auth_error TYPE abap_bool,
             jobs       TYPE ty_jobs,
             error      TYPE string,
           END OF ty_next_result.

    TYPES: BEGIN OF ty_claim_result,
             ok        TYPE abap_bool,
             conflict  TYPE abap_bool,
             claim_id  TYPE string,
             lease     TYPE ty_lease,
             error     TYPE string,
           END OF ty_claim_result.

    TYPES: BEGIN OF ty_gateway_call,
             ok            TYPE abap_bool,
             output_text   TYPE string,
             usage         TYPE ty_usage,
             duration_ms   TYPE i,
             error_code    TYPE string,
             error_message TYPE string,
             retryable     TYPE abap_bool,
             lease_lost    TYPE abap_bool,
           END OF ty_gateway_call.

    TYPES: BEGIN OF ty_report_result,
             status TYPE i,
             error  TYPE string,
           END OF ty_report_result.

    TYPES: BEGIN OF ty_gw_message,
             role    TYPE string,
             content TYPE string,
           END OF ty_gw_message.

    TYPES: BEGIN OF ty_gw_choice,
             message TYPE ty_gw_message,
           END OF ty_gw_choice.
    TYPES ty_gw_choices TYPE STANDARD TABLE OF ty_gw_choice WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_gw_usage,
             prompt_tokens     TYPE i,
             completion_tokens TYPE i,
             total_tokens      TYPE i,
           END OF ty_gw_usage.

    TYPES: BEGIN OF ty_gw_response,
             id      TYPE string,
             object  TYPE string,
             model   TYPE string,
             choices TYPE ty_gw_choices,
             usage   TYPE ty_gw_usage,
           END OF ty_gw_response.

    CLASS-METHODS read_cfg
      IMPORTING iv_key            TYPE string
      RETURNING VALUE(rv_value)   TYPE string.

    CLASS-METHODS hmac_secret
      RETURNING VALUE(rv_secret) TYPE string.

    CLASS-METHODS gateway_key
      RETURNING VALUE(rv_key) TYPE string.

    CLASS-METHODS default_model
      RETURNING VALUE(rv_model) TYPE string.

    CLASS-METHODS gateway_model
      IMPORTING iv_payload_model   TYPE string
      RETURNING VALUE(rv_model)    TYPE string.

    CLASS-METHODS control_plane_base
      RETURNING VALUE(rv_base) TYPE string.

    CLASS-METHODS gateway_url
      RETURNING VALUE(rv_url) TYPE string.

    CLASS-METHODS gateway_timeout_ms
      IMPORTING iv_payload_timeout_ms TYPE i
      RETURNING VALUE(rv_timeout_ms)  TYPE i.

    CLASS-METHODS utc_now_iso
      RETURNING VALUE(rv_iso) TYPE string.

    CLASS-METHODS new_delivery
      IMPORTING iv_prefix          TYPE string
      RETURNING VALUE(rv_delivery) TYPE string.

    CLASS-METHODS http_post
      IMPORTING iv_url            TYPE string
                iv_body           TYPE string
                it_headers        TYPE ty_headers
      RETURNING VALUE(rs_result)  TYPE ty_http_result.

    CLASS-METHODS post_control_plane
      IMPORTING iv_path          TYPE string
                iv_body          TYPE string
                iv_delivery      TYPE string
      RETURNING VALUE(rs_result) TYPE ty_http_result.

    CLASS-METHODS post_gateway
      IMPORTING iv_url           TYPE string
                iv_body          TYPE string
                iv_key           TYPE string
      RETURNING VALUE(rs_result) TYPE ty_http_result.

    CLASS-METHODS select_jobs
      IMPORTING iv_limit         TYPE i
      RETURNING VALUE(rs_result) TYPE ty_next_result.

    CLASS-METHODS claim_job
      IMPORTING is_job           TYPE ty_job
      RETURNING VALUE(rs_result) TYPE ty_claim_result.

    CLASS-METHODS process_job
      IMPORTING is_job           TYPE ty_job
      RETURNING VALUE(rv_outcome) TYPE string.

    CLASS-METHODS execute_on_gateway
      IMPORTING is_job           TYPE ty_job
                iv_claim_id      TYPE string
                is_lease         TYPE ty_lease
      RETURNING VALUE(rs_call)   TYPE ty_gateway_call.

    CLASS-METHODS send_heartbeat
      IMPORTING iv_job_id        TYPE string
                iv_claim_id      TYPE string
      RETURNING VALUE(rv_ok)     TYPE abap_bool.

    CLASS-METHODS report_result
      IMPORTING iv_job_id        TYPE string
                iv_claim_id      TYPE string
                iv_body          TYPE string
      RETURNING VALUE(rs_result) TYPE ty_report_result.

    CLASS-METHODS log_message
      IMPORTING iv_type TYPE char1
                iv_text TYPE string.

    CLASS-METHODS gateway_retry_delay
      IMPORTING iv_attempt       TYPE i
      RETURNING VALUE(rv_secs)   TYPE i.
ENDCLASS.

CLASS zcl_zsa_ai_batch IMPLEMENTATION.
  METHOD run_batch.
    CLEAR rs_result.
    DATA lv_base TYPE string.
    lv_base = control_plane_base( ).
    IF lv_base IS INITIAL.
      log_message( iv_type = 'E'
                   iv_text = `ZSA_AI_BATCH: CONTROL_PLANE_URL is not configured in ZSA_CFG` ).
      rs_result-errors = 1.
      RETURN.
    ENDIF.
    DATA lv_secret TYPE string.
    lv_secret = hmac_secret( ).
    IF lv_secret IS INITIAL.
      log_message( iv_type = 'E'
                   iv_text = `ZSA_AI_BATCH: HMAC secret not configured (ZSA_CFG HMAC_SECRET_REF)` ).
      rs_result-errors = 1.
      RETURN.
    ENDIF.

    DATA lv_limit TYPE i.
    lv_limit = clamp_limit( iv_limit ).

    DATA lv_round TYPE i.
    DO c_max_rounds TIMES.
      lv_round = sy-index.
      DATA ls_next TYPE ty_next_result.
      ls_next = select_jobs( lv_limit ).
      IF ls_next-ok = abap_false.
        log_message( iv_type = 'E'
                     iv_text = |ZSA_AI_BATCH: next failed: { ls_next-error }| ).
        rs_result-errors = rs_result-errors + 1.
        RETURN.
      ENDIF.
      IF lines( ls_next-jobs ) = 0.
        EXIT.
      ENDIF.

      DATA ls_job TYPE ty_job.
      LOOP AT ls_next-jobs INTO ls_job.
        rs_result-jobs_seen = rs_result-jobs_seen + 1.
        DATA lv_outcome TYPE string.
        lv_outcome = process_job( ls_job ).
        CASE lv_outcome.
          WHEN c_outcome_done.
            rs_result-jobs_done = rs_result-jobs_done + 1.
          WHEN c_outcome_failed.
            rs_result-jobs_failed = rs_result-jobs_failed + 1.
          WHEN c_outcome_error.
            rs_result-errors = rs_result-errors + 1.
          WHEN c_outcome_abort.
            rs_result-errors = rs_result-errors + 1.
            log_message( iv_type = 'E'
                         iv_text = `ZSA_AI_BATCH: aborting batch after authentication/configuration failure` ).
            RETURN.
        ENDCASE.
      ENDLOOP.

      " A short batch means the queue is drained; stop polling in this run.
      IF lines( ls_next-jobs ) < lv_limit.
        EXIT.
      ENDIF.
    ENDDO.

    log_message( iv_type = 'I'
                 iv_text = |ZSA_AI_BATCH run finished: rounds={ lv_round }| &&
                           | seen={ rs_result-jobs_seen } completed={ rs_result-jobs_done }| &&
                           | failed={ rs_result-jobs_failed } errors={ rs_result-errors }| ).
  ENDMETHOD.

  METHOD signature_hex.
    rv_signature = zcl_zsa_event_push=>signature_hex( iv_secret = iv_secret
                                                       iv_body   = iv_body ).
  ENDMETHOD.

  METHOD build_auth_headers.
    DATA ls_header TYPE ty_header.
    DATA lv_signature TYPE string.
    lv_signature = signature_hex( iv_secret = iv_secret iv_body = iv_body ).

    ls_header-header_name = `X-SA-Signature`.
    ls_header-header_value = lv_signature.
    APPEND ls_header TO rt_headers.

    ls_header-header_name = `X-SA-Timestamp`.
    ls_header-header_value = iv_timestamp.
    APPEND ls_header TO rt_headers.

    ls_header-header_name = `X-SA-Delivery`.
    ls_header-header_value = iv_delivery.
    APPEND ls_header TO rt_headers.
  ENDMETHOD.

  METHOD parse_jobs_response.
    DATA ls_response TYPE ty_next_response.
    zcl_zsa_json=>deserialize( EXPORTING iv_json = iv_json
                               CHANGING  cs_data = ls_response ).
    IF ls_response-server_time IS NOT INITIAL.
      ls_response-ok = abap_true.
    ENDIF.
    rs_response = ls_response.
  ENDMETHOD.

  METHOD parse_claim_response.
    DATA ls_response TYPE ty_claim_response.
    zcl_zsa_json=>deserialize( EXPORTING iv_json = iv_json
                               CHANGING  cs_data = ls_response ).
    IF ls_response-claim_id IS NOT INITIAL.
      ls_response-ok = abap_true.
    ENDIF.
    rs_response = ls_response.
  ENDMETHOD.

  METHOD parse_gateway_response.
    DATA ls_response TYPE ty_gw_response.
    " The gateway speaks OpenAI compatible snake_case JSON (prompt_tokens,
    " finish_reason, ...), so deserialize without a pretty-name conversion.
    TRY.
        /ui2/cl_json=>deserialize(
          EXPORTING json        = iv_json
                    pretty_name = /ui2/cl_json=>pretty_mode-none
          CHANGING  data        = ls_response ).
      CATCH cx_root.
        RETURN.
    ENDTRY.
    IF lines( ls_response-choices ) = 0.
      RETURN.
    ENDIF.
    DATA ls_choice TYPE ty_gw_choice.
    ls_choice = ls_response-choices[ 1 ].
    IF ls_choice-message-content IS INITIAL.
      RETURN.
    ENDIF.
    rs_response-ok = abap_true.
    rs_response-output_text = ls_choice-message-content.
    rs_response-usage-prompt_tokens = ls_response-usage-prompt_tokens.
    rs_response-usage-completion_tokens = ls_response-usage-completion_tokens.
    rs_response-usage-total_tokens = ls_response-usage-total_tokens.
    rs_response-usage-model = ls_response-model.
  ENDMETHOD.

  METHOD build_gateway_request.
    DATA lv_body TYPE string.
    lv_body = `{"model":"` && zcl_zsa_json=>escape_json( iv_model ) &&
              `","messages":[` &&
              `{"role":"system","content":"` && zcl_zsa_json=>escape_json( iv_system_prompt ) && `"},` &&
              `{"role":"user","content":"` && zcl_zsa_json=>escape_json( iv_prompt ) && `"}]`.
    IF iv_max_output_tokens > 0.
      lv_body = lv_body && `,"max_tokens":` && |{ iv_max_output_tokens }|.
    ENDIF.
    rv_body = lv_body && `}`.
  ENDMETHOD.

  METHOD build_result_succeeded.
    DATA lv_duration TYPE i.
    lv_duration = iv_duration_ms.
    IF lv_duration < 0.
      CLEAR lv_duration.
    ENDIF.
    IF lv_duration > c_max_duration_ms.
      lv_duration = c_max_duration_ms.
    ENDIF.

    DATA lv_usage TYPE string.
    lv_usage = `{"promptTokens":` && |{ is_usage-prompt_tokens }| &&
               `,"completionTokens":` && |{ is_usage-completion_tokens }| &&
               `,"totalTokens":` && |{ is_usage-total_tokens }|.
    IF is_usage-model IS NOT INITIAL.
      lv_usage = lv_usage && `,"model":"` && zcl_zsa_json=>escape_json( is_usage-model ) && `"`.
    ENDIF.
    lv_usage = lv_usage && `}`.

    rv_body = `{"claimId":"` && zcl_zsa_json=>escape_json( iv_claim_id ) &&
              `","status":"succeeded","outputText":"` && zcl_zsa_json=>escape_json( iv_output_text ) &&
              `","usage":` && lv_usage &&
              `,"durationMs":` && |{ lv_duration }| && `}`.
  ENDMETHOD.

  METHOD build_result_failed.
    DATA lv_duration TYPE i.
    lv_duration = iv_duration_ms.
    IF lv_duration < 0.
      CLEAR lv_duration.
    ENDIF.
    IF lv_duration > c_max_duration_ms.
      lv_duration = c_max_duration_ms.
    ENDIF.

    DATA lv_code TYPE string.
    lv_code = iv_code.
    IF lv_code IS INITIAL.
      lv_code = `GATEWAY_ERROR`.
    ENDIF.
    IF strlen( lv_code ) > 64.
      lv_code = substring( val = lv_code len = 64 ).
    ENDIF.

    DATA lv_message TYPE string.
    lv_message = iv_message.
    IF lv_message IS INITIAL.
      lv_message = `AI gateway call failed`.
    ENDIF.
    IF strlen( lv_message ) > c_max_error_chars.
      lv_message = substring( val = lv_message len = c_max_error_chars ).
    ENDIF.

    DATA lv_retryable TYPE string.
    IF iv_retryable = abap_true.
      lv_retryable = `true`.
    ELSE.
      lv_retryable = `false`.
    ENDIF.

    rv_body = `{"claimId":"` && zcl_zsa_json=>escape_json( iv_claim_id ) &&
              `","status":"failed","error":{"code":"` && zcl_zsa_json=>escape_json( lv_code ) &&
              `","message":"` && zcl_zsa_json=>escape_json( lv_message ) &&
              `","retryable":` && lv_retryable &&
              `},"durationMs":` && |{ lv_duration }| && `}`.
  ENDMETHOD.

  METHOD classify_control_status.
    IF iv_status >= 200 AND iv_status < 300.
      rv_class = c_status_ok.
    ELSEIF iv_status = 401 OR iv_status = 403.
      rv_class = c_status_auth.
    ELSEIF iv_status = 409.
      rv_class = c_status_conflict.
    ELSEIF iv_status = 408 OR iv_status = 425 OR iv_status = 429.
      rv_class = c_status_retryable.
    ELSEIF iv_status >= 500.
      rv_class = c_status_retryable.
    ELSE.
      rv_class = c_status_fatal.
    ENDIF.
  ENDMETHOD.

  METHOD classify_gateway_failure.
    IF iv_transport_error IS NOT INITIAL.
      rs_error-code = classify_transport_error( iv_transport_error ).
      rs_error-message = `AI gateway call failed before a response was received`.
      rs_error-retryable = abap_true.
      RETURN.
    ENDIF.
    IF iv_status >= 200 AND iv_status < 300.
      rs_error-code = c_err_empty_output.
      rs_error-message = `AI gateway returned no completion content`.
      rs_error-retryable = abap_true.
      RETURN.
    ENDIF.
    CASE iv_status.
      WHEN 400 OR 422.
        rs_error-code = c_err_bad_request.
        rs_error-message = |AI gateway rejected the request (HTTP { iv_status })|.
        rs_error-retryable = abap_false.
      WHEN 401 OR 403.
        rs_error-code = c_err_auth.
        rs_error-message = |AI gateway authentication failed (HTTP { iv_status })|.
        rs_error-retryable = abap_false.
      WHEN 404.
        rs_error-code = c_err_model_not_found.
        rs_error-message = |AI gateway endpoint or model not found (HTTP { iv_status })|.
        rs_error-retryable = abap_false.
      WHEN 408 OR 429.
        rs_error-code = c_err_rate_limited.
        rs_error-message = |AI gateway is busy (HTTP { iv_status })|.
        rs_error-retryable = abap_true.
      WHEN 500 OR 502 OR 503 OR 504.
        rs_error-code = c_err_unavailable.
        rs_error-message = |AI gateway unavailable (HTTP { iv_status })|.
        rs_error-retryable = abap_true.
      WHEN OTHERS.
        IF iv_status >= 500.
          rs_error-code = c_err_unavailable.
          rs_error-message = |AI gateway unavailable (HTTP { iv_status })|.
          rs_error-retryable = abap_true.
        ELSE.
          rs_error-code = c_err_bad_request.
          rs_error-message = |AI gateway request failed (HTTP { iv_status })|.
          rs_error-retryable = abap_false.
        ENDIF.
    ENDCASE.
  ENDMETHOD.

  METHOD classify_transport_error.
    DATA lv_text TYPE string.
    lv_text = to_upper( iv_transport_error ).
    IF lv_text CP `*TIMEOUT*` OR lv_text CP `*TIME OUT*` OR lv_text CP `*TIMED OUT*`.
      rv_code = c_err_timeout.
    ELSE.
      rv_code = c_err_transport.
    ENDIF.
  ENDMETHOD.

  METHOD heartbeat_due.
    DATA lv_secs TYPE i.
    lv_secs = iv_renew_interval_ms DIV 1000.
    IF lv_secs < c_min_heartbeat_secs.
      lv_secs = c_min_heartbeat_secs.
    ENDIF.
    rv_tstmp = cl_abap_tstmp=>add( tstmp = iv_from secs = lv_secs ).
  ENDMETHOD.

  METHOD effective_timeout_ms.
    IF iv_payload_timeout_ms <= 0 AND iv_cfg_timeout_ms <= 0.
      rv_timeout_ms = c_default_timeout_ms.
    ELSEIF iv_payload_timeout_ms <= 0.
      rv_timeout_ms = iv_cfg_timeout_ms.
    ELSEIF iv_cfg_timeout_ms <= 0.
      rv_timeout_ms = iv_payload_timeout_ms.
    ELSEIF iv_payload_timeout_ms < iv_cfg_timeout_ms.
      rv_timeout_ms = iv_payload_timeout_ms.
    ELSE.
      rv_timeout_ms = iv_cfg_timeout_ms.
    ENDIF.
  ENDMETHOD.

  METHOD clamp_limit.
    IF iv_limit <= 0.
      rv_limit = c_default_limit.
    ELSEIF iv_limit > c_max_limit.
      rv_limit = c_max_limit.
    ELSE.
      rv_limit = iv_limit.
    ENDIF.
  ENDMETHOD.

  METHOD result_delivery.
    rv_delivery = `zsa-ai-result-` && iv_claim_id.
  ENDMETHOD.

  METHOD read_cfg.
    SELECT SINGLE cfg_value FROM zsa_cfg INTO @rv_value WHERE cfg_key = @iv_key.
  ENDMETHOD.

  METHOD hmac_secret.
    " Same reference mechanism as ZCL_ZSA_EVENT_PUSH: ZSA_CFG only stores the
    " name of the Basis-provisioned secret, never the secret itself.
    DATA lv_ref TYPE string.
    lv_ref = read_cfg( `HMAC_SECRET_REF` ).
    IF lv_ref IS INITIAL.
      lv_ref = `ZSA_CONTROL_PLANE_HMAC`.
    ENDIF.
    rv_secret = read_cfg( lv_ref ).
  ENDMETHOD.

  METHOD gateway_key.
    " AI_KEY_REF points at the secure-storage / authorization entry that holds
    " the gateway key; ZSA_CFG never contains the plaintext key.
    DATA lv_ref TYPE string.
    lv_ref = read_cfg( `AI_KEY_REF` ).
    IF lv_ref IS INITIAL.
      RETURN.
    ENDIF.
    rv_key = read_cfg( lv_ref ).
  ENDMETHOD.

  METHOD default_model.
    rv_model = read_cfg( `AI_GATEWAY_MODEL` ).
  ENDMETHOD.

  METHOD gateway_model.
    IF iv_payload_model IS NOT INITIAL.
      rv_model = iv_payload_model.
    ELSE.
      rv_model = default_model( ).
    ENDIF.
  ENDMETHOD.

  METHOD control_plane_base.
    DATA lv_url TYPE string.
    lv_url = read_cfg( `CONTROL_PLANE_URL` ).
    IF lv_url CP `*/`.
      lv_url = substring( val = lv_url len = strlen( lv_url ) - 1 ).
    ENDIF.
    rv_base = lv_url.
  ENDMETHOD.

  METHOD gateway_url.
    DATA lv_url TYPE string.
    lv_url = read_cfg( `AI_GATEWAY_URL` ).
    IF lv_url IS INITIAL.
      RETURN.
    ENDIF.
    IF lv_url CP `*/`.
      lv_url = substring( val = lv_url len = strlen( lv_url ) - 1 ).
    ENDIF.
    IF lv_url CP `*chat/completions`.
      rv_url = lv_url.
    ELSE.
      rv_url = lv_url && c_path_chat_completions.
    ENDIF.
  ENDMETHOD.

  METHOD gateway_timeout_ms.
    DATA lv_cfg TYPE string.
    lv_cfg = read_cfg( `AI_TIMEOUT_MS` ).
    DATA lv_cfg_ms TYPE i.
    TRY.
        lv_cfg_ms = lv_cfg.
      CATCH cx_sy_conversion_no_number.
        CLEAR lv_cfg_ms.
    ENDTRY.
    rv_timeout_ms = effective_timeout_ms( iv_payload_timeout_ms = iv_payload_timeout_ms
                                          iv_cfg_timeout_ms     = lv_cfg_ms ).
  ENDMETHOD.

  METHOD utc_now_iso.
    rv_iso = zcl_zsa_json=>timestamp_to_iso( zcl_zsa_json=>now_tstmp( ) ).
  ENDMETHOD.

  METHOD new_delivery.
    DATA lv_uuid TYPE string.
    TRY.
        lv_uuid = cl_system_uuid=>create_uuid_c32_static( ).
      CATCH cx_root.
        CLEAR lv_uuid.
    ENDTRY.
    IF lv_uuid IS INITIAL.
      lv_uuid = |{ sy-datum }{ sy-uzeit }|.
    ENDIF.
    rv_delivery = `zsa-ai-` && iv_prefix && `-` && lv_uuid.
  ENDMETHOD.

  METHOD http_post.
    DATA lo_client TYPE REF TO if_http_client.
    cl_http_client=>create_by_url(
      EXPORTING url                = iv_url
      IMPORTING client             = lo_client
      EXCEPTIONS argument_not_found = 1
                 plugin_not_active  = 2
                 internal_error     = 3
                 OTHERS             = 4 ).
    IF sy-subrc <> 0.
      rs_result-error = |HTTP client creation failed (sy-subrc { sy-subrc })|.
      RETURN.
    ENDIF.

    lo_client->request->set_method( `POST` ).
    lo_client->request->set_content_type( `application/json` ).
    DATA ls_header TYPE ty_header.
    LOOP AT it_headers INTO ls_header.
      lo_client->request->set_header_field( name  = ls_header-header_name
                                            value = ls_header-header_value ).
    ENDLOOP.
    lo_client->request->set_cdata( iv_body ).

    lo_client->send( EXCEPTIONS OTHERS = 1 ).
    IF sy-subrc = 0.
      lo_client->receive( EXCEPTIONS OTHERS = 2 ).
    ENDIF.

    IF sy-subrc = 0.
      lo_client->response->get_status( IMPORTING code = rs_result-status ).
      rs_result-body = lo_client->response->get_cdata( ).
    ELSE.
      DATA lv_error TYPE string.
      lo_client->get_last_error( IMPORTING message = lv_error ).
      IF lv_error IS INITIAL.
        lv_error = |HTTP transport error (sy-subrc { sy-subrc })|.
      ENDIF.
      rs_result-error = lv_error.
    ENDIF.

    lo_client->close( EXCEPTIONS OTHERS = 3 ).
  ENDMETHOD.

  METHOD post_control_plane.
    DATA lv_timestamp TYPE string.
    lv_timestamp = utc_now_iso( ).
    DATA lt_headers TYPE ty_headers.
    lt_headers = build_auth_headers( iv_secret    = hmac_secret( )
                                     iv_body      = iv_body
                                     iv_timestamp = lv_timestamp
                                     iv_delivery  = iv_delivery ).
    DATA lv_url TYPE string.
    lv_url = control_plane_base( ) && iv_path.
    rs_result = http_post( iv_url = lv_url iv_body = iv_body it_headers = lt_headers ).
  ENDMETHOD.

  METHOD post_gateway.
    DATA lt_headers TYPE ty_headers.
    DATA ls_header TYPE ty_header.
    IF iv_key IS NOT INITIAL.
      ls_header-header_name = `Authorization`.
      ls_header-header_value = |Bearer { iv_key }|.
      APPEND ls_header TO lt_headers.
    ENDIF.
    rs_result = http_post( iv_url = iv_url iv_body = iv_body it_headers = lt_headers ).
  ENDMETHOD.

  METHOD select_jobs.
    DATA lv_body TYPE string.
    lv_body = `{"limit":` && |{ iv_limit }| && `}`.
    DATA lv_delivery TYPE string.
    lv_delivery = new_delivery( `next` ).
    DATA ls_http TYPE ty_http_result.
    ls_http = post_control_plane( iv_path     = c_path_next
                                  iv_body     = lv_body
                                  iv_delivery = lv_delivery ).
    IF ls_http-error IS NOT INITIAL.
      rs_result-error = ls_http-error.
      RETURN.
    ENDIF.
    IF ls_http-status >= 200 AND ls_http-status < 300.
      DATA ls_parsed TYPE ty_next_response.
      ls_parsed = parse_jobs_response( ls_http-body ).
      IF ls_parsed-ok = abap_false.
        rs_result-error = `invalid next response body`.
        RETURN.
      ENDIF.
      rs_result-jobs = ls_parsed-jobs.
      rs_result-ok = abap_true.
      RETURN.
    ENDIF.
    IF ls_http-status = 401 OR ls_http-status = 403.
      rs_result-auth_error = abap_true.
      rs_result-error = |next rejected by HMAC (HTTP { ls_http-status })|.
      RETURN.
    ENDIF.
    rs_result-error = |next HTTP { ls_http-status }|.
  ENDMETHOD.

  METHOD claim_job.
    DATA lv_path TYPE string.
    lv_path = c_path_jobs_prefix && is_job-id && c_path_claim.
    DATA lv_body TYPE string.
    lv_body = `{}`.
    DATA lv_delivery TYPE string.
    lv_delivery = new_delivery( `claim` ).
    DATA ls_http TYPE ty_http_result.
    ls_http = post_control_plane( iv_path     = lv_path
                                  iv_body     = lv_body
                                  iv_delivery = lv_delivery ).
    IF ls_http-error IS NOT INITIAL.
      rs_result-error = ls_http-error.
      RETURN.
    ENDIF.
    IF ls_http-status >= 200 AND ls_http-status < 300.
      DATA ls_claim TYPE ty_claim_response.
      ls_claim = parse_claim_response( ls_http-body ).
      IF ls_claim-claim_id IS INITIAL.
        rs_result-error = `claim response without claimId`.
        RETURN.
      ENDIF.
      rs_result-ok = abap_true.
      rs_result-claim_id = ls_claim-claim_id.
      rs_result-lease = ls_claim-lease.
      RETURN.
    ENDIF.
    IF ls_http-status = 409.
      " Another worker holds a live lease on this job; the control plane
      " interface intentionally answers 409 instead of stealing the claim.
      rs_result-conflict = abap_true.
      RETURN.
    ENDIF.
    rs_result-error = |claim HTTP { ls_http-status }|.
  ENDMETHOD.

  METHOD process_job.
    rv_outcome = c_outcome_skipped.
    DATA ls_claim TYPE ty_claim_result.
    ls_claim = claim_job( is_job ).
    IF ls_claim-conflict = abap_true.
      log_message( iv_type = 'W'
                   iv_text = |job { is_job-id }: claim conflict (409), leaving it to the lease owner| ).
      RETURN.
    ENDIF.
    IF ls_claim-ok = abap_false.
      log_message( iv_type = 'E'
                   iv_text = |job { is_job-id }: claim failed: { ls_claim-error }| ).
      rv_outcome = c_outcome_error.
      RETURN.
    ENDIF.

    DATA ls_call TYPE ty_gateway_call.
    ls_call = execute_on_gateway( is_job      = is_job
                                  iv_claim_id = ls_claim-claim_id
                                  is_lease    = ls_claim-lease ).
    IF ls_call-lease_lost = abap_true.
      log_message( iv_type = 'W'
                   iv_text = |job { is_job-id }: lease lost during the gateway call| ).
      RETURN.
    ENDIF.

    DATA lv_body TYPE string.
    IF ls_call-ok = abap_true.
      lv_body = build_result_succeeded( iv_claim_id    = ls_claim-claim_id
                                        iv_output_text = ls_call-output_text
                                        is_usage       = ls_call-usage
                                        iv_duration_ms = ls_call-duration_ms ).
    ELSE.
      lv_body = build_result_failed( iv_claim_id    = ls_claim-claim_id
                                     iv_code        = ls_call-error_code
                                     iv_message     = ls_call-error_message
                                     iv_retryable   = ls_call-retryable
                                     iv_duration_ms = ls_call-duration_ms ).
    ENDIF.

    DATA ls_report TYPE ty_report_result.
    ls_report = report_result( iv_job_id   = is_job-id
                               iv_claim_id = ls_claim-claim_id
                               iv_body     = lv_body ).
    IF ls_report-status >= 200 AND ls_report-status < 300.
      IF ls_call-ok = abap_true.
        rv_outcome = c_outcome_done.
        log_message( iv_type = 'I'
                     iv_text = |job { is_job-id } succeeded| &&
                               | (stage { is_job-stage_key } attempt { is_job-attempt }| &&
                               | { ls_call-duration_ms }ms)| ).
      ELSE.
        rv_outcome = c_outcome_failed.
        log_message( iv_type = 'E'
                     iv_text = |job { is_job-id } failed: { ls_call-error_code }| &&
                               | (stage { is_job-stage_key } attempt { is_job-attempt },| &&
                               | retryable={ ls_call-retryable })| ).
      ENDIF.
      RETURN.
    ENDIF.
    IF ls_report-status = 409.
      log_message( iv_type = 'W'
                   iv_text = |job { is_job-id }: result rejected (409, claim/lease no longer valid)| ).
      rv_outcome = c_outcome_skipped.
      RETURN.
    ENDIF.
    IF ls_report-status = 401 OR ls_report-status = 403.
      log_message( iv_type = 'E'
                   iv_text = `ZSA_AI_BATCH: result rejected by HMAC; check HMAC_SECRET_REF` ).
      rv_outcome = c_outcome_abort.
      RETURN.
    ENDIF.
    log_message( iv_type = 'E'
                 iv_text = |job { is_job-id }: result post failed (status { ls_report-status } { ls_report-error })| ).
    rv_outcome = c_outcome_error.
  ENDMETHOD.

  METHOD execute_on_gateway.
    DATA lv_url TYPE string.
    lv_url = gateway_url( ).
    IF lv_url IS INITIAL.
      rs_call-error_code = c_err_not_configured.
      rs_call-error_message = `AI_GATEWAY_URL is not configured in ZSA_CFG`.
      RETURN.
    ENDIF.
    DATA lv_model TYPE string.
    lv_model = gateway_model( is_job-payload-model ).
    IF lv_model IS INITIAL.
      rs_call-error_code = c_err_not_configured.
      rs_call-error_message = `no model in the job payload and AI_GATEWAY_MODEL is empty`.
      RETURN.
    ENDIF.

    DATA lv_request TYPE string.
    lv_request = build_gateway_request( iv_model             = lv_model
                                        iv_system_prompt     = is_job-payload-system_prompt
                                        iv_prompt            = is_job-payload-prompt
                                        iv_max_output_tokens = is_job-payload-max_output_tokens ).
    DATA lv_timeout TYPE i.
    lv_timeout = gateway_timeout_ms( is_job-payload-timeout_ms ).
    DATA lv_key TYPE string.
    lv_key = gateway_key( ).

    DATA lv_next_heartbeat TYPE timestampl.
    lv_next_heartbeat = heartbeat_due( iv_from              = zcl_zsa_json=>now_tstmp( )
                                       iv_renew_interval_ms = is_lease-renew_interval_ms ).

    DATA lv_attempt TYPE i.
    DO c_gateway_max_attempts TIMES.
      lv_attempt = sy-index.

      " In a batch work process the gateway call blocks, so there is no
      " parallel heartbeat thread: renew the lease before the call whenever the
      " renewal point may be reached while the call is still running. The
      " effective timeout (payload timeoutMs capped by AI_TIMEOUT_MS) bounds
      " that window.
      DATA lv_now TYPE timestampl.
      DATA lv_call_end TYPE timestampl.
      DATA lv_timeout_secs TYPE i.
      lv_timeout_secs = lv_timeout DIV 1000.
      lv_now = zcl_zsa_json=>now_tstmp( ).
      lv_call_end = cl_abap_tstmp=>add( tstmp = lv_now secs = lv_timeout_secs ).
      IF lv_now >= lv_next_heartbeat OR lv_next_heartbeat <= lv_call_end.
        IF send_heartbeat( iv_job_id = is_job-id iv_claim_id = iv_claim_id ) = abap_false.
          rs_call-lease_lost = abap_true.
          RETURN.
        ENDIF.
        lv_next_heartbeat = heartbeat_due( iv_from              = zcl_zsa_json=>now_tstmp( )
                                           iv_renew_interval_ms = is_lease-renew_interval_ms ).
      ENDIF.

      DATA lv_started TYPE timestampl.
      lv_started = zcl_zsa_json=>now_tstmp( ).
      DATA ls_http TYPE ty_http_result.
      ls_http = post_gateway( iv_url = lv_url iv_body = lv_request iv_key = lv_key ).
      DATA lv_elapsed TYPE i.
      lv_elapsed = cl_abap_tstmp=>subtract( tstmp1 = zcl_zsa_json=>now_tstmp( )
                                            tstmp2 = lv_started ).
      rs_call-duration_ms = rs_call-duration_ms + lv_elapsed * 1000.

      IF ls_http-error IS NOT INITIAL.
        log_message( iv_type = 'W'
                     iv_text = |job { is_job-id }: gateway transport error: { ls_http-error }| ).
        DATA ls_classified TYPE ty_job_error.
        ls_classified = classify_gateway_failure( iv_status          = 0
                                                  iv_transport_error = ls_http-error ).
        rs_call-error_code = ls_classified-code.
        rs_call-error_message = ls_classified-message.
        rs_call-retryable = ls_classified-retryable.
      ELSEIF ls_http-status >= 200 AND ls_http-status < 300.
        DATA ls_parsed TYPE ty_gateway_parse.
        ls_parsed = parse_gateway_response( ls_http-body ).
        IF ls_parsed-ok = abap_true.
          DATA lv_output_length TYPE i.
          lv_output_length = strlen( ls_parsed-output_text ).
          IF lv_output_length > c_max_output_chars.
            rs_call-error_code = c_err_output_too_large.
            rs_call-error_message = `AI gateway output exceeds the protocol limit`.
            rs_call-retryable = abap_false.
          ELSE.
            rs_call-ok = abap_true.
            rs_call-output_text = ls_parsed-output_text.
            rs_call-usage = ls_parsed-usage.
            IF rs_call-usage-model IS INITIAL.
              rs_call-usage-model = lv_model.
            ENDIF.
            IF rs_call-usage-total_tokens = 0 AND
               ( rs_call-usage-prompt_tokens > 0 OR rs_call-usage-completion_tokens > 0 ).
              rs_call-usage-total_tokens = rs_call-usage-prompt_tokens +
                                           rs_call-usage-completion_tokens.
            ENDIF.
            " Keep the lease live for the result post as well.
            IF zcl_zsa_json=>now_tstmp( ) >= lv_next_heartbeat.
              IF send_heartbeat( iv_job_id = is_job-id iv_claim_id = iv_claim_id ) = abap_false.
                rs_call-ok = abap_false.
                rs_call-lease_lost = abap_true.
                RETURN.
              ENDIF.
            ENDIF.
            log_message( iv_type = 'I'
                         iv_text = |job { is_job-id }: gateway call ok| &&
                                   | (length { lv_output_length }, { rs_call-duration_ms }ms)| ).
            RETURN.
          ENDIF.
        ELSE.
          rs_call-error_code = c_err_empty_output.
          rs_call-error_message = `AI gateway returned no completion content`.
          rs_call-retryable = abap_true.
        ENDIF.
      ELSE.
        DATA ls_status_error TYPE ty_job_error.
        ls_status_error = classify_gateway_failure( iv_status = ls_http-status
                                                    iv_transport_error = `` ).
        rs_call-error_code = ls_status_error-code.
        rs_call-error_message = ls_status_error-message.
        rs_call-retryable = ls_status_error-retryable.
      ENDIF.

      IF rs_call-retryable = abap_true AND lv_attempt < c_gateway_max_attempts.
        DATA lv_delay TYPE i.
        lv_delay = gateway_retry_delay( lv_attempt ).
        log_message( iv_type = 'W'
                     iv_text = |job { is_job-id }: gateway retry { lv_attempt }/{ c_gateway_max_attempts }| &&
                               | after { lv_delay }s ({ rs_call-error_code })| ).
        WAIT UP TO lv_delay SECONDS.
        CLEAR rs_call.
        CONTINUE.
      ENDIF.
      RETURN.
    ENDDO.
  ENDMETHOD.

  METHOD send_heartbeat.
    DATA lv_path TYPE string.
    lv_path = c_path_jobs_prefix && iv_job_id && c_path_heartbeat.
    DATA lv_body TYPE string.
    lv_body = `{"claimId":"` && zcl_zsa_json=>escape_json( iv_claim_id ) && `"}`.
    DATA ls_http TYPE ty_http_result.
    ls_http = post_control_plane( iv_path     = lv_path
                                  iv_body     = lv_body
                                  iv_delivery = new_delivery( `heartbeat` ) ).
    IF ls_http-error IS NOT INITIAL.
      log_message( iv_type = 'W'
                   iv_text = |job { iv_job_id }: heartbeat transport error: { ls_http-error }| ).
      RETURN.
    ENDIF.
    IF ls_http-status >= 200 AND ls_http-status < 300.
      rv_ok = abap_true.
    ELSE.
      log_message( iv_type = 'W'
                   iv_text = |job { iv_job_id }: heartbeat rejected (HTTP { ls_http-status })| ).
    ENDIF.
  ENDMETHOD.

  METHOD report_result.
    DATA lv_path TYPE string.
    lv_path = c_path_jobs_prefix && iv_job_id && c_path_result.
    DATA lv_attempt TYPE i.
    DO c_result_attempts TIMES.
      lv_attempt = sy-index.
      DATA ls_http TYPE ty_http_result.
      ls_http = post_control_plane( iv_path     = lv_path
                                    iv_body     = iv_body
                                    iv_delivery = result_delivery( iv_claim_id ) ).
      IF ls_http-error IS INITIAL AND ls_http-status >= 200 AND ls_http-status < 300.
        rs_result-status = ls_http-status.
        RETURN.
      ENDIF.
      rs_result-status = ls_http-status.
      rs_result-error = ls_http-error.
      IF ls_http-error IS INITIAL AND ls_http-status = 409.
        " Terminal for this claim: the control plane already resolved the job.
        RETURN.
      ENDIF.
      IF ls_http-error IS INITIAL AND ( ls_http-status = 401 OR ls_http-status = 403 ).
        RETURN.
      ENDIF.
      IF lv_attempt < c_result_attempts.
        log_message( iv_type = 'W'
                     iv_text = |job { iv_job_id }: result post retry { lv_attempt }/{ c_result_attempts }| ).
        DATA lv_retry_delay TYPE i.
        lv_retry_delay = c_result_retry_delay_secs.
        WAIT UP TO lv_retry_delay SECONDS.
      ENDIF.
    ENDDO.
  ENDMETHOD.

  METHOD log_message.
    " ABAP application log (SLG1) -> visible in the SM37 job log. The log object
    " ZSA / subobject AI_BATCH is a Basis setup item (SM30/SLG0); when it is not
    " configured the log call is skipped silently and the job still completes.
    " Never pass prompt/output bodies here: only ids, counts, durations, status
    " and error codes.
    TRY.
        DATA ls_log TYPE bal_s_log.
        ls_log-object = `ZSA`.
        ls_log-subobject = `AI_BATCH`.
        ls_log-extnumber = `ZSA_AI_BATCH`.
        ls_log-alprog = sy-cprog.
        ls_log-aldate = sy-datum.
        ls_log-altime = sy-uzeit.
        DATA lv_log_handle TYPE balloghndl.
        CALL FUNCTION 'BAL_LOG_CREATE'
          EXPORTING i_s_log        = ls_log
          IMPORTING e_log_handle   = lv_log_handle
          EXCEPTIONS OTHERS        = 1.
        IF sy-subrc = 0 AND lv_log_handle IS NOT INITIAL.
          CALL FUNCTION 'BAL_LOG_MSG_ADD_FREE_TEXT'
            EXPORTING i_log_handle = lv_log_handle
                      i_msgty      = iv_type
                      i_probclass  = '2'
                      i_text       = iv_text
            EXCEPTIONS OTHERS      = 2.
          CALL FUNCTION 'BAL_DB_SAVE'
            EXPORTING i_save_all   = abap_true
            EXCEPTIONS OTHERS      = 3.
          " Batch entry point: persist the log entry right away so SM37/SLG1
          " show it even if a later job step aborts.
          COMMIT WORK.
        ENDIF.
      CATCH cx_root.
        " Logging must never break the job itself.
    ENDTRY.
  ENDMETHOD.

  METHOD gateway_retry_delay.
    CASE iv_attempt.
      WHEN 1.
        rv_secs = 2.
      WHEN 2.
        rv_secs = 5.
      WHEN OTHERS.
        rv_secs = 10.
    ENDCASE.
  ENDMETHOD.
ENDCLASS.
