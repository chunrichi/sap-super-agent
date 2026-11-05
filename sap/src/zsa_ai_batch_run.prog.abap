REPORT zsa_ai_batch_run.

* ---------------------------------------------------------------------------
* S5 / M3: SAP batch AI executor entry point (docs/003 section 4.8,
* docs/004 section 7.1).
*
* Scheduled as a periodic SM36 job (bgRFC is a Phase B optional channel, it is
* not required). ZCL_ZSA_AI_BATCH owns job pull / claim / gateway call /
* heartbeat / result reporting; ZSA_CFG holds CONTROL_PLANE_URL,
* HMAC_SECRET_REF, AI_GATEWAY_URL, AI_GATEWAY_MODEL, AI_KEY_REF and
* AI_TIMEOUT_MS. Prompt and model output bodies are never written to the BAL /
* SM37 logs - only ids, lengths, durations, status and error codes.
* ---------------------------------------------------------------------------
DATA ls_result TYPE zcl_zsa_ai_batch=>ty_run_result.

TRY.
    ls_result = zcl_zsa_ai_batch=>run_batch( ).
    WRITE: / `ZSA_AI_BATCH_RUN`, sy-datum, sy-uzeit.
    WRITE: / `jobs seen`, ls_result-jobs_seen,
            `completed`, ls_result-jobs_done,
            `failed`, ls_result-jobs_failed,
            `errors`, ls_result-errors.
  CATCH cx_root INTO DATA(lx_error).
    MESSAGE lx_error->get_text( ) TYPE 'E'.
ENDTRY.
