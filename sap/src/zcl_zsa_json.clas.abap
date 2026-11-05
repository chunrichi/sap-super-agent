CLASS zcl_zsa_json DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CONSTANTS c_content_type TYPE string VALUE 'application/json; charset=utf-8'.
    CONSTANTS c_iso_utc_zone TYPE string VALUE 'UTC'.

    TYPES ty_acceptance TYPE STANDARD TABLE OF string WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_demand_in,
             demand_id           TYPE string,
             demand_no           TYPE string,
             title               TYPE string,
             description         TYPE string,
             acceptance_criteria TYPE ty_acceptance,
             requester_user_id   TYPE string,
             org_unit            TYPE string,
             priority            TYPE string,
             repo_key            TYPE string,
             project_key         TYPE string,
             template_id         TYPE string,
             version             TYPE i,
             created_at          TYPE string,
             changed_at          TYPE string,
           END OF ty_demand_in.

    TYPES: BEGIN OF ty_artifact_in,
             artifact_id  TYPE string,
             stage_key    TYPE string,
             stage_run_id TYPE string,
             kind         TYPE string,
             version      TYPE i,
             checksum     TYPE string,
             content_ref  TYPE string,
             content_type TYPE string,
             status       TYPE string,
           END OF ty_artifact_in.
    TYPES ty_artifacts_in TYPE STANDARD TABLE OF ty_artifact_in WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_approval_patch,
             gate_key   TYPE string,
             state      TYPE string,
             decided_by TYPE string,
             comment    TYPE string,
             decided_at TYPE string,
           END OF ty_approval_patch.

    TYPES: BEGIN OF ty_demand_patch,
             status      TYPE string,
             status_text TYPE string,
             stage_key   TYPE string,
             artifacts   TYPE ty_artifacts_in,
             approval    TYPE ty_approval_patch,
           END OF ty_demand_patch.

    TYPES: BEGIN OF ty_approval_in,
             gate_key         TYPE string,
             stage_key        TYPE string,
             decision         TYPE string,
             decided_by       TYPE string,
             comment          TYPE string,
             artifact_id      TYPE string,
             artifact_version TYPE i,
           END OF ty_approval_in.

    TYPES: BEGIN OF ty_error,
             code    TYPE string,
             message TYPE string,
           END OF ty_error.

    TYPES: BEGIN OF ty_error_envelope,
             error TYPE ty_error,
           END OF ty_error_envelope.

    CLASS-METHODS serialize
      IMPORTING is_data         TYPE any
      RETURNING VALUE(rv_json) TYPE string.

    CLASS-METHODS deserialize
      IMPORTING iv_json       TYPE string
      CHANGING  cs_data       TYPE any
      RETURNING VALUE(rv_ok) TYPE abap_bool.

    CLASS-METHODS error_body
      IMPORTING iv_code         TYPE string
                iv_message      TYPE string
      RETURNING VALUE(rv_json) TYPE string.

    CLASS-METHODS demand_from_json
      IMPORTING iv_json           TYPE string
      RETURNING VALUE(rs_demand) TYPE ty_demand_in.

    CLASS-METHODS demand_patch_from_json
      IMPORTING iv_json          TYPE string
      RETURNING VALUE(rs_patch) TYPE ty_demand_patch.

    CLASS-METHODS approval_from_json
      IMPORTING iv_json            TYPE string
      RETURNING VALUE(rs_approval) TYPE ty_approval_in.

    CLASS-METHODS demand_to_json
      IMPORTING is_demand           TYPE zsa_demand
                iv_description      TYPE string OPTIONAL
                iv_acceptance       TYPE string OPTIONAL
      RETURNING VALUE(rv_json)    TYPE string.

    CLASS-METHODS timestamp_to_iso
      IMPORTING iv_tstmp       TYPE timestampl
      RETURNING VALUE(rv_iso) TYPE string.

    CLASS-METHODS now_tstmp
      RETURNING VALUE(rv_tstmp) TYPE timestampl.

    CLASS-METHODS escape_json
      IMPORTING iv_value         TYPE string
      RETURNING VALUE(rv_escaped) TYPE string.

    CLASS-METHODS envelope_body
      IMPORTING iv_event_id     TYPE string
                iv_occurred_at  TYPE string
                iv_data_json    TYPE string
      RETURNING VALUE(rv_body) TYPE string.

  PRIVATE SECTION.
    CLASS-METHODS demand_to_dto
      IMPORTING is_demand       TYPE zsa_demand
                iv_description  TYPE string
                iv_acceptance   TYPE string
      RETURNING VALUE(rs_dto) TYPE ty_demand_json.

    TYPES: BEGIN OF ty_demand_json,
             demand_id           TYPE string,
             demand_no           TYPE string,
             title               TYPE string,
             description         TYPE string,
             acceptance_criteria TYPE ty_acceptance,
             requester_user_id   TYPE string,
             org_unit            TYPE string,
             priority            TYPE string,
             repo_key            TYPE string,
             project_key         TYPE string,
             template_id         TYPE string,
             template_version    TYPE i,
             status              TYPE string,
             status_text         TYPE string,
             stage_key           TYPE string,
             version             TYPE i,
             created_at          TYPE string,
             changed_at          TYPE string,
           END OF ty_demand_json.
