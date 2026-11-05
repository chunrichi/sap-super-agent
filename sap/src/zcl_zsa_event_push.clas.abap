CLASS zcl_zsa_event_push DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CONSTANTS c_state_new TYPE char10 VALUE 'NEW'.
    CONSTANTS c_state_sent TYPE char10 VALUE 'SENT'.
    CONSTANTS c_state_dead TYPE char10 VALUE 'DEAD'.
    CONSTANTS c_max_attempts TYPE i VALUE 5.
    CONSTANTS c_dead_after_secs TYPE i VALUE 86400.

    TYPES ty_backoff TYPE STANDARD TABLE OF i WITH DEFAULT KEY.

    " docs/004 §3.3: 1s / 5s / 30s / 5min / 30min, DEAD after 24h.
    CLASS-METHODS backoff_delay
      IMPORTING iv_attempt      TYPE i
      RETURNING VALUE(rv_secs) TYPE i.

    CLASS-METHODS run
      IMPORTING iv_limit TYPE i DEFAULT 50.

    CLASS-METHODS push_event
      IMPORTING is_event      TYPE zsa_event_out
      RETURNING VALUE(rv_ok) TYPE abap_bool.

    " HMAC-SHA256 over the raw body; header format `sha256=<hex>`.
    CLASS-METHODS signature_hex
      IMPORTING iv_secret          TYPE string
                iv_body            TYPE string
      RETURNING VALUE(rv_signature) TYPE string.

  PRIVATE SECTION.
    CLASS-METHODS read_cfg
      IMPORTING iv_key           TYPE string
      RETURNING VALUE(rv_value) TYPE string.

    CLASS-METHODS hmac_secret
      RETURNING VALUE(rv_secret) TYPE string.

    CLASS-METHODS mark_sent
      IMPORTING is_event TYPE zsa_event_out.

    CLASS-METHODS handle_failure
      IMPORTING is_event TYPE zsa_event_out.

    CLASS-METHODS post_http
      IMPORTING iv_url          TYPE string
                iv_body         TYPE string
                iv_signature    TYPE string
                iv_timestamp    TYPE string
                iv_delivery     TYPE string
      RETURNING VALUE(rv_status) TYPE i.

    CLASS-METHODS to_hex
      IMPORTING iv_x            TYPE xstring
      RETURNING VALUE(rv_hex) TYPE string.

    CLASS-METHODS timestamp_short
      IMPORTING iv_tstmp        TYPE timestampl
      RETURNING VALUE(rv_short) TYPE timestamp.
ENDCLASS.

