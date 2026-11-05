CLASS zcl_zsa_http_handler DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.

    CONSTANTS: c_route_ui              TYPE string VALUE `ui`,
               c_route_health          TYPE string VALUE `health`,
               c_route_demand_list     TYPE string VALUE `demand_list`,
               c_route_demand_create   TYPE string VALUE `demand_create`,
               c_route_demand_detail   TYPE string VALUE `demand_detail`,
               c_route_demand_update   TYPE string VALUE `demand_update`,
               c_route_demand_approval TYPE string VALUE `demand_approval`,
               c_route_unknown         TYPE string VALUE `unknown`.

    " Writeback may only project status and artifact metadata (docs/004 §3.2).
    CONSTANTS c_writeback_fields TYPE string VALUE `STATUS,STATUS_TEXT,STAGE_KEY,ARTIFACTS,APPROVAL`.

    CLASS-METHODS classify_route
      IMPORTING iv_method       TYPE string
                iv_path         TYPE string
      RETURNING VALUE(rv_route) TYPE string.

    CLASS-METHODS is_writeback_field_allowed
      IMPORTING iv_field           TYPE string
      RETURNING VALUE(rv_allowed) TYPE abap_bool.

    " Exposed for ABAP Unit; also used by the ISO<->TIMESTAMPL conversion.
    CLASS-METHODS iso_to_tstmp
      IMPORTING iv_iso          TYPE string
      RETURNING VALUE(rv_tstmp) TYPE timestampl.

  PRIVATE SECTION.
    METHODS path_from_request
      IMPORTING io_request     TYPE REF TO if_http_request
      RETURNING VALUE(rv_path) TYPE string.

    METHODS demand_id_from_path
      IMPORTING iv_path            TYPE string
      RETURNING VALUE(rv_demand_id) TYPE string.

    METHODS query_param
      IMPORTING io_request      TYPE REF TO if_http_request
                iv_name         TYPE string
      RETURNING VALUE(rv_value) TYPE string.

    METHODS respond_json
      IMPORTING io_response TYPE REF TO if_http_response
                iv_status   TYPE i
                iv_body     TYPE string.

    METHODS respond_error
      IMPORTING io_response TYPE REF TO if_http_response
                iv_status   TYPE i
                iv_code     TYPE string
                iv_message  TYPE string.

    METHODS handle_health
      IMPORTING io_response TYPE REF TO if_http_response.

    METHODS handle_demand_list
      IMPORTING io_request  TYPE REF TO if_http_request
                io_response TYPE REF TO if_http_response.

    METHODS handle_demand_detail
      IMPORTING io_response TYPE REF TO if_http_response
                iv_demand_id TYPE string.

    METHODS handle_demand_create
      IMPORTING io_request  TYPE REF TO if_http_request
                io_response TYPE REF TO if_http_response.

    METHODS handle_demand_update
      IMPORTING io_request  TYPE REF TO if_http_request
                io_response TYPE REF TO if_http_response
                iv_demand_id TYPE string.

    METHODS handle_demand_approval
      IMPORTING io_request  TYPE REF TO if_http_request
                io_response TYPE REF TO if_http_response
                iv_demand_id TYPE string.

    METHODS serve_mime
      IMPORTING io_request  TYPE REF TO if_http_request
                io_response TYPE REF TO if_http_response
                iv_path     TYPE string.

    METHODS read_long_text
      IMPORTING iv_demand_id    TYPE string
      EXPORTING ev_description  TYPE string
                ev_acceptance   TYPE string.

    METHODS next_demand_no
      RETURNING VALUE(rv_no) TYPE zsa_demand-demand_no.

    METHODS enqueue_event
      IMPORTING iv_type      TYPE string
                iv_demand_id TYPE string
                iv_payload   TYPE string.

    METHODS artifacts_json
      IMPORTING iv_demand_id     TYPE string
      RETURNING VALUE(rv_json)   TYPE string.

    METHODS approvals_json
      IMPORTING iv_demand_id     TYPE string
      RETURNING VALUE(rv_json)   TYPE string.

    METHODS events_json
      IMPORTING iv_demand_id     TYPE string
      RETURNING VALUE(rv_json)   TYPE string.

    METHODS string_field
      IMPORTING iv_name         TYPE string
                iv_value        TYPE string
      RETURNING VALUE(rv_field) TYPE string.

    METHODS escape_sql_literal
      IMPORTING iv_value           TYPE string
      RETURNING VALUE(rv_escaped) TYPE string.

    METHODS health_json
      RETURNING VALUE(rv_json) TYPE string.
