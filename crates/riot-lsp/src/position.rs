//! 位置换算。
//!
//! 模型给的是「第几行（1 起）+ 这行里的哪个符号」，LSP 要的是
//! 「第几行（0 起）+ 第几个编码单元」。编码单元默认是 **UTF-16**：
//! 一行里有中文注释或 emoji 时，按字节或按字符算出来的列都会错位，
//! 跳转落到别的符号上，而且不报错。
//!
//! 握手时我们声明 utf-8 优先（rust-analyzer、较新的服务器都支持），
//! 服务器不接受就按 utf-16 换算。两种都只在这一个模块里出现。

/// 服务器协商出的列编码。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Utf16,
}

impl Encoding {
    pub fn from_server(name: Option<&str>) -> Self {
        match name {
            Some("utf-8") => Encoding::Utf8,
            // 规范：没声明就是 utf-16。utf-32 我们没声明支持，服务器不会选。
            _ => Encoding::Utf16,
        }
    }
}

/// 字符下标（0 起，按 Unicode 标量计）→ 服务器的列。
pub fn to_server_col(line: &str, char_idx: usize, enc: Encoding) -> u32 {
    let prefix = line.chars().take(char_idx);
    let n: usize = match enc {
        Encoding::Utf8 => prefix.map(char::len_utf8).sum(),
        Encoding::Utf16 => prefix.map(char::len_utf16).sum(),
    };
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// 服务器的列 → 字符下标（0 起）。超出行尾的夹到行尾。
pub fn from_server_col(line: &str, col: u32, enc: Encoding) -> usize {
    let mut units = 0usize;
    for (i, ch) in line.chars().enumerate() {
        if units >= col as usize {
            return i;
        }
        units += match enc {
            Encoding::Utf8 => ch.len_utf8(),
            Encoding::Utf16 => ch.len_utf16(),
        };
    }
    line.chars().count()
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// 在一行里找符号，返回它起点的字符下标（0 起）。
///
/// 优先取「整词」出现（两侧不是标识符字符）—— `foo` 不该落在
/// `foobar` 里；没有整词出现才退回第一处子串。`occurrence` 是 1 起的
/// 第几次整词出现（同一行 `a.len() + b.len()` 要第二个 `len`）。
pub fn find_symbol(line: &str, symbol: &str, occurrence: usize) -> Option<usize> {
    if symbol.is_empty() {
        return None;
    }
    let chars: Vec<char> = line.chars().collect();
    let sym: Vec<char> = symbol.chars().collect();
    let mut first_any = None;
    let mut seen = 0usize;
    if chars.len() < sym.len() {
        return None;
    }
    for start in 0..=chars.len() - sym.len() {
        if chars[start..start + sym.len()] != sym[..] {
            continue;
        }
        first_any.get_or_insert(start);
        let before_ok = start == 0 || !is_ident(chars[start - 1]);
        let end = start + sym.len();
        let after_ok = end == chars.len() || !is_ident(chars[end]);
        if before_ok && after_ok {
            seen += 1;
            if seen == occurrence.max(1) {
                return Some(start);
            }
        }
    }
    if seen == 0 { first_any } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 中文和_emoji_前缀下列号按编码换算() {
        let line = "let 名字 = \"😀\"; foo();";
        let idx = find_symbol(line, "foo", 1).unwrap();
        // 字符下标
        assert_eq!(idx, 14);
        // utf-8：`let ` 4 + 名字 6 + ` = ` 3 + `"` 1 + 😀 4 + `"; ` 3
        assert_eq!(to_server_col(line, idx, Encoding::Utf8), 21);
        // utf-16：名字 各 1 个码元，😀 2 个
        assert_eq!(to_server_col(line, idx, Encoding::Utf16), 15);
        for enc in [Encoding::Utf8, Encoding::Utf16] {
            let col = to_server_col(line, idx, enc);
            assert_eq!(from_server_col(line, col, enc), idx);
        }
    }

    #[test]
    fn 整词优先_不落进更长的标识符() {
        let line = "foobar(foo)";
        assert_eq!(find_symbol(line, "foo", 1), Some(7));
        assert_eq!(find_symbol("a.len() + b.len()", "len", 2), Some(12));
        assert_eq!(find_symbol("a.len()", "len", 2), None);
        // 没有整词出现时退回子串（模型给了半个名字）
        assert_eq!(find_symbol("foobar()", "foo", 1), Some(0));
        assert_eq!(find_symbol("bar()", "foo", 1), None);
    }

    #[test]
    fn 列超出行尾时夹到行尾() {
        assert_eq!(from_server_col("abc", 99, Encoding::Utf16), 3);
    }
}
