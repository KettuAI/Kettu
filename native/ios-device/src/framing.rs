//! The stdio framing: a 4-byte big-endian length, then a tag byte and its payload.

use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::time::Duration;

use serde::Deserialize;
use tokio::sync::mpsc::UnboundedSender;

pub const TAG_DESCRIPTION: u8 = 0x01;
pub const TAG_KEYFRAME: u8 = 0x02;
pub const TAG_DELTA: u8 = 0x03;
pub const TAG_SCREEN: u8 = 0x10;
pub const TAG_STATUS: u8 = 0x11;

const TAG_TOUCH: u8 = 0x03;
const TAG_BUTTON: u8 = 0x04;
const TAG_KEY: u8 = 0x06;
const TAG_REQUEST_KEYFRAME: u8 = 0x08;

/// Host messages are small JSON objects; anything longer means the stream is broken.
const MAX_HOST_FRAME: usize = 64 * 1024;

/// Access units waiting for stdout, the one being written included. Past this a new one is
/// dropped instead of queued, so a stalled reader never builds up latency.
const MAX_QUEUED_MEDIA: usize = 2;

#[derive(Debug)]
pub enum Shutdown {
    StdinClosed,
    OutputClosed,
    Signal,
    HostProtocol(String),
}

pub fn encode(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.extend_from_slice(&((payload.len() + 1) as u32).to_be_bytes());
    out.push(tag);
    out.extend_from_slice(payload);
    out
}

enum Queued {
    Frame { bytes: Vec<u8>, media: bool },
    Close,
}

/// Framed messages to stdout, written by a thread of their own so a slow reader never blocks
/// the stream; control messages always queue, access units drop once the queue is full.
#[derive(Clone)]
pub struct Output {
    tx: mpsc::Sender<Queued>,
    queued_media: Arc<AtomicUsize>,
}

pub struct OutputThread {
    tx: mpsc::Sender<Queued>,
    done: mpsc::Receiver<()>,
}

impl Output {
    pub fn start(closed: UnboundedSender<Shutdown>) -> (Output, OutputThread) {
        let (tx, rx) = mpsc::channel::<Queued>();
        let (done_tx, done) = mpsc::channel::<()>();
        let queued_media = Arc::new(AtomicUsize::new(0));
        let counter = queued_media.clone();
        std::thread::spawn(move || {
            let stdout = std::io::stdout();
            let mut stdout = stdout.lock();
            while let Ok(item) = rx.recv() {
                let Queued::Frame { bytes, media } = item else {
                    break;
                };
                let written = stdout.write_all(&bytes).and_then(|()| stdout.flush());
                if media {
                    counter.fetch_sub(1, Ordering::AcqRel);
                }
                if written.is_err() {
                    let _ = closed.send(Shutdown::OutputClosed);
                    break;
                }
            }
            let _ = stdout.flush();
            let _ = done_tx.send(());
        });
        let thread = OutputThread {
            tx: tx.clone(),
            done,
        };
        (Output { tx, queued_media }, thread)
    }

    pub fn control(&self, tag: u8, payload: &[u8]) {
        let _ = self.tx.send(Queued::Frame {
            bytes: encode(tag, payload),
            media: false,
        });
    }

    pub fn json(&self, tag: u8, value: &serde_json::Value) {
        self.control(tag, value.to_string().as_bytes());
    }

    pub fn status(&self, value: serde_json::Value) {
        self.json(TAG_STATUS, &value);
    }

    /// Queues an access unit, or returns false when the reader is too far behind.
    pub fn media(&self, tag: u8, payload: &[u8]) -> bool {
        if self.queued_media.fetch_add(1, Ordering::AcqRel) >= MAX_QUEUED_MEDIA {
            self.queued_media.fetch_sub(1, Ordering::AcqRel);
            return false;
        }
        let sent = self.tx.send(Queued::Frame {
            bytes: encode(tag, payload),
            media: true,
        });
        if sent.is_err() {
            self.queued_media.fetch_sub(1, Ordering::AcqRel);
            return false;
        }
        true
    }
}

impl OutputThread {
    /// Writes what is queued, waiting a bounded time so a host that stopped reading cannot
    /// keep the process alive.
    pub fn finish(self) {
        let _ = self.tx.send(Queued::Close);
        let _ = self.done.recv_timeout(Duration::from_secs(2));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TouchPhase {
    Begin,
    Move,
    End,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Touch {
    #[serde(rename = "type")]
    pub phase: TouchPhase,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub id: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Button {
    Home,
    Lock,
    VolumeUp,
    VolumeDown,
    Siri,
}

#[derive(Debug, Clone, Deserialize)]
struct ButtonMessage {
    button: Button,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyPhase {
    Down,
    Up,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Key {
    #[serde(rename = "type")]
    pub phase: KeyPhase,
    pub usage: u16,
}

#[derive(Debug)]
pub enum HostInput {
    Touch(Touch),
    Button(Button),
    Key(Key),
}

/// Reads host frames from stdin on a thread of its own until EOF.
pub fn spawn_stdin_reader(
    input: UnboundedSender<HostInput>,
    keyframes: UnboundedSender<()>,
    shutdown: UnboundedSender<Shutdown>,
) {
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut stdin = stdin.lock();
        let reason = loop {
            let mut header = [0u8; 4];
            if let Err(error) = stdin.read_exact(&mut header) {
                break match error.kind() {
                    ErrorKind::UnexpectedEof => Shutdown::StdinClosed,
                    _ => Shutdown::HostProtocol(format!("reading stdin failed: {error}")),
                };
            }
            let length = u32::from_be_bytes(header) as usize;
            if length > MAX_HOST_FRAME {
                break Shutdown::HostProtocol(format!(
                    "a host frame of {length} bytes is too long"
                ));
            }
            let mut frame = vec![0u8; length];
            if let Err(error) = stdin.read_exact(&mut frame) {
                break match error.kind() {
                    ErrorKind::UnexpectedEof => Shutdown::StdinClosed,
                    _ => Shutdown::HostProtocol(format!("reading stdin failed: {error}")),
                };
            }
            let Some((&tag, body)) = frame.split_first() else {
                continue;
            };
            dispatch(tag, body, &input, &keyframes);
        };
        let _ = shutdown.send(reason);
    });
}

fn dispatch(
    tag: u8,
    body: &[u8],
    input: &UnboundedSender<HostInput>,
    keyframes: &UnboundedSender<()>,
) {
    let parsed = match tag {
        TAG_TOUCH => serde_json::from_slice::<Touch>(body).map(HostInput::Touch),
        TAG_BUTTON => {
            serde_json::from_slice::<ButtonMessage>(body).map(|m| HostInput::Button(m.button))
        }
        TAG_KEY => serde_json::from_slice::<Key>(body).map(HostInput::Key),
        TAG_REQUEST_KEYFRAME => {
            let _ = keyframes.send(());
            return;
        }
        _ => {
            eprintln!("ignoring host frame with tag {tag:#04x}");
            return;
        }
    };
    match parsed {
        Ok(message) => {
            let _ = input.send(message);
        }
        Err(error) => eprintln!("ignoring malformed host frame {tag:#04x}: {error}"),
    }
}