CLASS zcl_zsa_event_push IMPLEMENTATION.
  METHOD backoff_delay.
    CASE iv_attempt.
      WHEN 1. rv_secs = 1.
      WHEN 2. rv_secs = 5.
      WHEN 3. rv_secs = 30.
      WHEN 4. rv_secs = 300.
      WHEN OTHERS. rv_secs = 1800.
    ENDCASE.
  ENDMETHOD.

  METHOD run.
    DATA lt_events TYPE STANDARD TABLE OF zsa_event_out WITH DEFAULT KEY.
    DATA lv_now TYPE timestampl.
    lv_now = zcl_zsa_json=>now_tstmp( ).

    SELECT * FROM zsa_event_out
      INTO TABLE @lt_events
      WHERE state = @c_state_new
        AND next_at <= @lv_now
      ORDER BY next_at
      UP TO @iv_limit ROWS.

    LOOP AT lt_events INTO DATA(ls_event).
      TRY.
          IF push_event( ls_event ) = abap_true.
            mark_sent( ls_event ).
          ELSE.
            handle_failure( ls_event ).
          ENDIF.
        CATCH cx_root.
          handle_failure( ls_event ).
      ENDTRY.
    ENDLOOP.
    COMMIT WORK AND WAIT.
  ENDMETHOD.

  METHOD push_event.
    DATA(lv_url) = read_cfg( `CONTROL_PLANE_URL` ).
    IF lv_url IS INITIAL.
      RETURN.
    ENDIF.
    DATA(lv_secret) = hmac_secret( ).
    IF lv_secret IS INITIAL.
      RETURN.
    ENDIF.
    DATA(lv_occurred) = zcl_zsa_json=>timestamp_to_iso( is_event-created_at ).
    DATA(lv_body) = zcl_zsa_json=>envelope_body(
      iv_event_id    = is_event-event_id
      iv_occurred_at = lv_occurred
      iv_data_json   = is_event-payload ).
    DATA(lv_signature) = signature_hex( iv_secret = lv_secret iv_body = lv_body ).
    DATA(lv_status) = post_http(
      iv_url       = lv_url
      iv_body      = lv_body
      iv_signature = lv_signature
      iv_timestamp = lv_occurred
      iv_delivery  = is_event-event_id ).
    rv_ok = COND #( WHEN lv_status >= 200 AND lv_status < 300 THEN abap_true ELSE abap_false ).
  ENDMETHOD.

  METHOD signature_hex.
    DATA lv_digest TYPE xstring.
    TRY.
        cl_abap_hmac=>calculate_hmac_for_char(
          EXPORTING if_algorithm     = `SHA256`
                    if_key           = iv_secret
                    if_data          = iv_body
          IMPORTING ef_hmacxstring   = lv_digest ).
      CATCH cx_root.
        RETURN.
    ENDTRY.
    rv_signature = `sha256=` && to_hex( lv_digest ).
  ENDMETHOD.

  METHOD read_cfg.
    SELECT SINGLE cfg_value FROM zsa_cfg INTO @rv_value WHERE cfg_key = @iv_key.
  ENDMETHOD.

  METHOD hmac_secret.
    " v1 keeps only a *reference* in ZSA_CFG (docs/004 §2); the actual secret is
    " provisioned by Basis as an application secret / environment value named by
    " HMAC_SECRET_REF. Phase B records the concrete Basis mechanism used on the
    " target test system; no plaintext secret is stored in this table.
    DATA(lv_ref) = read_cfg( `HMAC_SECRET_REF` ).
    IF lv_ref IS INITIAL.
      lv_ref = `ZSA_CONTROL_PLANE_HMAC`.
    ENDIF.
    rv_secret = read_cfg( lv_ref ).
  ENDMETHOD.

  METHOD mark_sent.
    DATA(lv_now) = zcl_zsa_json=>now_tstmp( ).
    UPDATE zsa_event_out
      SET state = @c_state_sent
          changed_at = @lv_now
      WHERE event_id = @is_event-event_id.
  ENDMETHOD.

  METHOD handle_failure.
    DATA(lv_now) = zcl_zsa_json=>now_tstmp( ).
    DATA(lv_attempts) = is_event-attempts + 1.
    DATA(lv_next_short) = timestamp_short( lv_now ) + backoff_delay( lv_attempts ).
    DATA lv_next TYPE timestampl.
    lv_next = lv_next_short.
    DATA(lv_age) = timestamp_short( lv_now ) - timestamp_short( is_event-created_at ).

    IF lv_attempts >= c_max_attempts OR lv_age >= c_dead_after_secs.
      UPDATE zsa_event_out
        SET state = @c_state_dead
            attempts = @lv_attempts
            changed_at = @lv_now
        WHERE event_id = @is_event-event_id.
    ELSE.
      UPDATE zsa_event_out
        SET attempts = @lv_attempts
            next_at = @lv_next
            changed_at = @lv_now
        WHERE event_id = @is_event-event_id.
    ENDIF.
  ENDMETHOD.

  METHOD post_http.
    DATA lo_client TYPE REF TO if_http_client.
    cl_http_client=>create_by_url(
      EXPORTING url                = iv_url
      IMPORTING client             = lo_client
      EXCEPTIONS argument_not_found = 1
                 plugin_not_active  = 2
                 internal_error     = 3
                 OTHERS             = 4 ).
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    lo_client->request->set_method( `POST` ).
    lo_client->request->set_content_type( `application/json` ).
    lo_client->request->set_header_field( name = `X-SA-Signature` value = iv_signature ).
    lo_client->request->set_header_field( name = `X-SA-Timestamp` value = iv_timestamp ).
    lo_client->request->set_header_field( name = `X-SA-Delivery` value = iv_delivery ).
    lo_client->request->set_cdata( iv_body ).
    lo_client->send( EXCEPTIONS OTHERS = 1 ).
    IF sy-subrc = 0.
      lo_client->receive( EXCEPTIONS OTHERS = 2 ).
    ENDIF.
    IF sy-subrc = 0.
      lo_client->response->get_status( IMPORTING code = rv_status ).
    ENDIF.
    lo_client->close( EXCEPTIONS OTHERS = 3 ).
  ENDMETHOD.

  METHOD to_hex.
    CONSTANTS c_hex TYPE string VALUE `0123456789abcdef`.
    DATA lv_len TYPE i.
    lv_len = xstrlen( iv_x ).
    DO lv_len TIMES.
      DATA(lv_offset) = sy-index - 1.
      DATA(lv_byte) = iv_x+lv_offset(1).
      DATA(lv_int) = CONV i( lv_byte ).
      DATA(lv_high) = lv_int DIV 16.
      DATA(lv_low) = lv_int MOD 16.
      rv_hex = rv_hex && c_hex+lv_high(1) && c_hex+lv_low(1).
    ENDDO.
  ENDMETHOD.

  METHOD timestamp_short.
    rv_short = iv_tstmp.
  ENDMETHOD.
ENDCLASS.
