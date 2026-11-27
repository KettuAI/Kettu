// Carries a stdio MCP client to a server Kettu runs: one HTTP upgrade on Kettu's loopback
// service, then the client's lines both ways, unchanged. Standard library only.

use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::thread;
use std::time::Duration;

const URL_ENV: &str = "KETTU_MCP_URL";
const TOKEN_ENV: &str = "KETTU_MCP_TOKEN";
/// Set in the processes of Kettu's own sessions, so an entry Kettu wrote into an agent's file is
/// not run a second time beside the copy the session was handed.
const SESSION_ENV: &str = "KETTU_MCP_SESSION";
/// What Kettu writes into its data folder each time it starts, for the entries in agents' files.
const CONNECT_FILE: &str = "mcp-bridge.txt";
const CONNECT_HEADER: &str = "kettu-mcp-bridge 1";
const CONNECT_LIMIT: u64 = 4 * 1024;
const NOT_RUNNING: &str = "Kettu is not running. Open Kettu, then reconnect this server.";
const UPGRADE: &str = "kettu-mcp";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const HEAD_LIMIT: usize = 16 * 1024;
const BODY_LIMIT: usize = 4 * 1024;

const USAGE: &str =
    "Usage: kettu-mcp-bridge mcp connect <server> [--agent <agent>] [--data <folder>]

Connects an MCP client that speaks stdio to a server Kettu runs. Kettu writes this command into
the client's configuration. Its own sessions start it with KETTU_MCP_URL and KETTU_MCP_TOKEN; a
terminal finds where to connect in Kettu's data folder, which --data names when it is not the
desktop app's own.";

struct Args {
    server: String,
    agent: Option<String>,
    data: Option<PathBuf>,
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
    let mut data = None;
    let mut rest = args[2..].iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--agent" => agent = Some(rest.next().ok_or("--agent needs a value")?.clone()),
            "--data" => data = Some(PathBuf::from(rest.next().ok_or("--data needs a value")?)),
            "-h" | "--help" => return Ok(None),
            other if other.starts_with('-') => return Err(format!("unknown option {other}")),
            other if server.is_none() => server = Some(other.to_string()),
            other => return Err(format!("unexpected argument {other}")),
        }
    }
    let server = server.ok_or("no server named")?;
    Ok(Some(Args {
        server,
        agent,
        data,
    }))
}

/// Where the desktop app keeps its data by default, as Electron names its folder.
fn default_data() -> Option<PathBuf> {
    let home = env::var_os("HOME").map(PathBuf::from);
    if cfg!(target_os = "macos") {
        return home.map(|home| {
            home.join("Library")
                .join("Application Support")
                .join("Kettu")
        });
    }
    if cfg!(windows) {
        return env::var_os("APPDATA").map(|dir| PathBuf::from(dir).join("Kettu"));
    }
    let config = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .or_else(|| home.map(|home| home.join(".config")))?;
    Some(config.join("Kettu"))
}

/// Where a terminal connects: the URL and key Kettu wrote at its start.
struct Target {
    url: String,
    key: String,
}

/// The connect file's text: a header line, then `url=` and `key=` lines.
fn parse_connect(text: &str) -> Option<Target> {
    let mut lines = text.lines();
    if lines.next()? != CONNECT_HEADER {
        return None;
    }
    let mut url = None;
    let mut key = None;
    for line in lines {
        if let Some(value) = line.strip_prefix("url=") {
            url = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("key=") {
            key = Some(value.to_string());
        }
    }
    Some(Target {
        url: url?,
        key: key?,
    })
}

/// A file only its owner may read and write; a key others can read is no key.
#[cfg(unix)]
fn private_file(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o077 == 0
}

#[cfg(not(unix))]
fn private_file(_meta: &fs::Metadata) -> bool {
    true
}

/// The connect file, which is not there when Kettu has not started since it was installed.
fn read_connect(folder: &Path) -> Result<Target, String> {
    let file = folder.join(CONNECT_FILE);
    let meta = match fs::symlink_metadata(&file) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(NOT_RUNNING.into()),
        Err(error) => return Err(format!("cannot read {}: {error}", file.display())),
    };
    if !meta.is_file() || meta.len() > CONNECT_LIMIT {
        return Err(format!("{} is not Kettu's file", file.display()));
    }
    if !private_file(&meta) {
        return Err(format!(
            "{} can be read by others, so it is not used",
            file.display()
        ));
    }
    let text = fs::read_to_string(&file)
        .map_err(|error| format!("cannot read {}: {error}", file.display()))?;
    parse_connect(&text).ok_or_else(|| format!("{} is not Kettu's file", file.display()))
}

