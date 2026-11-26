// Carries a stdio MCP client to a server Kettu runs: one HTTP upgrade on Kettu's loopback
// service, then the client's lines both ways, unchanged. Standard library only.

use std::env;
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::process::ExitCode;
use std::thread;
use std::time::Duration;

const URL_ENV: &str = "KETTU_MCP_URL";
const TOKEN_ENV: &str = "KETTU_MCP_TOKEN";
const UPGRADE: &str = "kettu-mcp";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const HEAD_LIMIT: usize = 16 * 1024;
const BODY_LIMIT: usize = 4 * 1024;

const USAGE: &str = "Usage: kettu-mcp-bridge mcp connect <server> [--agent <agent>]

Connects an MCP client that speaks stdio to a server Kettu runs. Kettu writes this command into
the client's configuration, with KETTU_MCP_URL and KETTU_MCP_TOKEN in its environment.";

struct Args {
    server: String,
    agent: Option<String>,
}

fn parse(args: &[String]) -> Result<Option<Args>, String> {
    match args.first().map(String::as_str) {
        Some("-h") | Some("--help") => return Ok(None),
        Some("mcp") => {}
        _ => return Err("expected `mcp connect <server>`".into()),
    }
    if args.get(1).map(String::as_str) != Some("connect") {
        return Err("expected `mcp connect <server>`".into());
    }
    let mut server = None;
    let mut agent = None;
    let mut rest = args[2..].iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--agent" => agent = Some(rest.next().ok_or("--agent needs a value")?.clone()),
            "-h" | "--help" => return Ok(None),
            other if other.starts_with('-') => return Err(format!("unknown option {other}")),
            other if server.is_none() => server = Some(other.to_string()),
            other => return Err(format!("unexpected argument {other}")),
        }
    }
    let server = server.ok_or("no server named")?;
    Ok(Some(Args { server, agent }))
}

/// The port of a loopback `http://` URL; the token never goes anywhere else.
fn loopback_port(url: &str) -> Result<u16, String> {
    let rest = url.strip_prefix("http://").ok_or("KETTU_MCP_URL must be an http:// URL")?;
    let authority = rest.split('/').next().unwrap_or("");
    let (host, port) = authority.rsplit_once(':').ok_or("KETTU_MCP_URL has no port")?;
    if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
        return Err("KETTU_MCP_URL must be on this computer".into());
    }
    port.parse::<u16>().map_err(|_| "KETTU_MCP_URL has no valid port".to_string())
}

/// Percent-encoding of everything but the unreserved characters, for a path or a header.
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A header value without anything that could end the header.
fn header_safe(text: &str) -> bool {
    !text.bytes().any(|byte| byte == b'\r' || byte == b'\n' || byte == 0)
}

/// Reads the answer's head a byte at a time, so nothing after it is taken from the stream.
fn read_head(stream: &mut TcpStream) -> io::Result<String> {
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= HEAD_LIMIT {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "the answer's head is too long"));
        }
        if stream.read(&mut byte)? == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "Kettu closed the connection"));
        }
        head.push(byte[0]);
    }
    Ok(String::from_utf8_lossy(&head).into_owned())
}

/// The refusal's text, which Kettu keeps to one short line.
fn read_reason(stream: &mut TcpStream, head: &str) -> String {
    let length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim().eq_ignore_ascii_case("content-length").then(|| value.trim().parse().ok())?
        })
        .unwrap_or(0usize)
        .min(BODY_LIMIT);
    let mut body = vec![0u8; length];
    let _ = stream.read_exact(&mut body);
    String::from_utf8_lossy(&body).trim().to_string()
}

fn status_of(head: &str) -> Option<u16> {
    head.split_whitespace().nth(1)?.parse().ok()
}

