REPORT zsa_ddic_bootstrap.

* ---------------------------------------------------------------------------
* ZSA DDIC bootstrap — ONE-OFF workaround, kept for reproducibility only.
*
* Why this exists: abap-cli 2.2.0 `create TABL` routes through the bundled
* ICF service, whose create_ddic_table / build_table_header always writes
* DD02V-EXCLASS = '2' ("Can Be Enhanced (Char. Type)") and forwards the AFF
* string type as DDIC DATATYPE 'STRING' (truncated to 'STRI'). Tables that
* contain numeric (INT4 / TIMESTAMPL) or deep (STRING) fields are therefore
* rejected by GOX_GEN_TABLE_STD. This report mirrors the same GOX call with
* the correct EXCLASS (3 = numeric+char, 4 = deep) and DATATYPE 'STRG'.
*
* The canonical object definitions stay in sap/src/*.tabl.{json,ddic}; after
* this report ran, `abap pull TABL <name>` round-trips them. Do not use this
* program on a transportable package (it hardcodes $ZSA and no transport).
*
* Run: abap push sap/src/zsa_ddic_bootstrap.prog.abap --yes
*      abap run-report ZSA_DDIC_BOOTSTRAP --json
* ---------------------------------------------------------------------------

TYPES: BEGIN OF ty_field_def,
         fieldname TYPE fieldname,
         datatype  TYPE char4,
         leng      TYPE i,
         decimals  TYPE i,
         rollname  TYPE rollname,
         keyflag   TYPE abap_bool,
         notnull   TYPE abap_bool,
       END OF ty_field_def,
       tt_field_def TYPE STANDARD TABLE OF ty_field_def WITH DEFAULT KEY.

CONSTANTS c_package TYPE devclass VALUE '$ZSA'.

DATA: gt_fields     TYPE tt_field_def,
      gt_object_new TYPE comt_gox_def_header,
      gt_object_old TYPE comt_gox_def_header,
      gt_bapireturn TYPE bapirettab,
      gt_transport  TYPE comt_gox_trans_object,
      gs_header     TYPE coms_gox_def_header,
      gs_field      TYPE coms_gox_def_header,
      gv_created    TYPE i,
      gv_failed     TYPE i,
      gv_no_request TYPE trkorr.

START-OF-SELECTION.
  WRITE: / 'ZSA DDIC bootstrap start (package: $ZSA)'.
  PERFORM create_zsa_demand.
  PERFORM create_zsa_demand_t.
  PERFORM create_zsa_artifact.
  PERFORM create_zsa_approval.
  PERFORM create_zsa_event_out.
  PERFORM create_zsa_cfg.
  WRITE: / 'SUMMARY created=', gv_created, 'failed=', gv_failed.

* ---------------------------------------------------------------------------
* Per-table field definitions (mirrors the AFF .tabl.ddic files).
* ---------------------------------------------------------------------------
FORM create_zsa_demand.
  CLEAR gt_fields.
  APPEND VALUE #( fieldname = 'MANDT' rollname = 'MANDT' keyflag = abap_true notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'DEMAND_ID' datatype = 'CHAR' leng = 32 keyflag = abap_true notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'DEMAND_NO' datatype = 'CHAR' leng = 12 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'TITLE' datatype = 'CHAR' leng = 200 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'REQ_USER' datatype = 'CHAR' leng = 12 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'ORG_UNIT' datatype = 'CHAR' leng = 40 ) TO gt_fields.
  APPEND VALUE #( fieldname = 'PRIORITY' datatype = 'CHAR' leng = 10 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'TEMPLATE_ID' datatype = 'CHAR' leng = 40 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'TEMPLATE_VERSION' datatype = 'NUMC' leng = 4 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'REPO_KEY' datatype = 'CHAR' leng = 64 ) TO gt_fields.
  APPEND VALUE #( fieldname = 'PROJECT_KEY' datatype = 'CHAR' leng = 40 ) TO gt_fields.
  APPEND VALUE #( fieldname = 'STATUS' datatype = 'CHAR' leng = 20 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'STATUS_TEXT' datatype = 'CHAR' leng = 40 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'STAGE_KEY' datatype = 'CHAR' leng = 30 ) TO gt_fields.
  APPEND VALUE #( fieldname = 'VERSION' datatype = 'INT4' notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'CREATED_AT' rollname = 'TIMESTAMPL' notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'CHANGED_AT' rollname = 'TIMESTAMPL' notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'SAP_NOTE' datatype = 'CHAR' leng = 255 ) TO gt_fields.
  PERFORM create_table USING 'ZSA_DEMAND' 'ZSA demand master (S2 SAP demand system)'
                                'A' 'APPL0' '0' '3'.
ENDFORM.

FORM create_zsa_demand_t.
  CLEAR gt_fields.
  APPEND VALUE #( fieldname = 'MANDT' rollname = 'MANDT' keyflag = abap_true notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'DEMAND_ID' datatype = 'CHAR' leng = 32 keyflag = abap_true notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'LANG' datatype = 'LANG' leng = 1 keyflag = abap_true notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'DESCRIPTION' datatype = 'STRG' ) TO gt_fields.
  APPEND VALUE #( fieldname = 'ACCEPTANCE' datatype = 'STRG' ) TO gt_fields.
  PERFORM create_table USING 'ZSA_DEMAND_T' 'ZSA demand long text and acceptance criteria'
                                'A' 'APPL0' '0' '4'.
ENDFORM.

FORM create_zsa_artifact.
  CLEAR gt_fields.
  APPEND VALUE #( fieldname = 'MANDT' rollname = 'MANDT' keyflag = abap_true notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'ARTIFACT_ID' datatype = 'CHAR' leng = 32 keyflag = abap_true notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'DEMAND_ID' datatype = 'CHAR' leng = 32 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'STAGE_KEY' datatype = 'CHAR' leng = 30 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'STAGE_RUN_ID' datatype = 'CHAR' leng = 32 ) TO gt_fields.
  APPEND VALUE #( fieldname = 'KIND' datatype = 'CHAR' leng = 30 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'VERSION' datatype = 'INT4' notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'CHECKSUM' datatype = 'CHAR' leng = 64 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'CONTENT_REF' datatype = 'CHAR' leng = 255 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'CONTENT_TYPE' datatype = 'CHAR' leng = 128 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'STATUS' datatype = 'CHAR' leng = 20 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'AUTHOR_TYPE' datatype = 'CHAR' leng = 10 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'AUTHOR_ID' datatype = 'CHAR' leng = 40 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'CREATED_AT' rollname = 'TIMESTAMPL' notnull = abap_true ) TO gt_fields.
  PERFORM create_table USING 'ZSA_ARTIFACT' 'ZSA artifact metadata projection'
                                'A' 'APPL0' '1' '3'.
ENDFORM.

FORM create_zsa_approval.
  CLEAR gt_fields.
  APPEND VALUE #( fieldname = 'MANDT' rollname = 'MANDT' keyflag = abap_true notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'APPROVAL_ID' datatype = 'CHAR' leng = 32 keyflag = abap_true notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'DEMAND_ID' datatype = 'CHAR' leng = 32 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'STAGE_KEY' datatype = 'CHAR' leng = 30 ) TO gt_fields.
  APPEND VALUE #( fieldname = 'GATE_KEY' datatype = 'CHAR' leng = 30 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'STATE' datatype = 'CHAR' leng = 20 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'REQUIRED_ROLE' datatype = 'CHAR' leng = 40 ) TO gt_fields.
  APPEND VALUE #( fieldname = 'DECIDED_BY' datatype = 'CHAR' leng = 12 ) TO gt_fields.
  APPEND VALUE #( fieldname = 'DECIDED_AT' rollname = 'TIMESTAMPL' ) TO gt_fields.
  APPEND VALUE #( fieldname = 'DECISION_COMMENT' datatype = 'STRG' ) TO gt_fields.
  PERFORM create_table USING 'ZSA_APPROVAL' 'ZSA gate approval audit trail'
                                'A' 'APPL0' '1' '4'.
ENDFORM.

FORM create_zsa_event_out.
  CLEAR gt_fields.
  APPEND VALUE #( fieldname = 'MANDT' rollname = 'MANDT' keyflag = abap_true notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'EVENT_ID' datatype = 'CHAR' leng = 32 keyflag = abap_true notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'TYPE' datatype = 'CHAR' leng = 40 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'DEMAND_ID' datatype = 'CHAR' leng = 32 ) TO gt_fields.
  APPEND VALUE #( fieldname = 'PAYLOAD' datatype = 'STRG' ) TO gt_fields.
  APPEND VALUE #( fieldname = 'STATE' datatype = 'CHAR' leng = 10 notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'ATTEMPTS' datatype = 'INT4' notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'NEXT_AT' rollname = 'TIMESTAMPL' notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'CREATED_AT' rollname = 'TIMESTAMPL' notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'CHANGED_AT' rollname = 'TIMESTAMPL' notnull = abap_true ) TO gt_fields.
  PERFORM create_table USING 'ZSA_EVENT_OUT' 'ZSA outbound event outbox (at-least-once push)'
                                'A' 'APPL1' '1' '4'.
ENDFORM.

FORM create_zsa_cfg.
  CLEAR gt_fields.
  APPEND VALUE #( fieldname = 'MANDT' rollname = 'MANDT' keyflag = abap_true notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'CFG_KEY' datatype = 'CHAR' leng = 64 keyflag = abap_true notnull = abap_true ) TO gt_fields.
  APPEND VALUE #( fieldname = 'CFG_VALUE' datatype = 'STRG' ) TO gt_fields.
  APPEND VALUE #( fieldname = 'CHANGED_AT' rollname = 'TIMESTAMPL' notnull = abap_true ) TO gt_fields.
  PERFORM create_table USING 'ZSA_CFG' 'ZSA integration configuration (no plain secrets)'
                                'C' 'APPL0' '0' '4'.
ENDFORM.

* ---------------------------------------------------------------------------
* Generic GOX create — same pattern as ZCL_ABAP_VIBE_ICF_DDIC=>create_ddic_table
* but with EXCLASS / DATATYPE passed correctly.
* ---------------------------------------------------------------------------
FORM create_table USING iv_name        TYPE string
                        iv_description TYPE string
                        iv_delivery    TYPE string
                        iv_data_class  TYPE string
                        iv_size        TYPE string
                        iv_exclass     TYPE string.
  CLEAR: gt_object_new, gt_object_old, gs_header.
  PERFORM get_uuid CHANGING gs_header-key_guid.
  gs_header-object_name = iv_name.
  APPEND VALUE #( language = sy-langu description = iv_description ) TO gs_header-object_text.
  PERFORM add_header_detail USING 'TABCLASS' 'TRANSP'.
  PERFORM add_header_detail USING 'CONTFLAG' iv_delivery.
  PERFORM add_header_detail USING 'TABART' iv_data_class.
  PERFORM add_header_detail USING 'TABKAT' iv_size.
  PERFORM add_header_detail USING 'EXCLASS' iv_exclass.
  APPEND gs_header TO gt_object_new.

  DATA lv_position TYPE i.
  DATA lv_value TYPE string.
  LOOP AT gt_fields INTO DATA(ls_field).
    lv_position = lv_position + 1.
    CLEAR gs_field.
    gs_field-object_type = 'TABLE_FIELD'.
    gs_field-object_name = ls_field-fieldname.
    PERFORM get_uuid CHANGING gs_field-key_guid.
    gs_field-parent_key = gs_header-key_guid.
    lv_value = |{ lv_position }|.
    PERFORM add_field_detail USING 'POSITION' lv_value.
    IF ls_field-keyflag = abap_true.
      PERFORM add_field_detail USING 'KEYFLAG' 'X'.
      PERFORM add_field_detail USING 'NOTNULL' 'X'.
    ELSEIF ls_field-notnull = abap_true.
      PERFORM add_field_detail USING 'NOTNULL' 'X'.
    ENDIF.
    IF ls_field-rollname IS NOT INITIAL.
      lv_value = ls_field-rollname.
      PERFORM add_field_detail USING 'ROLLNAME' lv_value.
    ELSE.
      lv_value = ls_field-datatype.
      PERFORM add_field_detail USING 'DATATYPE' lv_value.
      IF ls_field-leng > 0.
        lv_value = |{ ls_field-leng }|.
        PERFORM add_field_detail USING 'LENG' lv_value.
      ENDIF.
      IF ls_field-decimals > 0.
        lv_value = |{ ls_field-decimals }|.
        PERFORM add_field_detail USING 'DECIMALS' lv_value.
      ENDIF.
      lv_value = sy-langu.
      PERFORM add_field_detail USING 'LANGUAGE' lv_value.
    ENDIF.
    APPEND gs_field TO gt_object_new.
  ENDLOOP.

  DATA lv_tabname TYPE tabname.
  DATA lv_existing TYPE tabname.
  lv_tabname = iv_name.
  SELECT SINGLE tabname FROM dd02l INTO @lv_existing WHERE tabname = @lv_tabname AND as4local = 'A'.
  IF sy-subrc = 0.
    WRITE: / 'SKIPPED (already active)', iv_name.
    RETURN.
  ENDIF.

  CLEAR gt_bapireturn.
  CLEAR gt_transport.
  CALL FUNCTION 'GOX_GEN_TABLE_STD'
    EXPORTING
      iv_object_name = CONV char32( iv_name )
      it_object_new  = gt_object_new
      it_object_old  = gt_object_old
      iv_devclass    = c_package
      iv_request_wb  = gv_no_request
    IMPORTING
      et_bapireturn  = gt_bapireturn
      et_transport   = gt_transport.

  DATA lv_failed TYPE abap_bool.
  LOOP AT gt_bapireturn INTO DATA(ls_return) WHERE type CA 'EAX'.
    lv_failed = abap_true.
    DATA lv_msg TYPE string.
    lv_msg = ls_return-message.
    IF lv_msg IS INITIAL.
      MESSAGE ID ls_return-id TYPE 'S' NUMBER ls_return-number
        WITH ls_return-message_v1 ls_return-message_v2
             ls_return-message_v3 ls_return-message_v4
        INTO lv_msg.
    ENDIF.
    WRITE: / 'FAILED ', iv_name, lv_msg.
  ENDLOOP.

  IF lv_failed = abap_false.
    gv_created = gv_created + 1.
    WRITE: / 'CREATED', iv_name, iv_exclass.
  ELSE.
    gv_failed = gv_failed + 1.
  ENDIF.
  COMMIT WORK.
ENDFORM.

FORM get_uuid CHANGING cv_uuid TYPE sysuuid-c.
  TRY.
      cv_uuid = cl_system_uuid=>if_system_uuid_static~create_uuid_c32( ).
    CATCH cx_uuid_error.
      CLEAR cv_uuid.
  ENDTRY.
ENDFORM.

FORM add_header_detail USING iv_name TYPE string iv_value TYPE string.
  DATA ls_detail TYPE coms_gox_table_entry_fields.
  ls_detail-fieldname = iv_name.
  ls_detail-fieldvalue = iv_value.
  APPEND ls_detail TO gs_header-details.
ENDFORM.

FORM add_field_detail USING iv_name TYPE string iv_value TYPE string.
  DATA ls_detail TYPE coms_gox_table_entry_fields.
  ls_detail-fieldname = iv_name.
  ls_detail-fieldvalue = iv_value.
  APPEND ls_detail TO gs_field-details.
ENDFORM.