ENDCLASS.

CLASS zcl_zsa_json IMPLEMENTATION.
  METHOD serialize.
    /ui2/cl_json=>serialize(
      EXPORTING data        = is_data
                pretty_name = /ui2/cl_json=>pretty_mode-camel_case
                compress    = abap_true
      RECEIVING r_json      = rv_json ).
  ENDMETHOD.

  METHOD deserialize.
    TRY.
        /ui2/cl_json=>deserialize(
          EXPORTING json        = iv_json
                    pretty_name = /ui2/cl_json=>pretty_mode-camel_case
          CHANGING  data        = cs_data ).
        rv_ok = abap_true.
      CATCH cx_root.
        CLEAR cs_data.
        rv_ok = abap_false.
    ENDTRY.
  ENDMETHOD.

  METHOD error_body.
    DATA(ls_error) = VALUE ty_error_envelope( error = VALUE ty_error( code = iv_code
                                                                    message = iv_message ) ).
    rv_json = serialize( ls_error ).
  ENDMETHOD.

  METHOD demand_from_json.
    deserialize( EXPORTING iv_json = iv_json CHANGING cs_data = rs_demand ).
  ENDMETHOD.

  METHOD demand_patch_from_json.
    deserialize( EXPORTING iv_json = iv_json CHANGING cs_data = rs_patch ).
  ENDMETHOD.

  METHOD approval_from_json.
    deserialize( EXPORTING iv_json = iv_json CHANGING cs_data = rs_approval ).
  ENDMETHOD.

  METHOD demand_to_dto.
    rs_dto = VALUE ty_demand_json(
      demand_id           = is_demand-demand_id
      demand_no           = is_demand-demand_no
      title               = is_demand-title
      description         = iv_description
      requester_user_id   = is_demand-req_user
      org_unit            = is_demand-org_unit
      priority            = is_demand-priority
      repo_key            = is_demand-repo_key
      project_key         = is_demand-project_key
      template_id         = is_demand-template_id
      template_version    = is_demand-template_version
      status              = is_demand-status
      status_text         = is_demand-status_text
      stage_key           = is_demand-stage_key
      version             = is_demand-version
      created_at          = timestamp_to_iso( is_demand-created_at )
      changed_at          = timestamp_to_iso( is_demand-changed_at ) ).
    IF iv_acceptance IS NOT INITIAL.
      SPLIT iv_acceptance AT cl_abap_char_utilities=>newline INTO TABLE rs_dto-acceptance_criteria.
    ENDIF.
  ENDMETHOD.

  METHOD demand_to_json.
    " Long text/acceptance live in ZSA_DEMAND_T; the handler passes them in when
    " serialising a demand event or a detail response.
    DATA(ls_dto) = demand_to_dto(
      is_demand      = is_demand
      iv_description = COND string( WHEN iv_description IS SUPPLIED THEN iv_description ELSE `` )
      iv_acceptance  = COND string( WHEN iv_acceptance IS SUPPLIED THEN iv_acceptance ELSE `` ) ).
    rv_json = serialize( ls_dto ).
  ENDMETHOD.

  METHOD timestamp_to_iso.
    DATA: lv_date TYPE d,
          lv_time TYPE t.
    CONVERT TIME STAMP iv_tstmp TIME ZONE c_iso_utc_zone INTO DATE lv_date TIME lv_time.
    rv_iso = |{ lv_date+0(4) }-{ lv_date+4(2) }-{ lv_date+6(2) }| &&
             |T{ lv_time+0(2) }:{ lv_time+2(2) }:{ lv_time+4(2) }Z|.
  ENDMETHOD.

  METHOD now_tstmp.
    GET TIME STAMP FIELD rv_tstmp.
  ENDMETHOD.

  METHOD escape_json.
    rv_escaped = iv_value.
    REPLACE ALL OCCURRENCES OF `\` IN rv_escaped WITH `\\`.
    REPLACE ALL OCCURRENCES OF `"` IN rv_escaped WITH `\"`.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf IN rv_escaped WITH `\n`.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>newline IN rv_escaped WITH `\n`.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>horizontal_tab IN rv_escaped WITH `\t`.
  ENDMETHOD.

  METHOD envelope_body.
    rv_body = `{"eventId":"` && escape_json( iv_event_id ) &&
              `","occurredAt":"` && escape_json( iv_occurred_at ) &&
              `","data":` && iv_data_json && `}`.
  ENDMETHOD.
ENDCLASS.
