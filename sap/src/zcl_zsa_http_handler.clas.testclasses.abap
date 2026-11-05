CLASS ltc_zsa_http_handler DEFINITION FOR TESTING
  RISK LEVEL HARMLESS
  DURATION SHORT.
  PRIVATE SECTION.
    METHODS route_classification FOR TESTING.
    METHODS writeback_whitelist FOR TESTING.
    METHODS iso_timestamp_roundtrip FOR TESTING.
    METHODS current_user_is_session_user FOR TESTING.
    METHODS resolve_decided_by_default FOR TESTING.
    METHODS resolve_decided_by_explicit FOR TESTING.
    METHODS current_user_json_fragment FOR TESTING.
ENDCLASS.

CLASS ltc_zsa_http_handler IMPLEMENTATION.
  METHOD route_classification.
    DATA(lv) = zcl_zsa_http_handler=>classify_route( iv_method = `GET` iv_path = `/api/demands` ).
    cl_abap_unit_assert=>assert_equals( act = lv exp = zcl_zsa_http_handler=>c_route_demand_list ).
    lv = zcl_zsa_http_handler=>classify_route( iv_method = `POST` iv_path = `/api/demands` ).
    cl_abap_unit_assert=>assert_equals( act = lv exp = zcl_zsa_http_handler=>c_route_demand_create ).
    lv = zcl_zsa_http_handler=>classify_route(
           iv_method = `GET` iv_path = `/api/demands/4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3` ).
    cl_abap_unit_assert=>assert_equals( act = lv exp = zcl_zsa_http_handler=>c_route_demand_detail ).
    lv = zcl_zsa_http_handler=>classify_route(
           iv_method = `PATCH` iv_path = `/api/demands/4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3` ).
    cl_abap_unit_assert=>assert_equals( act = lv exp = zcl_zsa_http_handler=>c_route_demand_update ).
    lv = zcl_zsa_http_handler=>classify_route(
           iv_method = `POST` iv_path = `/api/demands/abc/approvals` ).
    cl_abap_unit_assert=>assert_equals( act = lv exp = zcl_zsa_http_handler=>c_route_demand_approval ).
    lv = zcl_zsa_http_handler=>classify_route( iv_method = `GET` iv_path = `/ui/index.html` ).
    cl_abap_unit_assert=>assert_equals( act = lv exp = zcl_zsa_http_handler=>c_route_ui ).
    lv = zcl_zsa_http_handler=>classify_route( iv_method = `GET` iv_path = `/api/health` ).
    cl_abap_unit_assert=>assert_equals( act = lv exp = zcl_zsa_http_handler=>c_route_health ).
    lv = zcl_zsa_http_handler=>classify_route( iv_method = `DELETE` iv_path = `/api/demands` ).
    cl_abap_unit_assert=>assert_equals( act = lv exp = zcl_zsa_http_handler=>c_route_unknown ).
  ENDMETHOD.

  METHOD writeback_whitelist.
    cl_abap_unit_assert=>assert_true(
      act = zcl_zsa_http_handler=>is_writeback_field_allowed( `STATUS` ) ).
    cl_abap_unit_assert=>assert_true(
      act = zcl_zsa_http_handler=>is_writeback_field_allowed( `ARTIFACTS` ) ).
    cl_abap_unit_assert=>assert_false(
      act = zcl_zsa_http_handler=>is_writeback_field_allowed( `TITLE` )
      msg = `business fields must never be writable by the control plane` ).
    cl_abap_unit_assert=>assert_false(
      act = zcl_zsa_http_handler=>is_writeback_field_allowed( `ACCEPTANCE` ) ).
  ENDMETHOD.

  METHOD iso_timestamp_roundtrip.
    DATA(lv_ts) = zcl_zsa_http_handler=>iso_to_tstmp( `2026-11-05T08:00:00Z` ).
    DATA(lv_iso) = zcl_zsa_json=>timestamp_to_iso( lv_ts ).
    cl_abap_unit_assert=>assert_equals( act = lv_iso exp = `2026-11-05T08:00:00Z` ).
  ENDMETHOD.

  METHOD current_user_is_session_user.
    DATA lv_expected TYPE char12.
    lv_expected = sy-uname.
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_http_handler=>current_user( )
      exp = lv_expected
      msg = `current_user must come from the SAP session` ).
  ENDMETHOD.

  METHOD resolve_decided_by_default.
    DATA lv_expected TYPE char12.
    lv_expected = sy-uname.
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_http_handler=>resolve_decided_by( `` )
      exp = lv_expected
      msg = `missing decidedBy falls back to the session user` ).
  ENDMETHOD.

  METHOD resolve_decided_by_explicit.
    DATA lv_expected TYPE char12.
    lv_expected = `CONSULTANT`.
    cl_abap_unit_assert=>assert_equals(
      act = zcl_zsa_http_handler=>resolve_decided_by( `CONSULTANT` )
      exp = lv_expected
      msg = `explicit decidedBy is preserved` ).
  ENDMETHOD.

  METHOD current_user_json_fragment.
    DATA lv_json TYPE string.
    DATA lv_user TYPE string.
    lv_json = zcl_zsa_http_handler=>current_user_json( ).
    lv_user = zcl_zsa_http_handler=>current_user( ).
    SHIFT lv_user RIGHT DELETING TRAILING space.
    cl_abap_unit_assert=>assert_equals(
      act = find( val = lv_json sub = `,"currentUser":"` )
      exp = 0
      msg = `currentUser fragment must start with the field marker` ).
    cl_abap_unit_assert=>assert_equals(
      act = lv_json
      exp = `,"currentUser":"` && lv_user && `"`
      msg = `currentUser fragment must carry the SAP session user` ).
  ENDMETHOD.
ENDCLASS.
