//! Deterministic role planning; native hosts still own worker execution.
use super::*;

const PLAN_SCHEMA: &str = "gdm-team-plan/v1";
const ALLOCATION_SCHEMA: &str = "gdm-team-allocation/v1";

pub(super) fn inputs(work: &Value) -> Value {
    let c = &work["contract"];
    let checks: Vec<_> = state::checks(work).iter().map(|v| json!({
        "id":v["id"],"desc":v["desc"],"cmd":v["cmd"],"expect":v["expect"],
        "manual":v["manual"],"kind":state::kind(v),"expert":v.get("expert").cloned().unwrap_or(json!(false)),
        "redRequired":v.get("redRequired").cloned().unwrap_or(json!(false))
    })).collect();
    json!({"brief":work["brief"],"checks":checks,"contract":{
        "required":c["required"],"forbidden":c["forbidden"],"assumptions":c["assumptions"],
        "uncertainties":c["uncertainties"],"allowedPaths":c["allowedPaths"],
        "forbiddenPaths":c["forbiddenPaths"],"risk":c["risk"],"stopConditions":c["stopConditions"]
    },"integration":work.get("verificationFeature").is_some() || c.get("integrationVerification").is_some()})
}
fn digest(v: &Value) -> String {
    sha256(protocol::canonical_json(v))
}
fn assignment(v: &Value, module: bool, input: &Value) -> bool {
    let required = if module {
        vec!["id", "paths", "checks", "deliverable", "acceptance"]
    } else {
        vec!["paths", "checks", "deliverable", "acceptance"]
    };
    exact(
        v,
        &required,
        if module {
            &[
                "knowledgeIndependentReason",
                "dependsOn",
                "routeId",
                "createPaths",
            ]
        } else {
            &["routeId", "createPaths", "acceptanceMode"]
        },
    ) && (!module || id_ok(&v["id"]))
        && text_ok(&v["deliverable"], "deliverable", 480)
        && text_ok(&v["acceptance"], "acceptance", 480)
        && strings(&v["paths"], 1, 32, |v| {
            v.as_str()
                .is_some_and(|p| path(p, false).is_ok_and(|n| n == p))
        })
        && strings(
            &v["checks"],
            if v["acceptanceMode"] == "artifact-review" {
                0
            } else {
                1
            },
            64,
            |v| id_ok(v) && array(&input["checks"]).iter().any(|c| c["id"] == *v),
        )
        && v.get("acceptanceMode")
            .is_none_or(|mode| *mode == "artifact-review" && array(&v["checks"]).is_empty())
        && v.get("knowledgeIndependentReason")
            .is_none_or(|v| v.as_str().is_some_and(|v| reason(v).is_ok_and(|n| n == v)))
        && v.get("routeId").is_none_or(id_ok)
        && v.get("createPaths")
            .is_none_or(|p| strings(p, 0, 32, |p| array(&v["paths"]).contains(p)))
        && v.get("dependsOn").is_none_or(|d| strings(d, 0, 16, id_ok))
}
fn assignment_field(v: &Value, module: bool, input: &Value) -> &'static str {
    if !v.is_object() {
        return "shape";
    }
    if module && !id_ok(&v["id"]) {
        return "id";
    }
    for field in ["deliverable", "acceptance"] {
        if !text_ok(&v[field], field, 480) {
            return field;
        }
    }
    if !strings(&v["paths"], 1, 32, |p| {
        p.as_str()
            .is_some_and(|p| path(p, false).is_ok_and(|n| n == p))
    }) {
        return "paths";
    }
    let minimum = if v["acceptanceMode"] == "artifact-review" {
        0
    } else {
        1
    };
    if !strings(&v["checks"], minimum, 64, |id| {
        id_ok(id) && array(&input["checks"]).iter().any(|c| c["id"] == *id)
    }) {
        return "checks";
    }
    if v.get("knowledgeIndependentReason")
        .is_some_and(|r| !r.as_str().is_some_and(|r| reason(r).is_ok_and(|n| n == r)))
    {
        return "knowledgeIndependentReason";
    }
    if v.get("routeId").is_some_and(|r| !id_ok(r)) {
        return "routeId";
    }
    if v.get("createPaths")
        .is_some_and(|paths| !strings(paths, 0, 32, |p| array(&v["paths"]).contains(p)))
    {
        return "createPaths";
    }
    if v.get("dependsOn")
        .is_some_and(|deps| !strings(deps, 0, 16, id_ok))
    {
        return "dependsOn";
    }
    if v.get("acceptanceMode")
        .is_some_and(|m| *m != "artifact-review" || !array(&v["checks"]).is_empty())
    {
        return "acceptanceMode";
    }
    "shape"
}
fn needs_knowledge(spec: &Value, input: &Value) -> bool {
    spec.get("knowledge").is_some()
        || !array(&input["contract"]["uncertainties"]).is_empty()
        || input["integration"] == true
}
fn complex(spec: &Value, input: &Value) -> bool {
    needs_knowledge(spec, input)
        || array(&spec["modules"]).len() > 1
        || ["medium", "high"].contains(&s(&input["contract"], "risk"))
        || spec.get("verification").is_some()
        || spec["independentVerification"] == true
}
pub(super) fn check_spec(spec: &Value, input: &Value) -> Result<()> {
    for key in ["knowledge", "verification"] {
        if let Some(value) = spec.get(key)
            && !assignment(value, false, input)
        {
            return Err(err(
                "team_plan_invalid",
                format!(
                    "Invalid planner field {key}.{}",
                    assignment_field(value, false, input)
                ),
            ));
        }
    }
    if !exact(
        spec,
        &["schemaVersion", "executor", "maxActive", "modules"],
        &["knowledge", "verification", "independentVerification"],
    ) || spec["schemaVersion"] != PLAN_SCHEMA
        || !["native", "unavailable"].contains(&s(spec, "executor"))
        || spec["maxActive"]
            .as_u64()
            .is_none_or(|n| !(1..=MAX_ACTIVE_WORKERS).contains(&n))
        || spec
            .get("independentVerification")
            .is_some_and(|v| !v.is_boolean())
        || spec["modules"]
            .as_array()
            .is_none_or(|v| v.is_empty() || v.len() > 16)
        || spec
            .get("knowledge")
            .is_some_and(|v| !assignment(v, false, input))
        || spec
            .get("verification")
            .is_some_and(|v| !assignment(v, false, input) || v.get("acceptanceMode").is_some())
    {
        return Err(err(
            "team_plan_invalid",
            "Invalid gdm-team-plan/v1 spec; provide bounded paths, existing checks and executor capability",
        ));
    }
    let mut ids = BTreeSet::new();
    for (index, value) in array(&spec["modules"]).iter().enumerate() {
        if !assignment(value, true, input) {
            return Err(err(
                "team_plan_invalid",
                format!(
                    "Invalid planner field modules[{index}].{}",
                    assignment_field(value, true, input)
                ),
            ));
        }
        if !ids.insert(s(value, "id")) || !id_ok(&json!(format!("implement-{}", s(value, "id")))) {
            return Err(err(
                "team_plan_invalid",
                format!(
                    "Invalid planner field modules[{index}].id: duplicate or exceeds generated task ID limit"
                ),
            ));
        }
    }
    let mut earlier = BTreeSet::new();
    for module in array(&spec["modules"]) {
        if array(&module["dependsOn"])
            .iter()
            .any(|id| !earlier.contains(state::s(id)))
        {
            return Err(err(
                "team_plan_invalid",
                "Module dependencies must reference earlier modules; cycles and unknown IDs are forbidden",
            ));
        }
        earlier.insert(s(module, "id"));
    }
    if needs_knowledge(spec, input) && spec.get("knowledge").is_none() {
        return Err(err(
            "team_knowledge_required",
            "Uncertainty or integration work requires a knowledge assignment with source scope and acceptance checks",
        ));
    }
    if complex(spec, input) && spec.get("verification").is_none() {
        return Err(err(
            "team_verification_required",
            "Complex work requires an independent verification assignment",
        ));
    }
    // Each registered check must belong to a role. Otherwise the automatic plan
    // would silently omit part of the coordinator's declared requirement set.
    let covered: BTreeSet<_> = array(&spec["modules"])
        .iter()
        .chain(spec.get("knowledge"))
        .chain(spec.get("verification"))
        .flat_map(|v| array(&v["checks"]).iter().map(state::s))
        .collect();
    if array(&input["checks"])
        .iter()
        .any(|c| !covered.contains(s(c, "id")))
    {
        return Err(err(
            "team_check_unassigned",
            "Every registered check must be assigned to a role",
        ));
    }
    Ok(())
}
fn task(id: &str, role: &str, assignment: &Value, deps: Vec<Value>, access: &str) -> Value {
    let mut task = json!({"id":id,"role":role,"paths":assignment["paths"],"access":access,
        "deliverable":assignment["deliverable"],"acceptance":assignment["acceptance"],"checks":assignment["checks"],
        "dependsOn":deps,"status":"pending","attempts":[]});
    if let Some(route) = assignment.get("routeId") {
        task["routeId"] = route.clone();
    }
    if let Some(mode) = assignment.get("acceptanceMode") {
        task["acceptanceMode"] = mode.clone();
    }
    task
}
fn generate(spec: &Value, input: &Value) -> Vec<Value> {
    if !complex(spec, input) {
        return vec![];
    }
    let knowledge = needs_knowledge(spec, input);
    let mut tasks = vec![];
    if knowledge {
        tasks.push(task(
            "knowledge",
            "knowledge",
            &spec["knowledge"],
            vec![],
            "read",
        ));
    }
    for module in array(&spec["modules"]) {
        let mut deps = if knowledge && module.get("knowledgeIndependentReason").is_none() {
            vec![json!("knowledge")]
        } else {
            vec![]
        };
        deps.extend(
            array(&module["dependsOn"])
                .iter()
                .map(|id| json!(format!("implement-{}", state::s(id)))),
        );
        tasks.push(task(
            &format!("implement-{}", s(module, "id")),
            "implementation",
            module,
            deps,
            "write",
        ));
    }
    let deps = tasks.iter().map(|v| v["id"].clone()).collect();
    tasks.push(task(
        "verify",
        "verification",
        &spec["verification"],
        deps,
        "read",
    ));
    tasks
}
fn definition(task: &Value) -> Value {
    let mut value = task.clone();
    for key in ["attempts", "status", "withdrawal"] {
        value.as_object_mut().unwrap().remove(key);
    }
    value
}
fn history_attempts(work: &Value) -> impl Iterator<Item = &Value> {
    array(&work["team"]["allocationHistory"])
        .iter()
        .flat_map(|h| array(&h["attempts"]))
}
fn validate_history(work: &Value) -> Result<()> {
    let Some(history) = work["team"].get("allocationHistory") else {
        return Ok(());
    };
    if allocation(work).is_none() || history.as_array().is_none_or(|a| a.len() > 16) {
        return Err(corrupt());
    }
    let mut ids = BTreeSet::new();
    for h in array(history) {
        if !exact(h, &["artifact", "reason", "at", "attempts"], &[])
            || !h["reason"]
                .as_str()
                .is_some_and(|v| reason(v).is_ok_and(|n| n == v))
            || !timestamp(&h["at"])
            || !exact(&h["artifact"], &["path", "sha256"], &[])
            || !state::valid_hash(s(&h["artifact"], "sha256"))
            || h["artifact"]["path"]
                != format!(
                    ".gdm/{}/out/team-plan-{}.json",
                    s(work, "slug"),
                    s(&h["artifact"], "sha256")
                )
            || h["attempts"].as_array().is_none_or(|a| a.len() > 4096)
            || array(&h["attempts"]).iter().any(|a| {
                !exact(a, &["id", "assignee", "role"], &[])
                    || !id_ok(&a["id"])
                    || !id_ok(&a["assignee"])
                    || !id_ok(&a["role"])
                    || !ids.insert(s(a, "id"))
            })
        {
            return Err(corrupt());
        }
    }
    if tasks(work)
        .iter()
        .flat_map(|t| array(&t["attempts"]))
        .any(|a| ids.contains(s(a, "id")))
    {
        return Err(corrupt());
    }
    Ok(())
}
pub(super) fn verify_history(cwd: &Path, work: &Value) -> Result<()> {
    super::request::verify(cwd, work)?;
    for h in array(&work["team"]["allocationHistory"]) {
        let bytes = store::contained(
            cwd,
            s(&h["artifact"], "path"),
            "team-plan-history",
            MAX_ARTIFACT,
        )?;
        if sha256(&bytes) != h["artifact"]["sha256"] {
            return Err(err(
                "team_history_changed",
                "An archived allocation changed",
            ));
        }
        let old: Value = serde_json::from_slice(&bytes)
            .map_err(|_| err("team_history_changed", "An archived allocation is not JSON"))?;
        let historical_attempts: Vec<_> = array(&old["team"]["tasks"])
            .iter()
            .flat_map(|t| {
                array(&t["attempts"])
                    .iter()
                    .map(|a| json!({"id":a["id"],"assignee":a["assignee"],"role":t["role"]}))
            })
            .collect();
        if h["attempts"] != json!(historical_attempts)
            || h["reason"] != old["reason"]
            || h["at"] != old["at"]
        {
            return Err(err(
                "team_history_changed",
                "Allocation history receipt does not match archived bytes",
            ));
        }
        for report in array(&old["team"]["tasks"])
            .iter()
            .flat_map(|t| array(&t["attempts"]))
            .filter_map(|a| a.get("report"))
        {
            let recorded = &report["archivedArtifact"];
            if artifact(cwd, s(recorded, "path"))? != *recorded {
                return Err(err(
                    "team_history_changed",
                    "An archived worker report changed",
                ));
            }
        }
    }
    Ok(())
}
fn archive_previous(cwd: &Path, work: &Value, why: &str, dry_run: bool) -> Result<Value> {
    if array(&work["team"]["allocationHistory"]).len() >= 16 {
        return Err(err(
            "team_replan_limit",
            "At most 16 allocation revisions are retained per Work",
        ));
    }
    for report in tasks(work)
        .iter()
        .flat_map(|t| array(&t["attempts"]))
        .filter_map(|a| a.get("report"))
    {
        let archived = &report["archivedArtifact"];
        if artifact(cwd, s(archived, "path"))? != *archived {
            return Err(err(
                "team_history_changed",
                "Cannot preserve a changed worker report archive",
            ));
        }
    }
    let old = json!({"schemaVersion":"gdm-team-plan-history/v1","team":work["team"],"reason":why,"at":event_time(work)});
    let bytes = serde_json::to_vec_pretty(&old)?;
    if bytes.len() > MAX_ARTIFACT {
        return Err(err(
            "team_replan_limit",
            "Previous allocation exceeds the bounded history artifact size",
        ));
    }
    let hash = sha256(&bytes);
    let relative = format!(".gdm/{}/out/team-plan-{hash}.json", s(work, "slug"));
    if !dry_run {
        let directory = store::ensure_work_dir(cwd, s(work, "slug"))?.join("out");
        store::ensure_dir(&directory)?;
        let destination = cwd.join(&relative);
        if store::inspect(&destination, false)? {
            if store::read_regular(&destination, MAX_ARTIFACT as u64)? != bytes {
                return Err(err(
                    "team_history_changed",
                    "Allocation archive filename conflict",
                ));
            }
        } else {
            store::write_atomic(&destination, &bytes)?;
        }
    }
    let attempts: Vec<_> = tasks(work)
        .iter()
        .flat_map(|t| {
            array(&t["attempts"])
                .iter()
                .map(|a| json!({"id":a["id"],"assignee":a["assignee"],"role":t["role"]}))
        })
        .collect();
    Ok(
        json!({"artifact":{"path":relative,"sha256":hash},"reason":why,"at":old["at"],"attempts":attempts}),
    )
}
fn allocation(work: &Value) -> Option<&Value> {
    work["team"].get("allocation")
}

