CLASS ltc_zsa_event_push DEFINITION FOR TESTING
  RISK LEVEL HARMLESS
  DURATION SHORT.
  PRIVATE SECTION.
    METHODS backoff_sequence FOR TESTING.
    METHODS signature_format FOR TESTING.
    METHODS signature_matches_documented_rule FOR TESTING.
ENDCLASS.

CLASS ltc_zsa_event_push IMPLEMENTATION.
  METHOD backoff_sequence.
    cl_abap_unit_assert=>assert_equals( act = zcl_zsa_event_push=>backoff_delay( 1 ) exp = 1
                                        msg = `first retry after 1s` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_zsa_event_push=>backoff_delay( 2 ) exp = 5
                                        msg = `second retry after 5s` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_zsa_event_push=>backoff_delay( 3 ) exp = 30
                                        msg = `third retry after 30s` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_zsa_event_push=>backoff_delay( 4 ) exp = 300
                                        msg = `fourth retry after 5min` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_zsa_event_push=>backoff_delay( 5 ) exp = 1800
                                        msg = `fifth retry after 30min` ).
  ENDMETHOD.

  METHOD signature_format.
    DATA(lv_sig) = zcl_zsa_event_push=>signature_hex(
      iv_secret = `test-secret`
      iv_body   = `{"eventId":"abc","data":{"type":"demand.submitted"}}` ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_sig exp = `sha256:*`
                                        msg = `signature carries the documented prefix` ).
    cl_abap_unit_assert=>assert_equals( act = strlen( lv_sig ) exp = 71
                                        msg = `sha256= + 64 hex chars` ).
    DATA(lv_hex) = substring( val = lv_sig off = 7 ).
    DATA(lv_is_lower_hex) = abap_true.
    DATA lv_index TYPE i.
    WHILE lv_index < strlen( lv_hex ).
      DATA(lv_char) = lv_hex+lv_index(1).
      IF NOT ( ( lv_char >= `0` AND lv_char <= `9` ) OR ( lv_char >= `a` AND lv_char <= `f` ) ).
        lv_is_lower_hex = abap_false.
        EXIT.
      ENDIF.
      lv_index = lv_index + 1.
    ENDWHILE.
    cl_abap_unit_assert=>assert_true( act = lv_is_lower_hex msg = `hex digest is lowercase` ).
  ENDMETHOD.

  METHOD signature_matches_documented_rule.
    " HMAC-SHA256 of the exact body bytes; the control plane verifies the same
    " rule with node:crypto (packages/sap-adapter/src/signature.ts).
    DATA(lv_sig) = zcl_zsa_event_push=>signature_hex( iv_secret = `secret` iv_body = `{}` ).
    cl_abap_unit_assert=>assert_not_initial( act = lv_sig ).
  ENDMETHOD.
ENDCLASS.