fn connect(args: &Args) -> Result<TcpStream, String> {
    let url = env::var(URL_ENV).map_err(|_| {
        format!("{URL_ENV} is not set; Kettu starts this command with it")
    })?;
    let token = env::var(TOKEN_ENV).map_err(|_| {
        format!("{TOKEN_ENV} is not set; Kettu starts this command with it")
    })?;
    let port = loopback_port(&url)?;
    if !header_safe(&token) || token.is_empty() {
        return Err(format!("{TOKEN_ENV} is not a token"));
    }
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).map_err(|error| {
        match error.kind() {
            io::ErrorKind::ConnectionRefused | io::ErrorKind::TimedOut => {
                "Kettu is not running; open Kettu, then reconnect this MCP server".to_string()
            }
            _ => format!("cannot reach Kettu: {error}"),
        }
    })?;
    let _ = stream.set_nodelay(true);
    let cwd = env::current_dir().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default();
    let mut request = format!(
        "GET /bridge/{} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: Upgrade\r\n\
         Upgrade: {UPGRADE}\r\nAuthorization: Bearer {token}\r\nKettu-Cwd: {}\r\n",
        encode(&args.server),
        encode(&cwd),
    );
    if let Some(agent) = &args.agent {
        request.push_str(&format!("Kettu-Agent: {}\r\n", encode(agent)));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("cannot reach Kettu: {error}"))?;
    let head = read_head(&mut stream).map_err(|error| format!("cannot reach Kettu: {error}"))?;
    match status_of(&head) {
        Some(101) => Ok(stream),
        status => {
            let reason = read_reason(&mut stream, &head);
            let reason = if reason.is_empty() {
                format!("status {}", status.map(|s| s.to_string()).unwrap_or_default())
            } else {
                reason
            };
            Err(format!("Kettu refused the connection to {}: {reason}", args.server))
        }
    }
}

/// Copies from `from` to `to`, flushing each read so a line is never held back.
fn pump(mut from: impl Read, mut to: impl Write) -> io::Result<()> {
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = match from.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        to.write_all(&buffer[..read])?;
        to.flush()?;
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let args = match parse(&args) {
        Ok(Some(args)) => args,
        Ok(None) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            eprintln!("kettu-mcp-bridge: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let stream = match connect(&args) {
        Ok(stream) => stream,
        Err(message) => {
            eprintln!("kettu-mcp-bridge: {message}");
            return ExitCode::from(1);
        }
    };
    let upstream = match stream.try_clone() {
        Ok(clone) => clone,
        Err(error) => {
            eprintln!("kettu-mcp-bridge: {error}");
            return ExitCode::from(1);
        }
    };
    // The client's lines to Kettu; when the client closes stdin, Kettu hears the end.
    thread::spawn(move || {
        let _ = pump(io::stdin().lock(), &upstream);
        let _ = upstream.shutdown(Shutdown::Write);
    });
    // Kettu's lines to the client; the bridge ends when Kettu closes the connection.
    match pump(&stream, io::stdout().lock()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("kettu-mcp-bridge: the connection to Kettu ended: {error}");
            ExitCode::from(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn reads_the_command_kettu_writes() {
        let args = parse(&strings(&["mcp", "connect", "github", "--agent", "codex"])).unwrap();
        let args = args.unwrap();
        assert_eq!(args.server, "github");
        assert_eq!(args.agent.as_deref(), Some("codex"));
        assert!(parse(&strings(&["mcp", "list"])).is_err());
        assert!(parse(&strings(&["mcp", "connect"])).is_err());
        assert!(parse(&strings(&["mcp", "connect", "a", "b"])).is_err());
    }

    #[test]
    fn connects_only_to_this_computer() {
        assert_eq!(loopback_port("http://127.0.0.1:4100").unwrap(), 4100);
        assert_eq!(loopback_port("http://localhost:4100/").unwrap(), 4100);
        assert!(loopback_port("http://example.com:4100").is_err());
        assert!(loopback_port("https://127.0.0.1:4100").is_err());
        assert!(loopback_port("http://127.0.0.1.example.com:80").is_err());
    }

    #[test]
    fn encodes_what_could_break_the_request() {
        assert_eq!(encode("my server/../x"), "my%20server%2F..%2Fx");
        assert_eq!(encode("/Users/a b"), "%2FUsers%2Fa%20b");
        assert!(!header_safe("a\r\nX-Evil: 1"));
    }
}
