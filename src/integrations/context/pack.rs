use super::{
    graph, scan,
    schema::{self, Query, assignment, secret, terms},
};
use crate::support::{Result, sha256};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    path::Path,
};
const FILE_CAP: usize = 256 * 1024;
const READ_CAP: usize = 8 * 1024 * 1024;
#[derive(Clone)]
struct Node {
    key: String,
    kind: String,
    hash: String,
    line: usize,
    terms: BTreeSet<String>,
    snippet: Option<(usize, usize, String)>,
}
#[derive(Clone, Eq, PartialEq, Ord, PartialOrd)]
struct Edge {
    from: String,
    to: String,
    kind: String,
    line: usize,
}
#[derive(Clone)]
struct Source {
    path: String,
    source: String,
    lines: Vec<String>,
    hash: String,
    kind: String,
}
struct Builder {
    root: String,
    candidates: Vec<String>,
    nodes: BTreeMap<String, Node>,
    edges: BTreeSet<Edge>,
    limits: BTreeSet<String>,
    files: BTreeMap<String, Source>,
    work_hash: String,
    read: usize,
}
fn hash8(s: impl AsRef<[u8]>) -> String {
    sha256(s)[..8].into()
}
fn is_test(s: &str) -> bool {
    schema::matches(
        r"(?:^|/)(?:test|tests|__tests__)(?:/|$)|\.(?:test|spec)\.(?:ts|tsx|js|jsx)$",
        s,
    )
}
fn paths(root: &Path) -> Result<Vec<String>> {
    Ok(graph::candidate_paths(root)?
        .into_iter()
        .filter(|p| {
            p != ".gdm"
                && !p.starts_with(".gdm/")
                && p != ".gdm.lock"
                && !p.split('/').any(|x| x.starts_with(".env"))
                && !secret(p)
                && schema::canonical(p, "path", usize::MAX).is_ok()
        })
        .take(2048)
        .collect())
}
impl Builder {
    fn new(root: &str) -> Result<Self> {
        let candidates = paths(Path::new(root))?;
        let mut limits = BTreeSet::new();
        if candidates.len() >= 2048 {
            limits.insert("candidate-file-cap-reached:2048".into());
        }
        Ok(Self {
            root: root.into(),
            candidates,
            nodes: BTreeMap::new(),
            edges: BTreeSet::new(),
            limits,
            files: BTreeMap::new(),
            work_hash: String::new(),
            read: 0,
        })
    }
    fn node(&mut self, n: Node) {
        if secret(&n.key) {
            self.limits.insert("secret-shaped-node-skipped".into());
            return;
        }
        if let Some(old) = self.nodes.get_mut(&n.key) {
            old.terms.extend(n.terms);
            if old.snippet.is_none() {
                old.snippet = n.snippet;
            }
        } else {
            self.nodes.insert(n.key.clone(), n);
        }
    }
    fn edge(&mut self, from: &str, to: &str, kind: &str, line: usize) {
        if !self.nodes.contains_key(from) || !self.nodes.contains_key(to) {
            return;
        }
        let e = Edge {
            from: from.into(),
            to: to.into(),
            kind: kind.into(),
            line,
        };
        if self.edges.contains(&e) {
            return;
        }
        if self.edges.len() >= 8192 {
            self.limits.insert("internal-edge-cap-reached:8192".into());
            return;
        }
        self.edges.insert(e);
    }
    fn read(&mut self, path: &str) -> Option<Source> {
        if let Some(f) = self.files.get(path) {
            return Some(f.clone());
        }
        let size = match graph::safe_file(Path::new(&self.root), path) {
            Ok(s) => s.len() as usize,
            Err(_) => {
                self.limits
                    .insert("unsafe-or-nonregular-candidate-skipped".into());
                return None;
            }
        };
        if size > FILE_CAP || self.read + size > READ_CAP {
            self.limits.insert(
                if size > FILE_CAP {
                    "file-size-cap-reached"
                } else {
                    "total-read-byte-cap-reached"
                }
                .into(),
            );
            return None;
        }
        let bytes = match graph::bounded_read(
            Path::new(&self.root),
            path,
            FILE_CAP.min(READ_CAP - self.read),
        ) {
            Ok(b) => b,
            Err(_) => {
                self.limits.insert("candidate-read-failed".into());
                return None;
            }
        };
        if bytes.len() > FILE_CAP || self.read + bytes.len() > READ_CAP {
            self.limits.insert("total-read-byte-cap-reached".into());
            return None;
        }
        self.read += bytes.len();
        let hash = sha256(&bytes);
        let source = match String::from_utf8(bytes) {
            Ok(s) => s,
            Err(_) => {
                self.limits.insert("invalid-utf8-candidate-skipped".into());
                return None;
            }
        };
        let file = Source {
            path: path.into(),
            lines: source
                .split('\n')
                .map(|s| s.strip_suffix('\r').unwrap_or(s).to_owned())
                .collect(),
            source,
            hash,
            kind: if is_test(path) { "test" } else { "file" }.into(),
        };
        self.files.insert(path.into(), file.clone());
        Some(file)
    }
    fn file(&mut self, f: &Source) {
        self.node(Node {
            key: f.path.clone(),
            kind: f.kind.clone(),
            hash: f.hash[..8].into(),
            line: 1,
            terms: terms(&[&f.path]),
            snippet: None,
        });
    }
    fn fresh(&self) -> bool {
        if paths(Path::new(&self.root)).ok().as_ref() != Some(&self.candidates) {
            return false;
        }
        let mut bytes = 0;
        for f in self.files.values() {
            let b = match graph::bounded_read(Path::new(&self.root), &f.path, FILE_CAP) {
                Ok(b) => b,
                Err(_) => return false,
            };
            bytes += b.len();
            if b.len() > FILE_CAP || bytes > READ_CAP || sha256(&b) != f.hash {
                return false;
            }
        }
        works(&self.root)
            .ok()
            .and_then(|v| serde_json::to_vec(&v).ok())
            .map(sha256)
            .as_ref()
            == Some(&self.work_hash)
    }
}
fn line_of(file: &Source, s: &str) -> usize {
    file.lines
        .iter()
        .position(|l| l.contains(s))
        .map_or(1, |i| i + 1)
}
fn snippet(lines: &[String], line: usize) -> Option<(usize, usize, String)> {
    let mut text = lines.get(line.checked_sub(1)?)?.trim_end().to_owned();
    if text.is_empty() || secret(&text) || assignment(&text) {
        return None;
    }
    while text.len() > 480 {
        text.pop();
    }
    (!text.is_empty() && !secret(&text) && !assignment(&text)).then_some((line, line, text))
}
fn modules(b: &mut Builder) {
    for path in b.candidates.clone().iter().filter(|p| graph::supported(p)) {
        let Some(f) = b.read(path) else {
            continue;
        };
        b.file(&f);
        let parsed = scan::parse(&f.source, &f.path);
        if !parsed.errors.is_empty() {
            b.limits.insert("module-parse-error-present".into());
        }
        if !parsed.dynamic.is_empty() {
            b.limits.insert("dynamic-import-unsupported".into());
        }
        if !parsed.requires.is_empty() {
            b.limits.insert("require-unsupported".into());
        }
        for s in parsed.static_imports {
            let target = if graph::relative(&s) {
                graph::resolution(path, &s)
                    .into_iter()
                    .find(|p| b.candidates.contains(p))
            } else {
                None
            };
            let Some(target) = target else {
                if s.starts_with("@/") || s.starts_with("~/") || s.starts_with('#') {
                    b.limits.insert("path-alias-unsupported".into());
                }
                continue;
            };
            if let Some(t) = b.read(&target) {
                b.file(&t);
                b.edge(
                    path,
                    &target,
                    if f.kind == "test" { "tests" } else { "imports" },
                    line_of(&f, &s),
                );
            }
        }
    }
}
fn markdown(b: &mut Builder) {
    let heading_re = Regex::new(r"^#{1,6}\s+(.+?)\s*#*$").unwrap();
    let destinations = [
        Regex::new(r"\]\(([^)\s]+)\)").unwrap(),
        Regex::new(r"`([^`\s]+\.[A-Za-z0-9]+)`").unwrap(),
    ];
    for path in b
        .candidates
        .clone()
        .iter()
        .filter(|p| p.ends_with(".md") || p.ends_with(".mdx"))
    {
        let Some(f) = b.read(path) else {
            continue;
        };
        b.file(&f);
        let mut current = path.clone();
        let mut keys = BTreeSet::new();
        for (i, line) in f.lines.iter().enumerate() {
            if let Some(c) = heading_re.captures(line) {
                let h = c[1].trim();
                if secret(h) || assignment(h) {
                    b.limits.insert("secret-shaped-heading-skipped".into());
                    current = path.clone();
                } else {
                    let slug = schema::split_terms(h)
                        .join("-")
                        .chars()
                        .take(96)
                        .collect::<String>();
                    let base =
                        format!("{path}#{}", if slug.is_empty() { "heading" } else { &slug });
                    let key = if keys.contains(&base) {
                        format!("{base}-{}", i + 1)
                    } else {
                        base
                    };
                    keys.insert(key.clone());
                    b.node(Node {
                        key: key.clone(),
                        kind: "heading".into(),
                        hash: f.hash[..8].into(),
                        line: i + 1,
                        terms: terms(&[path, h]),
                        snippet: snippet(&f.lines, i + 1),
                    });
                    b.edge(path, &key, "contains", i + 1);
                    current = key;
                }
            }
            for re in &destinations {
                for c in re.captures_iter(line) {
                    let raw = c[1].trim().trim_start_matches('<').trim_end_matches('>');
                    let target = raw.split('#').next().unwrap_or("");
                    if target.is_empty()
                        || schema::matches(r"(?i)^[a-z][a-z0-9+.-]*:", target)
                        || target.starts_with('/')
                    {
                        continue;
                    }
                    let Some(target) = graph::relative_base(path, target) else {
                        continue;
                    };
                    if !b.candidates.contains(&target) {
                        continue;
                    }
                    if let Some(f) = b.read(&target) {
                        b.file(&f);
                        b.edge(&current, &target, "mentions", i + 1);
                    }
                }
            }
        }
    }
}
fn packages(b: &mut Builder) {
    for path in b
        .candidates
        .clone()
        .iter()
        .filter(|p| Path::new(p).file_name().and_then(|x| x.to_str()) == Some("package.json"))
    {
        let Some(f) = b.read(path) else {
            continue;
        };
        b.file(&f);
        let v: Value = match serde_json::from_str(&f.source) {
            Ok(v) => v,
            Err(_) => {
                b.limits.insert("package-json-invalid".into());
                continue;
            }
        };
        let Some(name) = v["name"].as_str().filter(|s| !s.is_empty() && !secret(s)) else {
            continue;
        };
        let mut meta = vec![path.as_str(), name];
        for k in ["scripts", "dependencies", "devDependencies"] {
            if let Some(o) = v[k].as_object() {
                meta.extend(o.keys().map(String::as_str));
            }
        }
        let key = format!("pkg:{name}");
        let line = line_of(&f, "\"name\"");
        b.node(Node {
            key: key.clone(),
            kind: "package".into(),
            hash: f.hash[..8].into(),
            line,
            terms: terms(&meta),
            snippet: snippet(&f.lines, line),
        });
        b.edge(path, &key, "contains", line);
    }
}
fn owners_regex(raw: &str) -> Option<Regex> {
    let anchored = raw.starts_with('/');
    let mut pattern = raw.trim_start_matches('/').to_string();
    if pattern.is_empty() || pattern.starts_with('!') || pattern.contains(['\\', '[']) {
        return None;
    }
    let root = anchored || pattern.contains('/');
    let dir = pattern.ends_with('/');
    if dir {
        pattern.pop();
    }
    let mut regex = String::new();
    let mut it = pattern.chars().peekable();
    while let Some(c) = it.next() {
        if c == '*' {
            if it.peek() == Some(&'*') {
                it.next();
                regex.push_str(".*");
            } else {
                regex.push_str("[^/]*");
            }
        } else if c == '?' {
            regex.push_str("[^/]");
        } else {
            regex.push_str(&regex::escape(&c.to_string()));
        }
    }
    Regex::new(&format!(
        "{}{regex}{}$",
        if root { "^" } else { "(?:^|.*/)" },
        if dir { "(?:/.*)?" } else { "" }
    ))
    .ok()
}
fn owners(b: &mut Builder) {
    let Some(path) = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]
        .into_iter()
        .find(|p| b.candidates.iter().any(|c| c == p))
    else {
        return;
    };
    let Some(f) = b.read(path) else {
        return;
    };
    b.file(&f);
    let mut owned = BTreeMap::new();
    for (i, l) in f.lines.iter().enumerate() {
        let l = l.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        let mut parts = l.split_whitespace();
        let matcher = parts.next().and_then(owners_regex);
        let owners = parts
            .filter(|s| s.starts_with('@') && !secret(s))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let Some(matcher) = matcher.filter(|_| !owners.is_empty()) else {
            b.limits.insert("codeowners-rule-unsupported".into());
            continue;
        };
        for p in &b.candidates {
            if p != path && matcher.is_match(p) {
                owned.insert(p.clone(), (owners.clone(), i + 1));
            }
        }
    }
    for (path, (owners, line)) in owned {
        let Some(f) = b.read(&path) else {
            continue;
        };
        b.file(&f);
        for owner in owners {
            let key = format!("owner:{owner}");
            b.node(Node {
                key: key.clone(),
                kind: "owner".into(),
                hash: hash8(&owner),
                line,
                terms: terms(&[&owner]),
                snippet: None,
            });
            b.edge(&key, &path, "owns", line);
        }
    }
}
fn scope_matches(path: &str, scope: &str) -> bool {
    if scope == "." {
        false
    } else if scope == path {
        true
    } else if scope.ends_with('/') {
        path.starts_with(scope)
    } else if !scope.contains('*') {
        path.starts_with(&format!("{scope}/"))
    } else {
        owners_regex(scope).is_some_and(|r| r.is_match(path))
    }
}
fn works(root: &str) -> Result<Vec<Value>> {
    let dir = Path::new(root).join(".gdm");
    let stat = match fs::symlink_metadata(&dir) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.into()),
    };
    if stat.is_symlink() || !stat.is_dir() {
        return Err(schema::err("unsafe GDM metadata root"));
    }
    let mut names = fs::read_dir(&dir)?
        .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    names.sort();
    let mut out = Vec::new();
    for name in names {
        let child = dir.join(&name);
        let stat = fs::symlink_metadata(&child)?;
        if stat.is_symlink() {
            return Err(schema::err("symbolic link in GDM metadata"));
        }
        if !stat.is_dir() {
            continue;
        }
        let state = child.join("checks.json");
        let stat = match fs::symlink_metadata(&state) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if name.starts_with('.')
                    || ["habits", "native", "plans"].contains(&name.as_str())
                    || crate::runtime::state::validate_slug(&name).is_err()
                {
                    continue;
                }
                return Err(schema::err("incomplete GDM Work state"));
            }
            Err(e) => return Err(e.into()),
        };
        if stat.is_symlink() || !stat.is_file() {
            return Err(schema::err("unsafe GDM Work state"));
        }
        let w = crate::runtime::store::load(Path::new(root), &name)?;
        let checks=w["checks"].as_array().ok_or_else(||schema::err("invalid checks"))?.iter().map(|c|json!({"id":c["id"],"desc":c["desc"],"expect":c["expect"],"kind":c.get("kind").cloned().unwrap_or(json!("behavior")),"manual":c["manual"],"status":c["status"],"evidence":c.get("evidence").filter(|e|!e.is_null()).map(|e|json!({"observed":e["observed"],"sha256":e["sha256"],"exitCode":e.get("exitCode").cloned().unwrap_or(Value::Null),"manual":e["manual"],"at":e["at"]})).unwrap_or(Value::Null)})).collect::<Vec<_>>();
        out.push(json!({"slug":w["slug"],"brief":w["brief"],"createdAt":w["createdAt"],"done":w["done"],"allowedPaths":w["contract"].get("allowedPaths").cloned().unwrap_or(json!(["."])),"checks":checks}));
    }
    out.sort_by(|a, b| a["slug"].as_str().cmp(&b["slug"].as_str()));
    Ok(out)
}
fn string(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn ingest_works(b: &mut Builder) -> Result<()> {
    let works = works(&b.root)?;
    b.work_hash = sha256(serde_json::to_vec(&works)?);
    for w in works {
        let slug = string(&w["slug"]);
        let brief = string(&w["brief"]);
        let key = format!("w:{slug}");
        let done = w["done"].as_bool().unwrap_or(false);
        let status = if done { "done" } else { "open" };
        let hidden = secret(brief);
        b.node(Node {
            key: key.clone(),
            kind: "work".into(),
            hash: hash8(format!("{slug}\0{}\0{done}", string(&w["createdAt"]))),
            line: 0,
            terms: if hidden {
                terms(&[slug, status])
            } else {
                terms(&[slug, brief, status])
            },
            snippet: None,
        });
        if hidden {
            b.limits.insert("secret-shaped-work-text-skipped".into());
        }
        let scopes = w["allowedPaths"].as_array().unwrap();
        for path in b.candidates.clone() {
            if !scopes.iter().any(|s| scope_matches(&path, string(s))) {
                continue;
            }
            if let Some(f) = b.read(&path) {
                b.file(&f);
                b.edge(&key, &path, "touches", 0);
            }
        }
        for c in w["checks"].as_array().unwrap() {
            let id = string(&c["id"]);
            let ck = format!("c:{slug}:{id}");
            let status = string(&c["status"]);
            let kind = string(&c["kind"]);
            let text = format!("{}\n{}", string(&c["desc"]), string(&c["expect"]));
            let hidden = secret(&text);
            let manual = c["manual"].as_bool().unwrap_or(false);
            b.node(Node {
                key: ck.clone(),
                kind: "check".into(),
                hash: hash8(format!("{id}\0{status}\0{kind}\0{manual}")),
                line: 0,
                terms: if hidden {
                    terms(&[id, status, kind])
                } else {
                    terms(&[id, string(&c["desc"]), string(&c["expect"]), status, kind])
                },
                snippet: None,
            });
            if hidden {
                b.limits.insert("secret-shaped-check-text-skipped".into());
            }
            b.edge(&key, &ck, "contains", 0);
            for path in b.candidates.clone() {
                if scopes.iter().any(|s| scope_matches(&path, string(s)))
                    && b.nodes.contains_key(&path)
                {
                    b.edge(&ck, &path, "verifies", 0);
                }
            }
            let e = &c["evidence"];
            if e.is_null() || secret(string(&e["observed"])) {
                continue;
            }
            let observed = string(&e["observed"]);
            let ek = format!("ev:{observed}");
            let hash = string(&e["sha256"]);
            b.node(Node {
                key: ek.clone(),
                kind: "evidence_ref".into(),
                hash: hash.chars().take(8).collect(),
                line: 0,
                terms: terms(&[
                    observed,
                    if e["manual"].as_bool().unwrap_or(false) {
                        "manual"
                    } else {
                        "automatic"
                    },
                ]),
                snippet: None,
            });
            b.edge(&ck, &ek, "evidenced_by", 0);
        }
    }
    Ok(())
}
fn rank(b: &Builder, q: &Query) -> Vec<Node> {
    let query = q
        .terms
        .iter()
        .flat_map(|s| schema::split_terms(s))
        .collect::<BTreeSet<_>>();
    let mut scores = BTreeMap::<String, usize>::new();
    let mut queue = VecDeque::new();
    for n in b.nodes.values() {
        let mut score = 0;
        for seed in &q.seeds {
            if &n.key == seed {
                score += 200;
            } else if n.key.starts_with(&format!("{seed}#")) {
                score += 120;
            }
        }
        for query in &query {
            for term in &n.terms {
                score += if term == query {
                    24
                } else if term.starts_with(query) || query.starts_with(term) {
                    10
                } else if term.contains(query) || query.contains(term) {
                    4
                } else {
                    0
                };
            }
        }
        if score > 0 {
            scores.insert(n.key.clone(), score);
            queue.push_back((n.key.clone(), 0, score));
        }
    }
    let mut adjacency = BTreeMap::<String, Vec<String>>::new();
    for e in &b.edges {
        if q.edges.contains(&e.kind) {
            adjacency
                .entry(e.from.clone())
                .or_default()
                .push(e.to.clone());
            adjacency
                .entry(e.to.clone())
                .or_default()
                .push(e.from.clone());
        }
    }
    for v in adjacency.values_mut() {
        v.sort();
    }
    while let Some((key, depth, score)) = queue.pop_front() {
        if depth >= q.depth {
            continue;
        }
        for next in adjacency.get(&key).into_iter().flatten() {
            let propagated = score.saturating_sub((depth + 1) * 8).max(1);
            if scores.get(next).copied().unwrap_or(0) >= propagated {
                continue;
            }
            scores.insert(next.clone(), propagated);
            queue.push_back((next.clone(), depth + 1, propagated));
        }
    }
    let mut ranked = scores.into_iter().collect::<Vec<_>>();
    ranked.sort_by(|(a, sa), (b, sb)| sb.cmp(sa).then_with(|| a.cmp(b)));
    ranked
        .into_iter()
        .filter_map(|(key, _)| b.nodes.get(&key).cloned())
        .collect()
}
fn fingerprint(b: &Builder) -> String {
    let mut input = String::new();
    for n in b.nodes.values() {
        input.push_str(&format!("{}\0{}\0{}\n", n.key, n.hash, n.line));
    }
    for e in &b.edges {
        input.push_str(&format!("{}\0{}\0{}\0{}\n", e.from, e.to, e.kind, e.line));
    }
    sha256(input)[..16].into()
}
fn limits(q: &Query) -> Value {
    json!({"b":if q.route{q.bytes.min(1024)}else{q.bytes},"n":q.nodes,"e":q.edge_count,"sn":q.snippets,"d":q.depth})
}
pub fn failure(q: &Query, status: &str, reason: &str) -> Value {
    json!({"s":"gdm-context-pack/v1","st":status,"fr":"stale","fp":"","n":[],"e":[],"sn":[],"u":{"count":1,"why":[reason]},"tr":null,"lim":limits(q)})
}
fn render(b: &Builder, q: &Query, ranked: &[Node], fresh: bool) -> Result<Value> {
    let max = if q.route { q.bytes.min(1024) } else { q.bytes };
    let mut nlimit = ranked.len().min(q.nodes);
    let mut elimit = if q.route { 0 } else { q.edge_count };
    let mut slimit = if q.route || !fresh { 0 } else { q.snippets };
    let mut wlimit = b.limits.len().min(8);
    let initially = ranked.len().saturating_sub(q.nodes);
    let mut trimmed = false;
    let fp = fingerprint(b);
    loop {
        let chosen = &ranked[..nlimit];
        let indices = chosen
            .iter()
            .enumerate()
            .map(|(i, n)| (n.key.as_str(), i))
            .collect::<BTreeMap<_, _>>();
        let nodes = chosen
            .iter()
            .map(|n| json!([n.key, n.kind, n.hash, n.line]))
            .collect::<Vec<_>>();
        let edges = b
            .edges
            .iter()
            .filter(|e| q.edges.contains(&e.kind))
            .filter_map(|e| {
                Some(json!([
                    indices.get(e.from.as_str())?,
                    indices.get(e.to.as_str())?,
                    e.kind,
                    e.line
                ]))
            })
            .collect::<Vec<_>>();
        let snippets = chosen
            .iter()
            .enumerate()
            .filter_map(|(i, n)| {
                n.snippet
                    .as_ref()
                    .map(|(start, end, text)| json!([i, start, end, text]))
            })
            .collect::<Vec<_>>();
        let dropped = initially
            + edges.len().saturating_sub(elimit)
            + snippets.len().saturating_sub(slimit)
            + ranked.len().min(q.nodes).saturating_sub(nlimit);
        let tr = if dropped > 0 || trimmed {
            json!({"why":if trimmed{"byte-budget"}else if initially>0{"node-budget"}else if edges.len()>elimit{"edge-budget"}else{"snippet-budget"},"dropped":dropped,"hint":"narrow-terms-seeds-or-depth"})
        } else {
            Value::Null
        };
        let pack = json!({"s":"gdm-context-pack/v1","st":if !fresh{"stale"}else if ranked.is_empty(){"unsupported"}else{"ok"},"fr":if fresh{"fresh"}else{"stale"},"fp":fp,"n":nodes,"e":edges.into_iter().take(elimit).collect::<Vec<_>>(),"sn":snippets.into_iter().take(slimit).collect::<Vec<_>>(),"u":{"count":b.limits.len(),"why":b.limits.iter().take(wlimit).collect::<Vec<_>>()},"tr":tr,"lim":limits(q)});
        if serde_json::to_vec(&pack)?.len() <= max {
            return Ok(pack);
        }
        trimmed = true;
        if slimit > 0 {
            slimit -= 1;
        } else if elimit > 0 {
            elimit -= 1;
        } else if nlimit > 0 {
            nlimit -= 1;
        } else if wlimit > 0 {
            wlimit -= 1;
        } else {
            return Err(schema::err(
                "context pack minimum response exceeds byte budget",
            ));
        }
    }
}
pub fn build(q: &Query) -> Result<Value> {
    let mut b = Builder::new(&q.root)?;
    modules(&mut b);
    markdown(&mut b);
    packages(&mut b);
    owners(&mut b);
    if ingest_works(&mut b).is_err() {
        return Ok(failure(q, "error", "gdm-metadata-invalid"));
    }
    let fresh = b.fresh();
    if !fresh {
        b.limits
            .insert("source-or-work-changed-during-query".into());
    }
    render(&b, q, &rank(&b, q), fresh)
}
