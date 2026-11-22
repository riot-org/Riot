//! LSP 的报文分帧：`Content-Length: N\r\n\r\n` + N 字节 JSON。
//!
//! 和 MCP 的按行分隔不是一回事 —— LSP 的正文里可以有换行（hover 的
//! markdown 原样塞在 JSON 字符串里，但格式化输出的服务器会在 JSON 里
//! 直接换行），所以只能按长度切。
//!
//! `[约束]` 正文长度必须有上限。语言服务器是外部进程，一个声明
//! `Content-Length: 99999999999` 的坏帧不能让我们照着去分配内存。超限
//! 的帧按长度读掉丢弃，连接保持对齐。

use tokio::io::{
    AsyncBufRead, AsyncBufReadExt as _, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _,
};

/// 单帧上限。rust-analyzer 对大仓库的 workspace/symbol 也就几 MB。
pub const MAX_FRAME: usize = 64 * 1024 * 1024;

/// 头部单行上限。正常的头只有 `Content-Length` 和 `Content-Type` 两行。
const MAX_HEADER_LINE: usize = 4096;

#[derive(Debug)]
pub enum Frame {
    Body(Vec<u8>),
    /// 超过 [`MAX_FRAME`]，已读掉丢弃。连接照常。
    TooLarge(usize),
    /// 流结束、读失败或头部损坏到无法继续对齐。
    Eof,
}

/// 读一帧。
pub async fn read_frame<R>(reader: &mut R) -> Frame
where
    R: AsyncBufRead + Unpin,
{
    let mut length: Option<usize> = None;
    let mut line = Vec::new();
    loop {
        line.clear();
        // 头部行很短；用 take 限住单行长度，防一条永不换行的垃圾吃内存。
        let mut limited = (&mut *reader).take(MAX_HEADER_LINE as u64);
        match limited.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => return Frame::Eof,
            Ok(_) => {}
        }
        if !line.ends_with(b"\n") {
            // 一行超过上限还没换行：已经无法对齐了。
            return Frame::Eof;
        }
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end_matches(['\r', '\n']);
        if text.is_empty() {
            // 空行 = 头部结束。没有长度的帧无法读正文，只能放弃这条连接。
            break;
        }
        if let Some((k, v)) = text.split_once(':')
            && k.trim().eq_ignore_ascii_case("content-length")
        {
            length = v.trim().parse().ok();
        }
    }
    let Some(len) = length else {
        return Frame::Eof;
    };
    if len > MAX_FRAME {
        let mut sink = (&mut *reader).take(len as u64);
        if tokio::io::copy(&mut sink, &mut tokio::io::sink())
            .await
            .is_err()
        {
            return Frame::Eof;
        }
        return Frame::TooLarge(len);
    }
    let mut body = vec![0u8; len];
    if reader.read_exact(&mut body).await.is_err() {
        return Frame::Eof;
    }
    Frame::Body(body)
}

/// 写一帧。
pub async fn write_frame<W>(writer: &mut W, body: &[u8]) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    writer.write_all(header.as_bytes()).await?;
    writer.write_all(body).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn read_all(bytes: &[u8]) -> Vec<Frame> {
        let mut r = tokio::io::BufReader::new(bytes);
        let mut out = Vec::new();
        loop {
            let f = read_frame(&mut r).await;
            let eof = matches!(f, Frame::Eof);
            out.push(f);
            if eof {
                break;
            }
        }
        out
    }

    #[tokio::test]
    async fn 正文里的换行不影响分帧() {
        let body = b"{\"a\":\n\"x\"}";
        let mut buf = Vec::new();
        write_frame(&mut buf, body).await.unwrap();
        write_frame(&mut buf, b"{}").await.unwrap();
        let frames = read_all(&buf).await;
        assert!(matches!(&frames[0], Frame::Body(b) if b == body));
        assert!(matches!(&frames[1], Frame::Body(b) if b == b"{}"));
        assert!(matches!(frames[2], Frame::Eof));
    }

    #[tokio::test]
    async fn 认额外的头和大小写() {
        let raw = b"content-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}";
        let frames = read_all(raw).await;
        assert!(matches!(&frames[0], Frame::Body(b) if b == b"{}"));
    }

    #[tokio::test]
    async fn 超大帧丢弃后连接仍对齐() {
        let mut raw = format!("Content-Length: {}\r\n\r\n", MAX_FRAME + 1).into_bytes();
        raw.extend(std::iter::repeat_n(b'x', MAX_FRAME + 1));
        raw.extend(b"Content-Length: 2\r\n\r\n{}");
        let frames = read_all(&raw).await;
        assert!(matches!(frames[0], Frame::TooLarge(_)));
        assert!(matches!(&frames[1], Frame::Body(b) if b == b"{}"));
    }

    #[tokio::test]
    async fn 没有长度的帧结束连接() {
        let frames = read_all(b"X-Foo: 1\r\n\r\n{}").await;
        assert!(matches!(frames[0], Frame::Eof));
    }
}