ENDCLASS.

CLASS zcl_zsa_http_handler IMPLEMENTATION.
  METHOD if_http_extension~handle_request.
    DATA(lo_request) = server->request.
    DATA(lo_response) = server->response.
    DATA(lv_method) = lo_request->get_method( ).
    DATA(lv_path) = path_from_request( lo_request ).
    DATA(lv_route) = classify_route( iv_method = lv_method iv_path = lv_path ).
    TRY.
        CASE lv_route.
          WHEN c_route_ui.
            serve_mime( io_request = lo_request io_response = lo_response iv_path = lv_path ).
          WHEN c_route_health.
            handle_health( lo_response ).
          WHEN c_route_demand_list.
            handle_demand_list( io_request = lo_request io_response = lo_response ).
          WHEN c_route_demand_create.
            handle_demand_create( io_request = lo_request io_response = lo_response ).
          WHEN c_route_demand_detail.
            handle_demand_detail( io_response = lo_response
                                  iv_demand_id = demand_id_from_path( lv_path ) ).
          WHEN c_route_demand_update.
            handle_demand_update( io_request = lo_request io_response = lo_response
                                  iv_demand_id = demand_id_from_path( lv_path ) ).
          WHEN c_route_demand_approval.
            handle_demand_approval( io_request = lo_request io_response = lo_response
                                    iv_demand_id = demand_id_from_path( lv_path ) ).
          WHEN OTHERS.
            respond_error( io_response = lo_response iv_status = 404 iv_code = `not_found`
                           iv_message = |unknown route { lv_method } { lv_path }| ).
        ENDCASE.
      CATCH cx_root INTO DATA(lx_error).
        respond_error( io_response = lo_response iv_status = 500 iv_code = `internal_error`
                       iv_message = lx_error->get_text( ) ).
    ENDTRY.
  ENDMETHOD.

  METHOD classify_route.
    DATA lv_path TYPE string.
    lv_path = iv_path.
    IF lv_path IS INITIAL.
      lv_path = `/`.
    ENDIF.
    IF lv_path CP `/ui*`.
      rv_route = c_route_ui.
    ELSEIF lv_path CP `/api/health`.
      rv_route = c_route_health.
    ELSEIF lv_path CP `/api/demands/*/approvals` AND iv_method = `POST`.
      rv_route = c_route_demand_approval.
    ELSEIF lv_path CP `/api/demands/*` AND iv_method = `GET`.
      rv_route = c_route_demand_detail.
    ELSEIF lv_path CP `/api/demands/*` AND iv_method = `PATCH`.
      rv_route = c_route_demand_update.
    ELSEIF lv_path CP `/api/demands`.
      IF iv_method = `POST`.
        rv_route = c_route_demand_create.
      ELSEIF iv_method = `GET`.
        rv_route = c_route_demand_list.
      ELSE.
        rv_route = c_route_unknown.
      ENDIF.
    ELSE.
      rv_route = c_route_unknown.
    ENDIF.
  ENDMETHOD.

  METHOD is_writeback_field_allowed.
    rv_allowed = COND abap_bool(
      WHEN iv_field = `STATUS` OR iv_field = `STATUS_TEXT` OR iv_field = `STAGE_KEY`
        OR iv_field = `ARTIFACTS` OR iv_field = `APPROVAL` THEN abap_true
      ELSE abap_false ).
  ENDMETHOD.

  METHOD iso_to_tstmp.
    IF iv_iso IS INITIAL.
      RETURN.
    ENDIF.
    DATA(lv_date) = substring( val = iv_iso off = 0 len = 4 ) &&
                    substring( val = iv_iso off = 5 len = 2 ) &&
                    substring( val = iv_iso off = 8 len = 2 ).
    DATA(lv_time) = substring( val = iv_iso off = 11 len = 2 ) &&
                    substring( val = iv_iso off = 14 len = 2 ) &&
                    substring( val = iv_iso off = 17 len = 2 ).
    DATA lv_d TYPE d.
    DATA lv_t TYPE t.
    lv_d = lv_date.
    lv_t = lv_time.
    DATA lv_ts TYPE timestamp.
    lv_ts = lv_d && lv_t.
    rv_tstmp = lv_ts.
  ENDMETHOD.

  METHOD path_from_request.
    DATA(lv_uri) = io_request->get_header_field( `~path` ).
    IF lv_uri IS INITIAL.
      lv_uri = io_request->get_header_field( `~request_uri` ).
    ENDIF.
    DATA(lv_query_pos) = find( val = lv_uri sub = `?` ).
    IF lv_query_pos > 0.
      lv_uri = substring( val = lv_uri len = lv_query_pos ).
    ENDIF.
    IF lv_uri CP `/sap/zsa*`.
      lv_uri = substring( val = lv_uri off = 8 ).
    ENDIF.
    IF lv_uri IS INITIAL.
      lv_uri = `/`.
    ENDIF.
    rv_path = lv_uri.
  ENDMETHOD.

  METHOD demand_id_from_path.
    DATA(lv_path) = iv_path.
    IF lv_path CP `/api/demands/*/approvals`.
      lv_path = substring( val = lv_path off = 13 len = strlen( lv_path ) - 23 ).
    ELSE.
      lv_path = substring( val = lv_path off = 13 ).
    ENDIF.
    rv_demand_id = lv_path.
  ENDMETHOD.

  METHOD query_param.
    DATA(lv_query) = io_request->get_header_field( `~query_string` ).
    IF lv_query IS INITIAL.
      RETURN.
    ENDIF.
    SPLIT lv_query AT `&` INTO TABLE DATA(lt_pairs).
    LOOP AT lt_pairs INTO DATA(lv_pair).
      SPLIT lv_pair AT `=` INTO DATA(lv_name) DATA(lv_value).
      IF to_lower( lv_name ) = to_lower( iv_name ).
        rv_value = cl_http_utility=>unescape_url( lv_value ).
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD respond_json.
    io_response->set_status( code = iv_status reason = |{ iv_status }| ).
    io_response->set_content_type( zcl_zsa_json=>c_content_type ).
    io_response->set_cdata( iv_body ).
  ENDMETHOD.

  METHOD respond_error.
    respond_json( io_response = io_response iv_status = iv_status
                  iv_body = zcl_zsa_json=>error_body( iv_code = iv_code iv_message = iv_message ) ).
  ENDMETHOD.

  METHOD health_json.
    rv_json = `{"status":"ok","system":"` && sy-sysid && `","version":"sap-v0.1.0","serverTime":"` &&
              zcl_zsa_json=>timestamp_to_iso( zcl_zsa_json=>now_tstmp( ) ) && `"}`.
  ENDMETHOD.

  METHOD handle_health.
    respond_json( io_response = io_response iv_status = 200 iv_body = health_json( ) ).
  ENDMETHOD.

  METHOD handle_demand_list.
    DATA lt_where TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    DATA(lv_status) = query_param( io_request = io_request iv_name = `status` ).
    IF lv_status IS NOT INITIAL.
      APPEND |status = '{ escape_sql_literal( lv_status ) }'| TO lt_where.
    ENDIF.
    DATA(lv_changed_since) = query_param( io_request = io_request iv_name = `changedSince` ).
    IF lv_changed_since IS NOT INITIAL.
      DATA(lv_tstmp) = iso_to_tstmp( lv_changed_since ).
      APPEND `changed_at > ` && |'{ lv_tstmp }'| TO lt_where.
    ENDIF.
    DATA(lv_q) = query_param( io_request = io_request iv_name = `q` ).
    IF lv_q IS NOT INITIAL.
      APPEND |title LIKE '%{ escape_sql_literal( lv_q ) }%'| TO lt_where.
    ENDIF.

    DATA lt_demands TYPE STANDARD TABLE OF zsa_demand WITH DEFAULT KEY.
    IF lt_where IS INITIAL.
      SELECT * FROM zsa_demand INTO TABLE @lt_demands ORDER BY created_at DESCENDING.
    ELSE.
      SELECT * FROM zsa_demand INTO TABLE @lt_demands
        WHERE (lt_where) ORDER BY created_at DESCENDING.
    ENDIF.

    DATA(lv_json) = `[`.
    DATA(lv_first) = abap_true.
    LOOP AT lt_demands INTO DATA(ls_demand).
      IF lv_first = abap_false.
        lv_json = lv_json && `,`.
      ENDIF.
      lv_first = abap_false.
      lv_json = lv_json && zcl_zsa_json=>demand_to_json( ls_demand ).
    ENDLOOP.
    lv_json = lv_json && `]`.
    respond_json( io_response = io_response iv_status = 200
                  iv_body = `{"demands":` && lv_json && `,"serverTime":"` &&
                            zcl_zsa_json=>timestamp_to_iso( zcl_zsa_json=>now_tstmp( ) ) && `"}` ).
  ENDMETHOD.

  METHOD handle_demand_detail.
    SELECT SINGLE * FROM zsa_demand INTO @DATA(ls_demand) WHERE demand_id = @iv_demand_id.
    IF sy-subrc <> 0.
      respond_error( io_response = io_response iv_status = 404 iv_code = `not_found`
                     iv_message = |demand { iv_demand_id } not found| ).
      RETURN.
    ENDIF.
    read_long_text( EXPORTING iv_demand_id = iv_demand_id
                    IMPORTING ev_description = DATA(lv_description)
                              ev_acceptance = DATA(lv_acceptance) ).
    DATA(lv_body) = `{"demand":` &&
      zcl_zsa_json=>demand_to_json( is_demand = ls_demand
                                    iv_description = lv_description
                                    iv_acceptance = lv_acceptance ) &&
      `,"artifacts":` && artifacts_json( iv_demand_id ) &&
      `,"approvals":` && approvals_json( iv_demand_id ) &&
      `,"events":` && events_json( iv_demand_id ) &&
      `,"serverTime":"` && zcl_zsa_json=>timestamp_to_iso( zcl_zsa_json=>now_tstmp( ) ) && `"}`.
    respond_json( io_response = io_response iv_status = 200 iv_body = lv_body ).
  ENDMETHOD.

  METHOD handle_demand_create.
    DATA(ls_in) = zcl_zsa_json=>demand_from_json( io_request->get_cdata( ) ).
    IF ls_in-title IS INITIAL.
      respond_error( io_response = io_response iv_status = 400 iv_code = `validation`
                     iv_message = `title is required` ).
      RETURN.
    ENDIF.
    DATA(lv_now) = zcl_zsa_json=>now_tstmp( ).
    DATA ls_demand TYPE zsa_demand.
    ls_demand = VALUE zsa_demand(
      client           = sy-mandt
      demand_id        = cl_system_uuid=>create_uuid_c32_static( )
      demand_no        = next_demand_no( )
      title            = ls_in-title
      req_user         = COND char12( WHEN ls_in-requester_user_id IS INITIAL THEN sy-uname
                                      ELSE ls_in-requester_user_id )
      org_unit         = ls_in-org_unit
      priority         = COND char10( WHEN ls_in-priority IS INITIAL THEN `normal`
                                      ELSE ls_in-priority )
      template_id      = COND char40( WHEN ls_in-template_id IS INITIAL THEN `default`
                                      ELSE ls_in-template_id )
      template_version = `0001`
      repo_key         = ls_in-repo_key
      project_key      = ls_in-project_key
      status           = `待分析`
      status_text      = `待分析`
      version          = 1
      created_at       = lv_now
      changed_at       = lv_now ).
    INSERT zsa_demand FROM ls_demand.
    IF sy-subrc <> 0.
      respond_error( io_response = io_response iv_status = 500 iv_code = `internal_error`
                     iv_message = `could not persist demand` ).
      RETURN.
    ENDIF.
    DATA(lv_acceptance) = concat_lines_of( table = ls_in-acceptance_criteria
                                           sep   = cl_abap_char_utilities=>newline ).
    INSERT zsa_demand_t FROM VALUE zsa_demand_t(
      client      = sy-mandt
      demand_id   = ls_demand-demand_id
      lang        = sy-langu
      description = ls_in-description
      acceptance  = lv_acceptance ).
    enqueue_event(
      iv_type      = `demand.submitted`
      iv_demand_id = ls_demand-demand_id
      iv_payload   = `{"type":"demand.submitted","demand":` &&
                     zcl_zsa_json=>demand_to_json( is_demand = ls_demand
                                                   iv_description = ls_in-description
                                                   iv_acceptance = lv_acceptance ) && `}` ).
    COMMIT WORK AND WAIT.
    respond_json( io_response = io_response iv_status = 201
                  iv_body = `{"demand":` &&
                    zcl_zsa_json=>demand_to_json( is_demand = ls_demand
                                                  iv_description = ls_in-description
                                                  iv_acceptance = lv_acceptance ) &&
                    `,"serverTime":"` && zcl_zsa_json=>timestamp_to_iso( lv_now ) && `"}` ).
  ENDMETHOD.

  METHOD handle_demand_update.
    SELECT SINGLE * FROM zsa_demand INTO @DATA(ls_demand) WHERE demand_id = @iv_demand_id.
    IF sy-subrc <> 0.
      respond_error( io_response = io_response iv_status = 404 iv_code = `not_found`
                     iv_message = |demand { iv_demand_id } not found| ).
      RETURN.
    ENDIF.
    DATA(lv_if_match) = io_request->get_header_field( `If-Match` ).
    REPLACE ALL OCCURRENCES OF `"` IN lv_if_match WITH ``.
    REPLACE ALL OCCURRENCES OF `W/` IN lv_if_match WITH ``.
    IF lv_if_match IS INITIAL.
      respond_error( io_response = io_response iv_status = 428 iv_code = `precondition_required`
                     iv_message = `PATCH requires an If-Match version` ).
      RETURN.
    ENDIF.
    IF lv_if_match <> CONV string( ls_demand-version ).
      DATA(lv_conflict) = `{"error":{"code":"conflict","message":"version mismatch"},` &&
                          `"currentVersion":` && CONV string( ls_demand-version ) && `,` &&
                          `"demand":` && zcl_zsa_json=>demand_to_json( ls_demand ) && `}`.
      respond_json( io_response = io_response iv_status = 409 iv_body = lv_conflict ).
      RETURN.
    ENDIF.

    DATA(ls_patch) = zcl_zsa_json=>demand_patch_from_json( io_request->get_cdata( ) ).
    IF ls_patch-status IS NOT INITIAL.
      ls_demand-status = ls_patch-status.
    ENDIF.
    IF ls_patch-status_text IS NOT INITIAL.
      ls_demand-status_text = ls_patch-status_text.
    ENDIF.
    IF ls_patch-stage_key IS NOT INITIAL.
      ls_demand-stage_key = ls_patch-stage_key.
    ENDIF.
    ls_demand-version = ls_demand-version + 1.
    ls_demand-changed_at = zcl_zsa_json=>now_tstmp( ).
    UPDATE zsa_demand FROM ls_demand.

    LOOP AT ls_patch-artifacts INTO DATA(ls_artifact).
      MODIFY zsa_artifact FROM VALUE zsa_artifact(
        client       = sy-mandt
        artifact_id  = ls_artifact-artifact_id
        demand_id    = iv_demand_id
        stage_key    = ls_artifact-stage_key
        stage_run_id = ls_artifact-stage_run_id
        kind         = COND char30( WHEN ls_artifact-kind IS INITIAL THEN `requirement_analysis`
                                    ELSE ls_artifact-kind )
        version      = COND i( WHEN ls_artifact-version IS INITIAL THEN 1 ELSE ls_artifact-version )
        checksum     = ls_artifact-checksum
        content_ref  = ls_artifact-content_ref
        content_type = COND char128( WHEN ls_artifact-content_type IS INITIAL THEN `application/json`
                                     ELSE ls_artifact-content_type )
        status       = COND char20( WHEN ls_artifact-status IS INITIAL THEN `generated`
                                    ELSE ls_artifact-status )
        author_type  = `ai`
        author_id    = `server-ai`
        created_at   = zcl_zsa_json=>now_tstmp( ) ).
    ENDLOOP.

    IF ls_patch-approval-state IS NOT INITIAL.
      MODIFY zsa_approval FROM VALUE zsa_approval(
        client        = sy-mandt
        approval_id   = cl_system_uuid=>create_uuid_c32_static( )
        demand_id     = iv_demand_id
        stage_key     = ls_demand-stage_key
        gate_key      = COND char30( WHEN ls_patch-approval-gate_key IS INITIAL THEN `GATE`
                                     ELSE ls_patch-approval-gate_key )
        state         = ls_patch-approval-state
        decided_by    = ls_patch-approval-decided_by
        decided_at    = zcl_zsa_json=>now_tstmp( )
        comment       = ls_patch-approval-comment ).
    ENDIF.
    COMMIT WORK AND WAIT.
    respond_json( io_response = io_response iv_status = 200
                  iv_body = `{"demand":` && zcl_zsa_json=>demand_to_json( ls_demand ) &&
                            `,"version":` && CONV string( ls_demand-version ) &&
                            `,"serverTime":"` &&
                            zcl_zsa_json=>timestamp_to_iso( zcl_zsa_json=>now_tstmp( ) ) && `"}` ).
  ENDMETHOD.

  METHOD handle_demand_approval.
    SELECT SINGLE * FROM zsa_demand INTO @DATA(ls_demand) WHERE demand_id = @iv_demand_id.
    IF sy-subrc <> 0.
      respond_error( io_response = io_response iv_status = 404 iv_code = `not_found`
                     iv_message = |demand { iv_demand_id } not found| ).
      RETURN.
    ENDIF.
    DATA(ls_in) = zcl_zsa_json=>approval_from_json( io_request->get_cdata( ) ).
    IF ls_in-gate_key IS INITIAL OR ls_in-decided_by IS INITIAL
       OR ( ls_in-decision <> `approve` AND ls_in-decision <> `reject` ).
      respond_error( io_response = io_response iv_status = 400 iv_code = `validation`
                     iv_message = `gateKey, decision (approve|reject) and decidedBy are required` ).
      RETURN.
    ENDIF.
    DATA(lv_now) = zcl_zsa_json=>now_tstmp( ).
    DATA(lv_state) = COND char20( WHEN ls_in-decision = `approve` THEN `approved` ELSE `rejected` ).
    DATA(lv_approval_id) = cl_system_uuid=>create_uuid_c32_static( ).
    INSERT zsa_approval FROM VALUE zsa_approval(
      client      = sy-mandt
      approval_id = lv_approval_id
      demand_id   = iv_demand_id
      stage_key   = COND char30( WHEN ls_in-stage_key IS INITIAL THEN ls_demand-stage_key
                                 ELSE ls_in-stage_key )
      gate_key    = ls_in-gate_key
      state       = lv_state
      required_role = `consultant`
      decided_by  = ls_in-decided_by
      decided_at  = lv_now
      comment     = ls_in-comment ).
    ls_demand-version = ls_demand-version + 1.
    ls_demand-changed_at = lv_now.
    UPDATE zsa_demand FROM ls_demand.

    DATA(lv_type) = COND string( WHEN lv_state = `approved` THEN `artifact.approved`
                                  ELSE `artifact.rejected` ).
    DATA(lv_payload) = `{"type":"` && lv_type && `"` &&
      string_field( iv_name = `demandId` iv_value = iv_demand_id ) &&
      string_field( iv_name = `gateKey` iv_value = ls_in-gate_key ) &&
      string_field( iv_name = `stageKey` iv_value = ls_in-stage_key ) &&
      string_field( iv_name = `artifactId` iv_value = ls_in-artifact_id ) &&
      string_field( iv_name = `decidedBy` iv_value = ls_in-decided_by ) &&
      string_field( iv_name = `comment` iv_value = ls_in-comment ) &&
      string_field( iv_name = `decidedAt` iv_value = zcl_zsa_json=>timestamp_to_iso( lv_now ) ) &&
      `,"sapVersion":` && CONV string( ls_demand-version ) && `}`.
    enqueue_event( iv_type = lv_type iv_demand_id = iv_demand_id iv_payload = lv_payload ).
    COMMIT WORK AND WAIT.

    DATA(lv_approval_json) = `{"approvalId":"` && lv_approval_id && `","demandId":"` && iv_demand_id &&
      `","gateKey":"` && zcl_zsa_json=>escape_json( ls_in-gate_key ) &&
      `","state":"` && lv_state && `"}`.
    respond_json( io_response = io_response iv_status = 201
                  iv_body = `{"approval":` && lv_approval_json && `,"demand":` &&
                            zcl_zsa_json=>demand_to_json( ls_demand ) &&
                            `,"serverTime":"` && zcl_zsa_json=>timestamp_to_iso( lv_now ) && `"}` ).
  ENDMETHOD.

  METHOD serve_mime.
    DATA(lv_file) = iv_path.
    IF lv_file CP `/ui*`.
      lv_file = substring( val = lv_file off = 3 ).
    ENDIF.
    IF lv_file IS INITIAL OR lv_file = `/`.
      lv_file = `/index.html`.
    ENDIF.
    DATA(lv_url) = `/zsa/ui` && lv_file.
    DATA lo_mime TYPE REF TO cl_mime_repository_api.
    DATA lv_content TYPE xstring.
    DATA lv_mime TYPE string.
    CREATE OBJECT lo_mime.
    lo_mime->get(
      EXPORTING i_url        = lv_url
      IMPORTING e_content    = lv_content
                e_mime_type  = lv_mime
      EXCEPTIONS not_found   = 1
                 OTHERS      = 2 ).
    IF sy-subrc <> 0.
      " Handlers fall back to index.html for SPA routes (docs/004 §4).
      lv_url = `/zsa/ui/index.html`.
      lo_mime->get(
        EXPORTING i_url       = lv_url
        IMPORTING e_content   = lv_content
                  e_mime_type = lv_mime
        EXCEPTIONS not_found  = 1
                   OTHERS     = 2 ).
    ENDIF.
    IF sy-subrc <> 0.
      respond_error( io_response = io_response iv_status = 404 iv_code = `not_found`
                     iv_message = |MIME resource { iv_path } not found| ).
      RETURN.
    ENDIF.
    io_response->set_status( code = 200 reason = `OK` ).
    io_response->set_content_type( lv_mime ).
    io_response->set_data( lv_content ).
  ENDMETHOD.

  METHOD read_long_text.
    SELECT SINGLE description acceptance FROM zsa_demand_t
      INTO (@ev_description, @ev_acceptance)
      WHERE demand_id = @iv_demand_id AND lang = @sy-langu.
    IF sy-subrc <> 0.
      SELECT SINGLE description acceptance FROM zsa_demand_t
        INTO (@ev_description, @ev_acceptance)
        WHERE demand_id = @iv_demand_id.
    ENDIF.
  ENDMETHOD.

  METHOD next_demand_no.
    CONSTANTS c_key TYPE zsa_cfg-cfg_key VALUE `DEMAND_SEQ`.
    SELECT SINGLE cfg_value FROM zsa_cfg INTO @DATA(lv_value) WHERE cfg_key = @c_key.
    DATA lv_seq TYPE i.
    IF lv_value IS INITIAL.
      lv_seq = 2001.
    ELSE.
      lv_seq = CONV i( lv_value ) + 1.
    ENDIF.
    MODIFY zsa_cfg FROM VALUE zsa_cfg( client = sy-mandt cfg_key = c_key
                                       cfg_value = CONV string( lv_seq )
                                       changed_at = zcl_zsa_json=>now_tstmp( ) ).
    rv_no = `R-` && lv_seq.
  ENDMETHOD.

  METHOD enqueue_event.
    DATA lv_now TYPE timestampl.
    lv_now = zcl_zsa_json=>now_tstmp( ).
    INSERT zsa_event_out FROM VALUE zsa_event_out(
      client     = sy-mandt
      event_id   = cl_system_uuid=>create_uuid_c32_static( )
      type       = iv_type
      demand_id  = iv_demand_id
      payload    = iv_payload
      state      = zcl_zsa_event_push=>c_state_new
      attempts   = 0
      next_at    = lv_now
      created_at = lv_now
      changed_at = lv_now ).
  ENDMETHOD.

  METHOD artifacts_json.
    DATA lt_artifacts TYPE STANDARD TABLE OF zsa_artifact WITH DEFAULT KEY.
    SELECT * FROM zsa_artifact INTO TABLE @lt_artifacts
      WHERE demand_id = @iv_demand_id ORDER BY created_at.
    rv_json = `[`.
    LOOP AT lt_artifacts INTO DATA(ls_artifact).
      IF sy-tabix > 1.
        rv_json = rv_json && `,`.
      ENDIF.
      rv_json = rv_json &&
        `{"artifactId":"` && zcl_zsa_json=>escape_json( ls_artifact-artifact_id ) &&
        `","stageKey":"` && zcl_zsa_json=>escape_json( ls_artifact-stage_key ) &&
        `","stageRunId":"` && zcl_zsa_json=>escape_json( ls_artifact-stage_run_id ) &&
        `","kind":"` && zcl_zsa_json=>escape_json( ls_artifact-kind ) &&
        `","version":` && CONV string( ls_artifact-version ) &&
        `,"checksum":"` && zcl_zsa_json=>escape_json( ls_artifact-checksum ) &&
        `","contentRef":"` && zcl_zsa_json=>escape_json( ls_artifact-content_ref ) &&
        `","contentType":"` && zcl_zsa_json=>escape_json( ls_artifact-content_type ) &&
        `","status":"` && zcl_zsa_json=>escape_json( ls_artifact-status ) &&
        `","createdAt":"` && zcl_zsa_json=>timestamp_to_iso( ls_artifact-created_at ) && `"}`.
    ENDLOOP.
    rv_json = rv_json && `]`.
  ENDMETHOD.

  METHOD approvals_json.
    DATA lt_approvals TYPE STANDARD TABLE OF zsa_approval WITH DEFAULT KEY.
    SELECT * FROM zsa_approval INTO TABLE @lt_approvals WHERE demand_id = @iv_demand_id.
    rv_json = `[`.
    LOOP AT lt_approvals INTO DATA(ls_approval).
      IF sy-tabix > 1.
        rv_json = rv_json && `,`.
      ENDIF.
      rv_json = rv_json &&
        `{"approvalId":"` && zcl_zsa_json=>escape_json( ls_approval-approval_id ) &&
        `","demandId":"` && zcl_zsa_json=>escape_json( ls_approval-demand_id ) &&
        `","stageKey":"` && zcl_zsa_json=>escape_json( ls_approval-stage_key ) &&
        `","gateKey":"` && zcl_zsa_json=>escape_json( ls_approval-gate_key ) &&
        `","state":"` && zcl_zsa_json=>escape_json( ls_approval-state ) &&
        `","decidedBy":"` && zcl_zsa_json=>escape_json( ls_approval-decided_by ) &&
        `","comment":"` && zcl_zsa_json=>escape_json( ls_approval-comment ) && `"}`.
    ENDLOOP.
    rv_json = rv_json && `]`.
  ENDMETHOD.

  METHOD events_json.
    DATA lt_events TYPE STANDARD TABLE OF zsa_event_out WITH DEFAULT KEY.
    SELECT * FROM zsa_event_out INTO TABLE @lt_events
      WHERE demand_id = @iv_demand_id ORDER BY created_at.
    rv_json = `[`.
    LOOP AT lt_events INTO DATA(ls_event).
      IF sy-tabix > 1.
        rv_json = rv_json && `,`.
      ENDIF.
      rv_json = rv_json &&
        `{"eventId":"` && zcl_zsa_json=>escape_json( ls_event-event_id ) &&
        `","type":"` && zcl_zsa_json=>escape_json( ls_event-type ) &&
        `","state":"` && zcl_zsa_json=>escape_json( ls_event-state ) &&
        `","createdAt":"` && zcl_zsa_json=>timestamp_to_iso( ls_event-created_at ) && `"}`.
    ENDLOOP.
    rv_json = rv_json && `]`.
  ENDMETHOD.

  METHOD string_field.
    IF iv_value IS INITIAL.
      RETURN.
    ENDIF.
    rv_field = `,"` && iv_name && `":"` && zcl_zsa_json=>escape_json( iv_value ) && `"`.
  ENDMETHOD.

  METHOD escape_sql_literal.
    rv_escaped = iv_value.
    REPLACE ALL OCCURRENCES OF `'` IN rv_escaped WITH `''`.
    REPLACE ALL OCCURRENCES OF `%` IN rv_escaped WITH `\%`.
    REPLACE ALL OCCURRENCES OF `_` IN rv_escaped WITH `\_`.
  ENDMETHOD.
ENDCLASS.
