use super::{
    scan,
    schema::{self, err},
};
use crate::support::{Result, sha256};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
pub const EXT: [&str; 4] = [".ts", ".tsx", ".js", ".jsx"];
const FILE_CAP: usize = 512 * 1024;
const READ_CAP: usize = 8 * 1024 * 1024;
pub fn supported(path: &str) -> bool {
    EXT.iter().any(|e| path.ends_with(e))
}
pub fn safe_file(root: &Path, path: &str) -> Result<fs::Metadata> {
    schema::canonical(path, "path", usize::MAX)?;
    let mut current = root.to_path_buf();
    let parts = path.split('/').collect::<Vec<_>>();
    for (i, p) in parts.iter().enumerate() {
        current.push(p);
        let stat =
            fs::symlink_metadata(&current).map_err(|_| err(format!("{path} does not exist")))?;
        if stat.is_symlink() {
            return Err(err(format!("{path} crosses a symbolic link")));
        }
        if i + 1 < parts.len() && !stat.is_dir() {
            return Err(err(format!("{path} crosses a non-directory component")));
        }
        if i + 1 == parts.len() && !stat.is_file() {
            return Err(err(format!("{path} is not a regular file")));
        }
    }
    Ok(fs::symlink_metadata(current)?)
}
pub fn git(root: &Path, args: &[&str]) -> Result<String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| err("unable to inspect Git repository"))?;
    let mut out = Vec::new();
    let read = child
        .stdout
        .take()
        .unwrap()
        .take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut out);
    if read.is_err() || out.len() > 32 * 1024 * 1024 {
        let _ = child.kill();
        let _ = child.wait();
        return Err(err("unable to inspect Git repository"));
    }
    let status = child.wait()?;
    if !status.success() {
        return Err(err("unable to inspect Git repository"));
    }
    String::from_utf8(out).map_err(|_| err("unable to inspect Git repository"))
}
pub fn validate_root(root: &Path) -> Result<PathBuf> {
    let actual = fs::canonicalize(root).map_err(|_| err("root does not exist"))?;
    let stat = fs::symlink_metadata(root)?;
    if !stat.is_dir() || stat.is_symlink() || actual.as_os_str() != root.as_os_str() {
        return Err(err("root must be a real, non-symlink directory"));
    }
    let top = git(&actual, &["rev-parse", "--show-toplevel"])?;
    if fs::canonicalize(top.trim()).ok().as_ref() != Some(&actual) {
        return Err(err("root must equal the Git top-level directory"));
    }
    Ok(actual)
}
pub fn candidate_paths(root: &Path) -> Result<Vec<String>> {
    let mut paths = git(
        root,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )?
    .split('\0')
    .filter(|s| !s.is_empty())
    .map(str::to_owned)
    .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}
