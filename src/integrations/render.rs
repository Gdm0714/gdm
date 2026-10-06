//! Deterministic target skill rendering, including source and executable receipts.
use crate::support::{Error, Result, print_json, read_flag, required_flag, sha256};
use regex::Regex;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
const ADAPTER_BEGIN: &str = "<!-- GDM_TARGET_ADAPTER_V1_BEGIN -->";
const ADAPTER_END: &str = "<!-- GDM_TARGET_ADAPTER_V1_END -->";
fn error(s: impl Into<String>) -> Error {
    Error::new("skill_renderer", s)
}
fn safe(path: &Path, dir: bool) -> Result<()> {
    let m = fs::symlink_metadata(path)?;
    if m.file_type().is_symlink() || (dir && !m.is_dir()) || (!dir && !m.is_file()) {
        return Err(error(format!(
            "{} without symlinks required: {}",
            if dir { "directory" } else { "regular file" },
            path.display()
        )));
    }
    Ok(())
}
fn entries(path: &Path) -> Result<Vec<PathBuf>> {
    let mut e = fs::read_dir(path)?
        .map(|e| e.map(|e| e.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    e.sort();
    Ok(e)
}
fn files(root: &Path) -> Result<Vec<PathBuf>> {
    safe(root, true)?;
    let mut out = vec![];
    for p in entries(root)? {
        let m = fs::symlink_metadata(&p)?;
        if m.file_type().is_symlink() {
            return Err(error(format!(
                "source symlink is not supported: {}",
                p.display()
            )));
        }
        if m.is_dir() {
            out.extend(files(&p)?);
        } else if m.is_file() {
            out.push(p);
        } else {
            return Err(error("unsupported source entry"));
        }
    }
    Ok(out)
}
fn tree_hash(roots: &[(&str, &Path)]) -> Result<String> {
    let mut h = Sha256::new();
    for (label, root) in roots {
        for p in files(root)? {
            let name = format!("{label}/{}", p.strip_prefix(root).unwrap().display());
            let b = fs::read(&p)?;
            h.update(format!(
                "{}:{name}:{}:",
                name.encode_utf16().count(),
                b.len()
            ));
            h.update(b);
        }
    }
    Ok(hex::encode(h.finalize()))
}
fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    safe(from, true)?;
    fs::create_dir(to)?;
    for p in entries(from)? {
        let q = to.join(p.file_name().unwrap());
        let m = fs::symlink_metadata(&p)?;
        if m.file_type().is_symlink() {
            return Err(error("source symlink is not supported"));
        }
        if m.is_dir() {
            copy_tree(&p, &q)?;
        } else if m.is_file() {
            fs::copy(&p, &q)?;
            fs::set_permissions(
                q,
                fs::Permissions::from_mode(if m.permissions().mode() & 0o111 != 0 {
                    0o755
                } else {
                    0o644
                }),
            )?;
        } else {
            return Err(error("unsupported source entry"));
        }
    }
    Ok(())
}
fn exclusive(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .open(path)?;
    f.write_all(bytes)?;
    Ok(())
}
fn absolute(cwd: &Path, path: impl AsRef<Path>) -> PathBuf {
    if path.as_ref().is_absolute() {
        path.as_ref().to_path_buf()
    } else {
        cwd.join(path)
    }
}
pub fn run(cwd: &Path, args: &[String]) -> Result<()> {
    let target = required_flag(args, "target")?;
    if !["codex", "claude", "pi"].contains(&target.as_str()) {
        return Err(error("target must be codex, claude, or pi"));
    }
    let output = absolute(cwd, required_flag(args, "output")?);
    let repository = Path::new(env!("CARGO_MANIFEST_DIR"));
    let source = read_flag(args, "source-root")?
        .map(|p| absolute(cwd, p))
        .unwrap_or_else(|| repository.join("skills"));
    let agents = read_flag(args, "agents-root")?
        .map(|p| absolute(cwd, p))
        .unwrap_or_else(|| repository.join("agents"));
    safe(&source, true)?;
    safe(&agents, true)?;
    for name in [
        "run-role.sh",
        "providers/codex.sh",
        "providers/claude.sh",
        "providers/pi.sh",
    ] {
        let p = agents.join(name);
        safe(&p, false)?;
        if fs::metadata(p)?.permissions().mode() & 0o111 == 0 {
            return Err(error("executable role runner file required"));
        }
    }
    if output.exists() {
        safe(&output, true)?;
        if fs::read_dir(&output)?.next().is_some() {
            return Err(error("output directory must be empty"));
        }
    } else {
        fs::create_dir_all(&output)?;
    }
    let adapter_path = source.join("_shared/targets").join(format!("{target}.md"));
    safe(&adapter_path, false)?;
    let adapter = fs::read_to_string(adapter_path)?.trim_end().to_owned();
    let source_hash = tree_hash(&[("skills", &source), ("agents", &agents)])?;
    let mut skills = vec![];
    let mut aggregate = Sha256::new();
    let marker = Regex::new(r"<!-- GDM_TARGET_FRAGMENT_V1:([a-z0-9-]+) -->").unwrap();
    let unresolved = Regex::new(r"\{\{|\}\}|__GDM_[A-Z0-9_]+__").unwrap();
    let raw_provider = Regex::new(r"(?i)\b(?:claude\s+-p|codex\s+exec)\b").unwrap();
    let native_words = Regex::new(
        r"(?i)GDM_AGENT_ENVELOPE_V1|multi_agent_v2|hook caller|native (?:Codex )?root session",
    )
    .unwrap();
    for directory in entries(&source)? {
        let name = directory.file_name().unwrap().to_string_lossy();
        if name == "_shared" {
            continue;
        }
        safe(&directory, true)?;
        let skill = directory.join("SKILL.md");
        safe(&skill, false)?;
        let canonical = fs::read_to_string(&skill)?;
        if !canonical.starts_with("---\n") {
            return Err(error(format!(
                "SKILL.md frontmatter must start at byte zero: {}",
                skill.display()
            )));
        }
        let end = canonical[4..]
            .find("\n---\n")
            .map(|n| n + 9)
            .ok_or_else(|| error("SKILL.md frontmatter is not closed"))?;
        let front = &canonical[..end];
        let body = canonical[end..]
            .strip_prefix('\n')
            .unwrap_or(&canonical[end..]);
        let count = marker.captures_iter(body).count();
        if ["analyze", "plan", "review"].contains(&name.as_ref()) && count != 1 {
            return Err(error(format!(
                "read-only skill requires exactly one target delegation fragment: {name}"
            )));
        }
        let mut rendered_body = String::new();
        let mut cursor = 0;
        for cap in marker.captures_iter(body) {
            let m = cap.get(0).unwrap();
            rendered_body.push_str(&body[cursor..m.start()]);
            let path = source
                .join("_shared/targets/fragments")
                .join(format!("{target}-{}.md", &cap[1]));
            safe(&path, false)?;
            rendered_body.push_str(fs::read_to_string(path)?.trim_end());
            cursor = m.end();
        }
        rendered_body.push_str(&body[cursor..]);
        let rendered = format!(
            "{front}\n{ADAPTER_BEGIN}\n{adapter}\n{ADAPTER_END}\n\n<!-- GDM_RENDERED_SKILL_BODY_V1_BEGIN -->\n{}\n<!-- GDM_RENDERED_SKILL_BODY_V1_END -->\n",
            rendered_body.trim_end()
        );
        if unresolved.is_match(&rendered) {
            return Err(error("unresolved marker"));
        }
        let outside = format!("{front}{}", rendered_body);
        if raw_provider.is_match(&outside) {
            return Err(error("direct provider invocation escaped target adapter"));
        }
        if target != "codex" && native_words.is_match(&outside) {
            return Err(error(
                "Codex native delegation guarantee escaped target adapter",
            ));
        }
        let dest = output.join(format!("gdm-{name}"));
        fs::create_dir(&dest)?;
        for p in entries(&directory)? {
            if p.file_name().unwrap() == "SKILL.md" {
                continue;
            }
            let q = dest.join(p.file_name().unwrap());
            let m = fs::symlink_metadata(&p)?;
            if m.file_type().is_symlink() {
                return Err(error("unsupported skill asset symlink"));
            }
            if m.is_dir() {
                copy_tree(&p, &q)?;
            } else if m.is_file() {
                fs::copy(&p, &q)?;
                fs::set_permissions(
                    q,
                    fs::Permissions::from_mode(if m.permissions().mode() & 0o111 != 0 {
                        0o755
                    } else {
                        0o644
                    }),
                )?;
            } else {
                return Err(error("unsupported skill asset"));
            }
        }
        if !fs::canonicalize(&dest)?.starts_with(fs::canonicalize(&output)?) {
            return Err(error("output escaped target root"));
        }
        exclusive(&dest.join("SKILL.md"), rendered.as_bytes())?;
        aggregate.update(format!(
            "{name}:{}:{canonical}",
            canonical.encode_utf16().count()
        ));
        skills.push(json!({"name":format!("gdm-{name}"),"sourcePath":format!("skills/{name}"),"sourceSha256":sha256(&canonical),"renderedSha256":sha256(&rendered)}));
    }
    copy_tree(&agents, &output.join("gdm-agents"))?;
    let mut adapters = serde_json::Map::new();
    for provider in ["codex", "claude", "pi"] {
        let p = format!("gdm-agents/providers/{provider}.sh");
        adapters.insert(
            provider.to_owned(),
            json!({"path":p,"sha256":sha256(fs::read(output.join(&p))?)}),
        );
    }
    let manifest = json!({"schemaVersion":"gdm-target-skill-manifest/v1","target":target,"adapterVersion":"gdm-target-adapter/v1","canonicalSourceSha256":hex::encode(aggregate.finalize()),"sourceSha256":source_hash,"capabilityProfile":{"id":"gdm-read-only-specialist/v1","filesystem":"read-only","delegation":"disabled","mcp":"disabled","shell":"unsupported","browser":"unsupported","network":"unsupported"},"hook":if target=="codex"{json!({"id":"gdm-agent-gate-v1","status":"supported","requiredForTarget":true})}else{json!({"id":null,"status":"not-required","requiredForTarget":false})},"runner":{"contract":"gdm-role-runner/v1","path":"gdm-agents/run-role.sh","sha256":sha256(fs::read(output.join("gdm-agents/run-role.sh"))?),"adapters":adapters},"skills":skills});
    exclusive(
        &output.join("gdm-target-manifest.json"),
        format!("{}\n", serde_json::to_string_pretty(&manifest)?).as_bytes(),
    )?;
    print_json(&manifest)
}

/// Verify artifacts before an installer publishes any target tree.
pub fn verify_manifests(cwd: &Path, args: &[String]) -> Result<()> {
    use serde_json::Value;
    fn keys(v: &Value, expected: &[&str]) -> Result<()> {
        let object = v
            .as_object()
            .ok_or_else(|| error("manifest field must be an object"))?;
        if object.len() != expected.len() || expected.iter().any(|k| !object.contains_key(*k)) {
            return Err(error("manifest key set mismatch"));
        }
        Ok(())
    }
    fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
        v[key]
            .as_str()
            .ok_or_else(|| error(format!("manifest {key} must be text")))
    }
    fn digest(s: &str) -> bool {
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    }
    fn artifact(root: &Path, relative: &str, expected: &str, exec: bool) -> Result<()> {
        if Path::new(relative).is_absolute()
            || relative
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
            || relative.contains('\\')
        {
            return Err(error("manifest artifact path rejected"));
        }
        let mut path = root.to_path_buf();
        let components: Vec<_> = relative.split('/').collect();
        for (i, c) in components.iter().enumerate() {
            path.push(c);
            safe(&path, i + 1 < components.len())?;
        }
        if exec && fs::metadata(&path)?.permissions().mode() & 0o111 == 0 {
            return Err(error("manifest executable mode mismatch"));
        }
        if !digest(expected) || sha256(fs::read(&path)?) != expected {
            return Err(error(format!(
                "manifest artifact bytes mismatch: {relative}"
            )));
        }
        Ok(())
    }
    if args.is_empty() {
        return Err(error("verify-manifests requires target manifest paths"));
    }
    let mut manifests: Vec<Value> = vec![];
    let mut targets = std::collections::BTreeSet::new();
    let skill_name = Regex::new(r"^gdm-[a-z0-9][a-z0-9-]*$").unwrap();
    for arg in args {
        let path = absolute(cwd, arg);
        safe(&path, false)?;
        let root = path.parent().unwrap();
        safe(root, true)?;
        let v: Value = serde_json::from_slice(&fs::read(&path)?)?;
        keys(
            &v,
            &[
                "schemaVersion",
                "target",
                "adapterVersion",
                "canonicalSourceSha256",
                "sourceSha256",
                "capabilityProfile",
                "hook",
                "runner",
                "skills",
            ],
        )?;
        let target = text(&v, "target")?;
        if !["codex", "claude", "pi"].contains(&target)
            || !targets.insert(target.to_owned())
            || v["schemaVersion"] != "gdm-target-skill-manifest/v1"
            || v["adapterVersion"] != "gdm-target-adapter/v1"
        {
            return Err(error("manifest schema/target mismatch"));
        }
        if !digest(text(&v, "canonicalSourceSha256")?) || !digest(text(&v, "sourceSha256")?) {
            return Err(error("manifest source hash mismatch"));
        }
        let profile = json!({"id":"gdm-read-only-specialist/v1","filesystem":"read-only","delegation":"disabled","mcp":"disabled","shell":"unsupported","browser":"unsupported","network":"unsupported"});
        let hook = if target == "codex" {
            json!({"id":"gdm-agent-gate-v1","status":"supported","requiredForTarget":true})
        } else {
            json!({"id":null,"status":"not-required","requiredForTarget":false})
        };
        if v["capabilityProfile"] != profile || v["hook"] != hook {
            return Err(error("manifest capability/hook mismatch"));
        }
        let r = &v["runner"];
        keys(r, &["contract", "path", "sha256", "adapters"])?;
        keys(&r["adapters"], &["codex", "claude", "pi"])?;
        if r["contract"] != "gdm-role-runner/v1" || r["path"] != "gdm-agents/run-role.sh" {
            return Err(error("manifest role runner contract mismatch"));
        }
        artifact(root, text(r, "path")?, text(r, "sha256")?, true)?;
        for provider in ["codex", "claude", "pi"] {
            let a = &r["adapters"][provider];
            keys(a, &["path", "sha256"])?;
            if a["path"] != format!("gdm-agents/providers/{provider}.sh") {
                return Err(error("manifest provider adapter path mismatch"));
            }
            artifact(root, text(a, "path")?, text(a, "sha256")?, true)?;
        }
        let skills = v["skills"]
            .as_array()
            .ok_or_else(|| error("manifest skills must be an array"))?;
        let mut previous = "";
        for skill in skills {
            keys(
                skill,
                &["name", "sourcePath", "sourceSha256", "renderedSha256"],
            )?;
            let name = text(skill, "name")?;
            if !skill_name.is_match(name) || name <= previous {
                return Err(error("skill manifest order/identity mismatch"));
            }
            previous = name;
            if text(skill, "sourcePath")?
                != format!("skills/{}", name.strip_prefix("gdm-").unwrap())
                || !digest(text(skill, "sourceSha256")?)
            {
                return Err(error("skill manifest source identity mismatch"));
            }
            artifact(
                root,
                &format!("{name}/SKILL.md"),
                text(skill, "renderedSha256")?,
                false,
            )?;
        }
        if let Some(first) = manifests.first() {
            for field in ["canonicalSourceSha256", "sourceSha256", "runner"] {
                if first[field] != v[field] {
                    return Err(error("generated target skill manifest parity failed"));
                }
            }
            let a: Vec<_> = first["skills"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| (&s["name"], &s["sourcePath"], &s["sourceSha256"]))
                .collect();
            let b: Vec<_> = skills
                .iter()
                .map(|s| (&s["name"], &s["sourcePath"], &s["sourceSha256"]))
                .collect();
            if a != b {
                return Err(error("generated target skill source parity failed"));
            }
        }
        manifests.push(v);
    }
    print_json(
        &json!({"schemaVersion":"gdm-target-manifest-verification/v1","valid":true,"targets":targets,"manifests":manifests.len()}),
    )
}
