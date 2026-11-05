CLASS ltc_zsa_http_handler DEFINITION FOR TESTING
  RISK LEVEL HARMLESS
  DURATION SHORT.
  PRIVATE SECTION.
    METHODS route_classification FOR TESTING.
    METHODS writeback_whitelist FOR TESTING.
    METHODS iso_timestamp_roundtrip FOR TESTING.
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
ENDCLASS.