pub(super) fn validate(work: &Value) -> Result<()> {
    validate_history(work)?;
    let Some(a) = allocation(work) else {
        return Ok(());
    };
    if !exact(
        a,
        &[
            "schemaVersion",
            "spec",
            "inputs",
            "specDigest",
            "inputDigest",
        ],
        &["request"],
    ) || a["schemaVersion"] != ALLOCATION_SCHEMA
        || !a["inputs"].is_object()
        || a["specDigest"] != digest(&a["spec"])
        || a["inputDigest"] != digest(&a["inputs"])
        || check_spec(&a["spec"], &a["inputs"]).is_err()
    {
        return Err(corrupt());
    }
    super::request::validate(work)?;
    if a["spec"]["knowledge"].get("acceptanceMode").is_some()
        && a["request"]["input"]["promptVersion"] != 2
    {
        return Err(corrupt());
    }
    let expected = generate(&a["spec"], &a["inputs"]);
    if expected.len() != tasks(work).len()
        || expected
            .iter()
            .zip(tasks(work))
            .any(|(a, b)| definition(a) != definition(b) || b["status"] == "withdrawn")
        || work["team"]["mode"]
            != if complex(&a["spec"], &a["inputs"]) {
                "coordinated"
            } else {
                "single"
            }
        || work["team"]["maxActive"].as_u64().unwrap_or(u64::MAX)
            > a["spec"]["maxActive"].as_u64().unwrap_or(0)
    {
        return Err(corrupt());
    }
    for task in tasks(work).iter().filter(|t| t["role"] == "verification") {
        for attempt in array(&task["attempts"]) {
            independent(work, s(attempt, "assignee"))?;
        }
    }
    Ok(())
}
pub(super) fn blockers(work: &Value) -> Vec<Value> {
    let Some(a) = allocation(work) else {
        return vec![];
    };
    let mut out = vec![];
    if a["inputDigest"] != digest(&inputs(work)) {
        out.push(json!({"code":"team_allocation_stale","message":"Requirements or check definitions changed; regenerate an unstarted plan or explicitly replan after all worker reports are reviewed"}));
    }
    if complex(&a["spec"], &a["inputs"]) && a["spec"]["executor"] == "unavailable" {
        out.push(json!({"code":"team_executor_unavailable","message":"Required native worker executor is unavailable; no worker has been launched by this planner"}));
    }
    out
}
pub(super) fn guard(work: &Value) -> Result<()> {
    if let Some(b) = blockers(work).first() {
        return Err(err(s(b, "code"), s(b, "message")));
    }
    Ok(())
}
pub(super) fn locked(work: &Value) -> Result<()> {
    if allocation(work).is_some() {
        return Err(err(
            "team_allocation_locked",
            "Generated role coverage cannot be edited or withdrawn individually; use team auto, with explicit --replan after historical attempts",
        ));
    }
    Ok(())
}
fn independent(work: &Value, assignee: &str) -> Result<()> {
    if tasks(work)
        .iter()
        .filter(|t| t["role"] == "implementation")
        .flat_map(|t| array(&t["attempts"]))
        .any(|a| s(a, "assignee") == assignee)
        || history_attempts(work)
            .any(|a| a["role"] == "implementation" && s(a, "assignee") == assignee)
    {
        return Err(err(
            "team_verifier_conflict",
            "Verification requires a fresh assignee who has not implemented this Work",
        ));
    }
    Ok(())
}
pub(super) fn claim(
    cwd: &Path,
    work: &Value,
    task: &Value,
    assignee: &str,
    attempt: &str,
) -> Result<()> {
    if allocation(work).is_none() {
        return Ok(());
    }
    guard(work)?;
    verify_history(cwd, work)?;
    if history_attempts(work).any(|a| s(a, "id") == attempt) {
        return Err(err(
            "team_attempt_conflict",
            "Attempt identifiers from earlier allocations remain reserved",
        ));
    }
    if task["role"] == "verification" {
        independent(work, assignee)?;
    }
    Ok(())
}
pub(super) fn projection(work: &Value) -> Value {
    let Some(a) = allocation(work) else {
        return Value::Null;
    };
    let mut projection = json!({"schemaVersion":ALLOCATION_SCHEMA,"strategy":if complex(&a["spec"],&a["inputs"]) {"coordinated"} else {"single"},
        "executor":a["spec"]["executor"],"specDigest":a["specDigest"],"inputDigest":a["inputDigest"],
        "requiredRoles":if complex(&a["spec"],&a["inputs"]) { if needs_knowledge(&a["spec"],&a["inputs"]) {json!(["knowledge","implementation","verification"])} else {json!(["implementation","verification"])} } else {json!([])},
        "automaticExecution":false,"historyCount":array(&work["team"]["allocationHistory"]).len(),"blockers":blockers(work)});
    if let Some(request) = a.get("request") {
        projection["request"] = json!({"inputDigest":request["inputDigest"],"responseDigest":request["responseDigest"],"receipt":request["receipt"],"artifact":request["artifact"]});
    }
    projection
}
pub(super) fn run(cwd: &Path, work: &mut Value, args: &[String]) -> Result<Value> {
    let file = safe_path(cwd, &required_flag(args, "file")?, true)?;
    let bytes = store::contained(cwd, &file, "team-plan", MAX_ARTIFACT)?;
    let spec: Value = serde_json::from_slice(&bytes)
        .map_err(|_| err("team_plan_invalid", "Role plan must be a JSON object"))?;
    protocol::no_credentials(&spec)?;
    apply(cwd, work, args, spec, None)
}
pub(super) fn apply(
    cwd: &Path,
    work: &mut Value,
    args: &[String],
    spec: Value,
    request: Option<Value>,
) -> Result<Value> {
    if spec["knowledge"].get("acceptanceMode").is_some()
        && request
            .as_ref()
            .is_none_or(|r| r["input"]["promptVersion"] != 2)
    {
        return Err(err(
            "team_plan_invalid",
            "Artifact-review knowledge acceptance is reserved for semantic request plans",
        ));
    }
    let input = inputs(work);
    check_spec(&spec, &input)?;
    for a in array(&spec["modules"])
        .iter()
        .chain(spec.get("knowledge"))
        .chain(spec.get("verification"))
    {
        for p in array(&a["paths"]) {
            let p = safe_path(cwd, state::s(p), false)?;
            let c = &work["contract"];
            if !array(&c["allowedPaths"])
                .iter()
                .any(|v| state::s(v) == "." || contract::matches(&p, state::s(v)))
                || array(&c["forbiddenPaths"]).iter().any(|v| {
                    contract::matches(&p, state::s(v)) || contract::matches(state::s(v), &p)
                })
            {
                return Err(err(
                    "team_scope_conflict",
                    "A role path is outside the Work's allowed scope or overlaps forbidden scope",
                ));
            }
        }
    }
    let mut proposed = json!({"schemaVersion":ALLOCATION_SCHEMA,"spec":spec,"inputs":input,"specDigest":digest(&spec),"inputDigest":digest(&input)});
    if let Some(request) = request {
        proposed["request"] = request;
    }
    let is_complex = complex(&spec, &input);
    let generated = generate(&spec, &input);
    let unchanged = allocation(work).is_some_and(|old| *old == proposed);
    let dry_run = args.iter().any(|a| a == "--dry-run");
    let replan = args.iter().any(|a| a == "--replan");
    let why = read_flag(args, "reason")?.map(|v| reason(&v)).transpose()?;
    if replan != why.is_some() {
        return Err(err(
            "usage",
            "--replan and a substantive --reason must be supplied together",
        ));
    }
    verify_history(cwd, work)?;
    let has_attempts = tasks(work)
        .iter()
        .any(|t| !array(&t["attempts"]).is_empty());
    if !unchanged
        && (!tasks(work).is_empty() && allocation(work).is_none()
            || tasks(work)
                .iter()
                .any(|t| ["active", "reported"].contains(&s(t, "status")))
            || has_attempts && !replan)
    {
        return Err(err(
            "team_replan_conflict",
            "Cannot replace manual tasks or active/unreviewed workers; historical attempts require explicit --replan --reason after review",
        ));
    }
    let history = if !unchanged && has_attempts {
        Some(archive_previous(
            cwd,
            work,
            why.as_deref().unwrap(),
            dry_run,
        )?)
    } else {
        None
    };
    if !unchanged {
        let old = work["team"].clone();
        work["team"] = json!({"schemaVersion":SCHEMA,"mode":if is_complex {"coordinated"} else {"single"},
            "maxActive":if is_complex {spec["maxActive"].clone()} else {json!(1)},
            "configuredAt":old.get("configuredAt").cloned().unwrap_or_else(||json!(now())),"tasks":generated,"allocation":proposed});
        if !is_complex {
            work["team"]["reason"] = json!(
                "One low-risk module without unresolved knowledge; coordinator executes registered checks directly"
            );
        }
        if let Some(session) = old.get("sessionId") {
            work["team"]["sessionId"] = session.clone();
        }
        if let Some(prior) = old.get("allocationHistory") {
            work["team"]["allocationHistory"] = prior.clone();
        }
        if let Some(receipt) = history {
            if work["team"].get("allocationHistory").is_none() {
                work["team"]["allocationHistory"] = json!([]);
            }
            work["team"]["allocationHistory"]
                .as_array_mut()
                .unwrap()
                .push(receipt);
        }
        super::validate(work)?;
        if !dry_run {
            persist(
                cwd,
                work,
                "auto",
                json!({"specDigest":proposed["specDigest"],"inputDigest":proposed["inputDigest"]}),
            )?;
        }
    }
    let mut out = super::summary(work);
    out["tasks"] = work["team"]["tasks"].clone();
    out["dryRun"] = json!(dry_run);
    out["unchanged"] = json!(unchanged);
    out["automaticExecution"] = json!(false);
    Ok(out)
}