/// The port of a loopback `http://` URL; the token never goes anywhere else.
fn loopback_port(url: &str) -> Result<u16, String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or("Kettu's URL must be an http:// URL")?;
    let authority = rest.split('/').next().unwrap_or("");
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or("Kettu's URL has no port")?;
    if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
        return Err("Kettu's URL must be on this computer".into());
    }
    port.parse::<u16>()
        .map_err(|_| "Kettu's URL has no valid port".to_string())
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
    !text
        .bytes()
        .any(|byte| byte == b'\r' || byte == b'\n' || byte == 0)
}

/// Reads the answer's head a byte at a time, so nothing after it is taken from the stream.
fn read_head(stream: &mut TcpStream) -> io::Result<String> {
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= HEAD_LIMIT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the answer's head is too long",
            ));
        }
        if stream.read(&mut byte)? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Kettu closed the connection",
            ));
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
            name.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().ok())?
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

/// Where to connect and with which token: a session's environment, else the connect file.
fn target(args: &Args) -> Result<(Target, bool), String> {
    match (env::var(URL_ENV), env::var(TOKEN_ENV)) {
        (Ok(url), Ok(key)) => Ok((Target { url, key }, false)),
        (Ok(_), Err(_)) => Err(format!(
            "{TOKEN_ENV} is not set; Kettu starts this command with it"
        )),
        (Err(_), Ok(_)) => Err(format!(
            "{URL_ENV} is not set; Kettu starts this command with it"
        )),
        (Err(_), Err(_)) => {
            let folder = args
                .data
                .clone()
                .or_else(default_data)
                .ok_or("cannot tell where Kettu keeps its data; pass --data")?;
            Ok((read_connect(&folder)?, true))
        }
    }
}

fn connect(args: &Args) -> Result<TcpStream, String> {
    let (Target { url, key: token }, terminal) = target(args)?;
    let port = loopback_port(&url)?;
    if !header_safe(&token) || token.is_empty() {
        return Err("Kettu's key is not a token".into());
    }
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).map_err(|error| {
        match error.kind() {
            io::ErrorKind::ConnectionRefused | io::ErrorKind::TimedOut => NOT_RUNNING.to_string(),
            _ => format!("cannot reach Kettu: {error}"),
        }
    })?;
    let _ = stream.set_nodelay(true);
    let cwd = env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut request = format!(
        "GET /bridge/{} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: Upgrade\r\n\
         Upgrade: {UPGRADE}\r\nAuthorization: Bearer {token}\r\nKettu-Cwd: {}\r\n",
        encode(&args.server),
        encode(&cwd),
    );
    if let Some(agent) = &args.agent {
        request.push_str(&format!("Kettu-Agent: {}\r\n", encode(agent)));
    }
    if terminal && env::var_os(SESSION_ENV).is_some() {
        request.push_str("Kettu-Session: 1\r\n");
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
                format!(
                    "status {}",
                    status.map(|s| s.to_string()).unwrap_or_default()
                )
            } else {
                reason
            };
            Err(format!(
                "Kettu refused the connection to {}: {reason}",
                args.server
            ))
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
        assert!(args.data.is_none());
        let args = parse(&strings(&["mcp", "connect", "a", "--data", "/tmp/k"]))
            .unwrap()
            .unwrap();
        assert_eq!(args.data.as_deref(), Some(Path::new("/tmp/k")));
        assert!(parse(&strings(&["mcp", "connect", "a", "--data"])).is_err());
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
    fn reads_the_connect_file() {
        let target = parse_connect("kettu-mcp-bridge 1\nurl=http://127.0.0.1:4100\nkey=abc\n");
        let target = target.unwrap();
        assert_eq!(target.url, "http://127.0.0.1:4100");
        assert_eq!(target.key, "abc");
        assert!(parse_connect("url=http://127.0.0.1:4100\nkey=abc\n").is_none());
        assert!(parse_connect("kettu-mcp-bridge 1\nurl=http://127.0.0.1:4100\n").is_none());
    }

    fn folder(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("kettu-bridge-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn says_kettu_is_not_running_without_the_file() {
        let dir = folder("missing");
        assert_eq!(read_connect(&dir).err().as_deref(), Some(NOT_RUNNING));
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn uses_the_file_only_when_others_cannot_read_it() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = folder("modes");
        let file = dir.join(CONNECT_FILE);
        fs::write(
            &file,
            "kettu-mcp-bridge 1\nurl=http://127.0.0.1:4100\nkey=abc\n",
        )
        .unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_connect(&dir).is_err());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_connect(&dir).unwrap().key, "abc");
        let other = folder("link");
        symlink(&file, other.join(CONNECT_FILE)).unwrap();
        assert!(read_connect(&other).is_err());
        fs::remove_dir_all(dir).unwrap();
        fs::remove_dir_all(other).unwrap();
    }

    #[test]
    fn encodes_what_could_break_the_request() {
        assert_eq!(encode("my server/../x"), "my%20server%2F..%2Fx");
        assert_eq!(encode("/Users/a b"), "%2FUsers%2Fa%20b");
        assert!(!header_safe("a\r\nX-Evil: 1"));
    }
}
