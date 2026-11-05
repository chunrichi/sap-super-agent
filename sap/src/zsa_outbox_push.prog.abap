REPORT zsa_outbox_push.

* ---------------------------------------------------------------------------
* H2 / S2: SAP -> control-plane event push (docs/004 §3.3).
*
* Scheduled every minute (SM36) or via bgRFC. The class owns selection,
* HMAC signing, backoff (1s/5s/30s/5min/30min) and the 24h DEAD transition;
* the program is only the scheduling entry point.
* ---------------------------------------------------------------------------
TRY.
    zcl_zsa_event_push=>run( ).
  CATCH cx_root INTO DATA(lx_error).
    MESSAGE lx_error->get_text( ) TYPE 'E'.
ENDTRY.
