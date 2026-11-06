//! `stream`: one device's screen and input over the stdio framing until stdin closes.

use std::time::Duration;

use idevice::IdeviceService;
use idevice::provider::UsbmuxdProvider;
use idevice::springboardservices::{InterfaceOrientation, SpringBoardServicesClient};
use serde_json::json;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::sync::watch;

use crate::error::HelperError;
use crate::framing::{Output, Shutdown, spawn_stdin_reader};
use crate::input::Input;
use crate::session;
use crate::video::{self, Orientation};

/// The device's HID surfaces are re-matched against the newly authenticated stream a moment
/// after it starts; events sent before that are dropped.
const HID_SETTLE: Duration = Duration::from_millis(300);
const STOP_TIMEOUT: Duration = Duration::from_millis(1500);
const ORIENTATION_POLL: Duration = Duration::from_secs(1);

fn finished(reason: Option<Shutdown>) -> Result<(), HelperError> {
    match reason {
        Some(Shutdown::HostProtocol(message)) => Err(HelperError::internal(message)),
        Some(reason) => {
            eprintln!("stopping: {reason:?}");
            Ok(())
        }
        None => Ok(()),
    }
}

/// Polls SpringBoard's interface orientation; without SpringBoard the frame's shape decides.
async fn watch_orientation(provider: UsbmuxdProvider, sender: watch::Sender<Option<Orientation>>) {
    let connected = tokio::time::timeout(
        Duration::from_secs(5),
        SpringBoardServicesClient::connect(&provider),
    )
    .await;
    let mut client = match connected {
        Ok(Ok(client)) => client,
        Ok(Err(error)) => {
            eprintln!("orientation follows the frame: {error}");
            return std::future::pending().await;
        }
        Err(_) => {
            eprintln!("orientation follows the frame: SpringBoard did not answer");
            return std::future::pending().await;
        }
    };
    let mut ticks = tokio::time::interval(ORIENTATION_POLL);
    loop {
        ticks.tick().await;
        let orientation =
            match tokio::time::timeout(Duration::from_secs(2), client.get_interface_orientation())
                .await
            {
                Ok(Ok(orientation)) => orientation,
                Ok(Err(error)) => {
                    eprintln!("orientation follows the frame: {error}");
                    return std::future::pending().await;
                }
                Err(_) => continue,
            };
        let orientation = match orientation {
            InterfaceOrientation::Portrait => Some(Orientation::Portrait),
            InterfaceOrientation::PortraitUpsideDown => Some(Orientation::PortraitUpsideDown),
            InterfaceOrientation::LandscapeLeft => Some(Orientation::LandscapeLeft),
            InterfaceOrientation::LandscapeRight => Some(Orientation::LandscapeRight),
            InterfaceOrientation::Unknown => None,
        };
        sender.send_if_modified(|current| {
            let changed = *current != orientation;
            *current = orientation;
            changed
        });
    }
}

pub async fn run(
    udid: &str,
    out: &Output,
    shutdown_sender: UnboundedSender<Shutdown>,
    mut shutdown: UnboundedReceiver<Shutdown>,
) -> Result<(), HelperError> {
    let (input_sender, mut input) = unbounded_channel();
    let (keyframe_sender, mut keyframes) = unbounded_channel();
    spawn_stdin_reader(input_sender, keyframe_sender, shutdown_sender.clone());
    tokio::spawn(async move {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
        let terminated = async {
            match terminate.as_mut() {
                Some(signal) => {
                    signal.recv().await;
                }
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            () = terminated => {}
        }
        let _ = shutdown_sender.send(Shutdown::Signal);
    });

    // Local and quick, so a missing device is reported even when stdin is already closed.
    let provider = session::find_device(udid).await?;
    let mut session = tokio::select! {
        session = session::open(provider) => session?,
        reason = shutdown.recv() => return finished(reason),
    };
    out.status(json!({ "type": "ready" }));

    let mut hid: Option<Input> = None;
    let input_loop = async {
        tokio::time::sleep(HID_SETTLE).await;
        let connected = Input::connect(&mut session.adapter, &mut session.handshake).await;
        out.status(json!({ "type": "input", "available": connected.available() }));
        hid.insert(connected).run(&mut input, out).await
    };
    let (orientation_sender, mut orientation) = watch::channel(None);
    let outcome = tokio::select! {
        result = video::run(&session.video_udp, session.video, out, &mut keyframes, &mut orientation) => result,
        result = video::keep_audio(&session.audio_udp, session.audio) => result,
        () = input_loop => Ok(()),
        () = watch_orientation(session.provider.clone(), orientation_sender) => Ok(()),
        reason = shutdown.recv() => finished(reason),
    };

    if let Some(hid) = hid.as_mut() {
        hid.cleanup().await;
    }
    match tokio::time::timeout(STOP_TIMEOUT, session.display.stop_media_stream()).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => eprintln!("stopping the stream failed: {error}"),
        Err(_) => eprintln!("stopping the stream timed out"),
    }
    outcome
}