pub fn relative_base(from: &str, spec: &str) -> Option<String> {
    if spec.contains(['\\', '\0']) || spec.starts_with('/') {
        return None;
    }
    let mut parts = from.split('/').map(str::to_owned).collect::<Vec<_>>();
    parts.pop();
    for p in spec.split('/') {
        match p {
            "." | "" => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(p.into()),
        }
    }
    Some(parts.join("/"))
}
pub fn resolution(from: &str, spec: &str) -> Vec<String> {
    let Some(base) = relative_base(from, spec) else {
        return vec![];
    };
    let ext = Path::new(&base)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    match ext {
        "" => EXT
            .iter()
            .map(|e| format!("{base}{e}"))
            .chain(EXT.iter().map(|e| format!("{base}/index{e}")))
            .collect(),
        "js" => vec![
            base.clone(),
            format!("{}.ts", &base[..base.len() - 3]),
            format!("{}.tsx", &base[..base.len() - 3]),
            format!("{}.jsx", &base[..base.len() - 3]),
        ],
        "jsx" => vec![base.clone(), format!("{}.tsx", &base[..base.len() - 4])],
        _ => vec![base],
    }
}
pub fn relative(s: &str) -> bool {
    s.starts_with("./") || s.starts_with("../")
}
fn alias(s: &str) -> bool {
    s.starts_with("@/") || s.starts_with("~/") || s.starts_with('#')
}
#[derive(Clone, Eq, PartialEq, Ord, PartialOrd)]
struct Edge {
    from: String,
    to: String,
}
struct Context {
    root: PathBuf,
    candidates: BTreeSet<String>,
    limitations: BTreeSet<String>,
    incomplete: BTreeSet<String>,
    unresolved: BTreeMap<(String, String, String), Value>,
    sources: BTreeMap<String, String>,
    hashes: BTreeMap<String, String>,
    read: usize,
    reserved: usize,
    truncated: bool,
    exhausted: bool,
}
impl Context {
    fn new(root: PathBuf, candidates: BTreeSet<String>) -> Self {
        Self{root,candidates,limitations:["module-dependency-graph-only:no-symbol-or-call-analysis","static-relative-imports-only:dynamic-import-require-bare-package-and-tsconfig-alias-unsupported","bare-package-imports-outside-relative-graph","lexical-scan-only:no-tsconfig-or-package-resolution"].map(str::to_owned).into(),incomplete:BTreeSet::new(),unresolved:BTreeMap::new(),sources:BTreeMap::new(),hashes:BTreeMap::new(),read:0,reserved:0,truncated:false,exhausted:false}
    }
    fn truncated(&mut self, s: impl Into<String>) {
        let s = s.into();
        self.truncated = true;
        self.limitations.insert(s.clone());
        self.incomplete.insert(s);
    }
    fn unresolved(&mut self, from: &str, spec: Option<&str>, reason: &str) {
        let key = (from.into(), spec.unwrap_or("").into(), reason.into());
        if self.unresolved.contains_key(&key) {
            return;
        }
        if self.unresolved.len() >= 512 {
            self.truncated("unresolved-cap-reached:512");
            return;
        }
        let value = if let Some(spec) = spec {
            json!({"from":from,"specifier":spec,"reason":reason})
        } else {
            json!({"from":from,"reason":reason})
        };
        self.unresolved.insert(key, value);
    }
    fn read(&mut self, path: &str) -> Option<String> {
        if let Some(s) = self.sources.get(path) {
            return Some(s.clone());
        }
        let stat = match safe_file(&self.root, path) {
            Ok(s) => s,
            Err(_) => {
                self.unresolved(path, None, "unsafe-or-missing-file");
                self.limitations
                    .insert("unsafe-or-missing-candidate-skipped".into());
                self.incomplete.insert("unsafe-or-missing-file".into());
                return None;
            }
        };
        let size = stat.len() as usize;
        if size > FILE_CAP {
            self.truncated(format!("file-size-cap-reached:{FILE_CAP}"));
            self.unresolved(path, None, "file-too-large");
            return None;
        }
        if self.read + self.reserved + size * 2 > READ_CAP {
            self.exhausted = true;
            self.truncated(format!("total-read-byte-cap-reached:{READ_CAP}"));
            self.unresolved(path, None, "total-read-budget-exhausted");
            return None;
        }
        let bytes = match bounded_read(&self.root, path, FILE_CAP) {
            Ok(b) => b,
            Err(_) => {
                self.unresolved(path, None, "file-disappeared-during-read");
                self.limitations
                    .insert("file-disappeared-during-query".into());
                self.incomplete
                    .insert("file-disappeared-during-read".into());
                return None;
            }
        };
        if bytes.len() > FILE_CAP || self.read + self.reserved + bytes.len() * 2 > READ_CAP {
            self.exhausted = true;
            self.truncated(format!("total-read-byte-cap-reached:{READ_CAP}"));
            self.unresolved(path, None, "read-budget-race");
            return None;
        }
        self.read += bytes.len();
        self.reserved += bytes.len();
        self.hashes.insert(path.into(), sha256(&bytes));
        let source = match String::from_utf8(bytes) {
            Ok(s) => s,
            Err(_) => {
                self.unresolved(path, None, "invalid-utf8");
                self.limitations
                    .insert("invalid-utf8-source-skipped".into());
                self.incomplete.insert("invalid-utf8".into());
                return None;
            }
        };
        self.sources.insert(path.into(), source.clone());
        Some(source)
    }
    fn resolve(&mut self, from: &str, spec: &str) -> Option<String> {
        if !relative(spec) {
            if alias(spec) {
                self.unresolved(from, Some(spec), "path-alias-unsupported");
                self.limitations.insert("path-alias-unsupported".into());
            }
            return None;
        }
        if spec.contains(['\\', '\0']) {
            self.unresolved(from, Some(spec), "unsafe-relative-specifier");
            return None;
        }
        let options = resolution(from, spec);
        if options.is_empty() {
            self.unresolved(from, Some(spec), "relative-specifier-outside-root");
            return None;
        }
        for c in options {
            if !self.candidates.contains(&c) {
                continue;
            }
            if safe_file(&self.root, &c).is_ok() {
                return Some(c);
            }
            self.unresolved(from, Some(spec), "relative-target-unsafe");
            self.limitations
                .insert("symlink-or-nonregular-import-target-skipped".into());
            self.incomplete.insert("relative-target-unsafe".into());
            return None;
        }
        let base = relative_base(from, spec).unwrap_or_default();
        let ext = Path::new(&base)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let why = if !ext.is_empty() && !EXT.contains(&format!(".{ext}").as_str()) {
            "relative-target-extension-unsupported"
        } else {
            "relative-target-unresolved-or-outside-candidate-cap"
        };
        self.unresolved(from, Some(spec), why);
        self.limitations.insert(why.into());
        if why == "relative-target-unresolved-or-outside-candidate-cap" {
            self.incomplete.insert(why.into());
        }
        None
    }
    fn runtime(&mut self, path: &str, spec: Option<&str>, why: &str) {
        self.limitations.insert(why.into());
        if spec.is_none_or(relative) {
            self.unresolved(path, spec, why);
        } else if spec.is_some_and(alias) {
            self.unresolved(path, spec, "path-alias-unsupported");
            self.limitations.insert("path-alias-unsupported".into());
        }
    }
    fn scan(&mut self, path: &str) -> Vec<Edge> {
        if !supported(path) {
            self.unresolved(path, None, "entry-or-candidate-extension-unsupported");
            self.limitations
                .insert("supported-extensions-only:ts-tsx-js-jsx".into());
            return vec![];
        }
        let Some(source) = self.read(path) else {
            return vec![];
        };
        let parsed = scan::parse(&source, path);
        for e in parsed.errors {
            let reason = format!("parse-error:{e}");
            self.unresolved(path, None, &reason);
            self.limitations
                .insert("lexical-parse-error-present".into());
            self.incomplete.insert(reason);
        }
        for s in parsed.dynamic {
            self.runtime(path, s.as_deref(), "dynamic-import-unsupported");
        }
        for s in parsed.requires {
            self.runtime(path, s.as_deref(), "require-unsupported");
        }
        let mut edges = BTreeSet::new();
        for s in parsed.static_imports {
            if let Some(to) = self.resolve(path, &s) {
                edges.insert(Edge {
                    from: path.into(),
                    to,
                });
            }
        }
        edges.into_iter().collect()
    }
    fn freshness(&mut self) -> Value {
        let mut consistent = true;
        for (path, hash) in self.hashes.clone() {
            let result = (|| -> Result<bool> {
                let stat = safe_file(&self.root, &path)?;
                if stat.len() as usize > FILE_CAP || self.read + stat.len() as usize > READ_CAP {
                    self.truncated(format!("freshness-read-cap-reached:{READ_CAP}"));
                    return Ok(false);
                }
                let bytes = bounded_read(&self.root, &path, FILE_CAP)?;
                self.read += bytes.len();
                Ok(bytes.len() <= FILE_CAP && sha256(bytes) == hash)
            })();
            if !matches!(result, Ok(true)) {
                consistent = false;
            }
        }
        if !consistent {
            self.limitations
                .insert("visited-file-changed-or-disappeared-during-query".into());
            self.incomplete.insert("freshness-inconsistent".into());
        }
        json!({"algorithm":"sha256-visited-files","consistent":consistent,"visitedFiles":self.hashes.len()})
    }
}
pub fn bounded_read(root: &Path, path: &str, max: usize) -> Result<Vec<u8>> {
    safe_file(root, path)?;
    let f = fs::File::open(root.join(path))?;
    let mut b = Vec::new();
    f.take(max as u64 + 1).read_to_end(&mut b)?;
    Ok(b)
}
fn insert(edges: &mut BTreeSet<Edge>, e: Edge, c: &mut Context) -> bool {
    if edges.contains(&e) {
        return true;
    }
    if edges.len() >= 4096 {
        c.truncated("edge-cap-reached:4096");
        return false;
    }
    edges.insert(e);
    true
}
pub fn query(v: &Value) -> Result<Value> {
    schema::object(
        v,
        "request",
        &["schemaVersion", "root", "entry", "direction", "maxDepth"],
    )?;
    if v["schemaVersion"] != "gdm-graph-query/v1" {
        return Err(err("schemaVersion must be gdm-graph-query/v1"));
    }
    let root = v["root"]
        .as_str()
        .filter(|s| Path::new(s).is_absolute() && !s.contains('\0'))
        .ok_or_else(|| err("root must be an absolute path"))?;
    let entry = schema::canonical(
        v["entry"]
            .as_str()
            .ok_or_else(|| err("entry must be a string"))?,
        "entry",
        usize::MAX,
    )?;
    let dir = v["direction"]
        .as_str()
        .filter(|s| matches!(*s, "dependencies" | "dependents"))
        .ok_or_else(|| err("direction must be dependencies or dependents"))?;
    let max = schema::integer(&v["maxDepth"], "maxDepth", 1, 5)?;
    let root = validate_root(Path::new(root))?;
    safe_file(&root, &entry)?;
    let all = candidate_paths(&root)?;
    let mut candidates = BTreeSet::new();
    let mut initial = BTreeSet::<String>::new();
    for path in all {
        if !supported(&path) {
            continue;
        }
        if schema::canonical(&path, "Git candidate", usize::MAX).is_err() {
            initial.insert("noncanonical-git-candidate-skipped".into());
        } else {
            candidates.insert(path);
        }
    }
    let cut = candidates.len() > 512;
    let mut candidates = candidates.into_iter().take(512).collect::<BTreeSet<_>>();
    if supported(&entry) && !candidates.contains(&entry) {
        if candidates.len() >= 512 {
            candidates.pop_last();
        }
        candidates.insert(entry.clone());
    }
    let mut c = Context::new(root, candidates);
    for s in initial {
        c.limitations.insert(s.clone());
        c.incomplete.insert(s);
    }
    if cut {
        c.truncated("candidate-file-cap-reached:512");
    }
    let mut all_edges = BTreeSet::new();
    if dir == "dependents" {
        for p in c.candidates.clone() {
            for e in c.scan(&p) {
                insert(&mut all_edges, e, &mut c);
            }
            if c.exhausted {
                break;
            }
        }
    }
    let mut depths = BTreeMap::from([(entry.clone(), 0)]);
    let mut queue = VecDeque::from([entry.clone()]);
    let mut selected = BTreeSet::new();
    let mut boundary = Vec::new();
    while let Some(path) = queue.pop_front() {
        let depth = depths[&path];
        let edges = if dir == "dependencies" {
            c.scan(&path)
        } else {
            all_edges.iter().filter(|e| e.to == path).cloned().collect()
        };
        for e in edges {
            if depth >= max {
                boundary.push(e);
                continue;
            }
            if !insert(&mut selected, e.clone(), &mut c) {
                continue;
            }
            let next = if dir == "dependencies" {
                &e.to
            } else {
                &e.from
            };
            if !depths.contains_key(next) {
                depths.insert(next.clone(), depth + 1);
                queue.push_back(next.clone());
            }
        }
        if c.exhausted && dir == "dependencies" {
            break;
        }
    }
    let mut frontier = BTreeSet::new();
    for e in boundary {
        let next = if dir == "dependencies" {
            &e.to
        } else {
            &e.from
        };
        if depths.contains_key(next) {
            insert(&mut selected, e, &mut c);
        } else {
            frontier.insert(if dir == "dependencies" { e.from } else { e.to });
        }
    }
    let fresh = c.freshness();
    let tests=depths.iter().filter(|(p,d)|dir=="dependents"&&**d>0&&schema::matches(r"(?:^|/)test/|\.test\.(?:ts|tsx|js|jsx)$",p)).map(|(p,d)|json!({"path":p,"reason":if *d==1{"direct-dependent"}else{"transitive-dependent"}})).collect::<Vec<_>>();
    Ok(
        json!({"schemaVersion":"gdm-graph-result/v2","provider":{"name":"gdm-ts-relative-imports","version":2},"entry":entry,"direction":dir,"nodes":depths.iter().map(|(p,d)|json!({"path":p,"depth":d})).collect::<Vec<_>>(),"edges":selected.iter().map(|e|json!({"from":e.from,"to":e.to,"via":"relative-import"})).collect::<Vec<_>>(),"candidateTests":tests,"unresolved":c.unresolved.values().collect::<Vec<_>>(),"limitations":c.limitations,"freshness":fresh,"coverage":{"scope":"requested-depth","requestedMaxDepth":max,"completeWithinRequestedDepth":c.incomplete.is_empty(),"frontier":frontier,"incompleteReasons":c.incomplete},"truncated":c.truncated,"limits":{"maxDepth":5,"maxCandidateFiles":512,"maxFileBytes":FILE_CAP,"maxTotalReadBytes":READ_CAP,"maxEdges":4096,"maxUnresolved":512}}),
    )
}
