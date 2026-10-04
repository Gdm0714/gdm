//! Native TS/JS parser. Imports in comments, strings, JSX text and regexes are not edges.
use std::collections::BTreeSet;
#[derive(Default, Debug)]
pub struct Parsed {
    pub static_imports: Vec<String>,
    pub dynamic: Vec<Option<String>>,
    pub requires: Vec<Option<String>>,
    pub errors: Vec<String>,
}
fn literal(node: tree_sitter::Node<'_>, source: &str) -> Option<String> {
    if node.kind() != "string" {
        return None;
    }
    let text = node.utf8_text(source.as_bytes()).ok()?;
    let body = text.get(1..text.len().checked_sub(1)?)?;
    // ECMAScript quoted string escapes, including \xNN and \u{NNNN}.
    let mut out = String::new();
    let mut it = body.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        let e = it.next()?;
        match e {
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            'b' => out.push('\x08'),
            'f' => out.push('\x0c'),
            'v' => out.push('\x0b'),
            '0' => out.push('\0'),
            '\n' => {}
            '\r' => {
                if it.peek() == Some(&'\n') {
                    it.next();
                }
            }
            'x' | 'u' => {
                let mut digits = String::new();
                if e == 'u' && it.peek() == Some(&'{') {
                    it.next();
                    for c in it.by_ref() {
                        if c == '}' {
                            break;
                        }
                        digits.push(c);
                    }
                } else {
                    for _ in 0..if e == 'x' { 2 } else { 4 } {
                        digits.push(it.next()?);
                    }
                }
                let value = u32::from_str_radix(&digits, 16).ok()?;
                out.push(char::from_u32(value)?);
            }
            _ => out.push(e),
        }
    }
    Some(out)
}
fn walk(node: tree_sitter::Node<'_>, source: &str, out: &mut Parsed) {
    let mut pending = vec![node];
    while let Some(node) = pending.pop() {
        match node.kind() {
            "import_statement" | "export_statement" => {
                if let Some(n) = node.child_by_field_name("source")
                    && let Some(s) = literal(n, source)
                {
                    out.static_imports.push(s);
                }
            }
            "import_require_clause" => {
                out.requires.push(
                    node.child_by_field_name("source")
                        .and_then(|n| literal(n, source)),
                );
            }
            "call_expression" => {
                if let Some(function) = node.child_by_field_name("function") {
                    let name = function.utf8_text(source.as_bytes()).unwrap_or("");
                    let args = node.child_by_field_name("arguments");
                    let value = args
                        .and_then(|a| a.named_child(0))
                        .and_then(|n| literal(n, source));
                    if name == "import" {
                        out.dynamic.push(value);
                    } else if name == "require" || name == "require.resolve" {
                        out.requires.push(value);
                    }
                }
            }
            _ => {}
        }
        let mut cursor = node.walk();
        let children = node.children(&mut cursor).collect::<Vec<_>>();
        pending.extend(children.into_iter().rev());
    }
}
pub fn parse(source: &str, path: &str) -> Parsed {
    let mut parser = tree_sitter::Parser::new();
    let lang = if path.ends_with(".tsx") || path.ends_with(".jsx") {
        tree_sitter_typescript::LANGUAGE_TSX
    } else {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT
    };
    if parser.set_language(&lang.into()).is_err() {
        return Parsed {
            errors: vec!["syntax-error".into()],
            ..Default::default()
        };
    }
    let Some(tree) = parser.parse(source, None) else {
        return Parsed {
            errors: vec!["syntax-error".into()],
            ..Default::default()
        };
    };
    let mut out = Parsed::default();
    walk(tree.root_node(), source, &mut out);
    let mut seen = BTreeSet::new();
    out.static_imports.retain(|s| seen.insert(s.clone()));
    if tree.root_node().has_error() {
        out.errors = lexical_errors(source);
        if out.errors.is_empty() {
            out.errors.push("syntax-error".into());
        }
    }
    out
}
fn lexical_errors(source: &str) -> Vec<String> {
    let bytes = source.as_bytes();
    let mut i = 0;
    let mut errors = Vec::new();
    while i < bytes.len() {
        match bytes[i] {
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                i += 2;
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i += 2;
                let mut end = false;
                while i + 1 < bytes.len() {
                    if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                        end = true;
                        i += 2;
                        break;
                    }
                    i += 1;
                }
                if !end {
                    errors.push("unterminated-block-comment".into());
                    break;
                }
            }
            q @ (b'\'' | b'"' | b'`') => {
                i += 1;
                let mut end = false;
                while i < bytes.len() {
                    if bytes[i] == b'\\' {
                        i = (i + 2).min(bytes.len());
                        continue;
                    }
                    if bytes[i] == q {
                        end = true;
                        i += 1;
                        break;
                    }
                    if q != b'`' && (bytes[i] == b'\n' || bytes[i] == b'\r') {
                        break;
                    }
                    i += 1;
                }
                if !end {
                    errors.push(
                        if q == b'`' {
                            "unterminated-template-literal"
                        } else {
                            "unterminated-string-literal"
                        }
                        .into(),
                    );
                }
            }
            _ => i += 1,
        }
    }
    errors
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn excludes_noise_and_includes_type_imports() {
        let p = parse(
            "import type {A} from './a'; const r=/import fake/; const v=<p>import fake from './fake'</p>; const d=import('./lazy'); require.resolve('./req');",
            "a.tsx",
        );
        assert_eq!(p.static_imports, vec!["./a"]);
        assert_eq!(p.dynamic, vec![Some("./lazy".into())]);
        assert_eq!(p.requires, vec![Some("./req".into())]);
        assert!(p.errors.is_empty(), "{:?}", p.errors);
    }
}
