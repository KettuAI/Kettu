//! kettu-ios-device: streams a physical iPhone or iPad's screen and injects its input for
//! Kettu's device host, over CoreDevice's display and HID services (iOS 27 and later).

mod depacketize;
mod error;
mod framing;
mod input;
mod list;
mod params;
mod session;
mod stream;
mod video;

use std::process::ExitCode;
use std::time::Duration;

use serde_json::json;

use crate::framing::Output;

const USAGE: &str = "usage: kettu-ios-device list\n       kettu-ios-device stream --udid <UDID>";

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("cannot start the async runtime")
}

fn stream(udid: &str) -> ExitCode {
    let runtime = runtime();
    let (shutdown_sender, shutdown) = tokio::sync::mpsc::unbounded_channel();
    let (out, thread) = Output::start(shutdown_sender.clone());
    let result = runtime.block_on(stream::run(udid, &out, shutdown_sender, shutdown));
    let code = match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            out.status(json!({ "type": "error", "code": error.code, "message": error.message }));
            ExitCode::FAILURE
        }
    };
    drop(out);
    thread.finish();
    runtime.shutdown_timeout(Duration::from_millis(500));
    code
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["list"] => {
            let devices = runtime().block_on(list::list());
            println!("{devices}");
            ExitCode::SUCCESS
        }
        ["stream", "--udid", udid] => stream(udid),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}
