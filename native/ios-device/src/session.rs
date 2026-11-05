//! Finding the device, checking what the display service needs, and starting the media streams
//! over a userspace tunnel through usbmuxd.

use std::future::Future;
use std::time::Duration;

use idevice::core_device::{
    CallInfoBlob, DisplayServiceClient, build_screen_audio_offer, build_screen_video_offer,
    build_start_audio_parameters, build_start_video_parameters,
};
use idevice::core_device_proxy::CoreDeviceProxy;
use idevice::lockdown::LockdownClient;
use idevice::mobile_image_mounter::ImageMounter;
use idevice::provider::{IdeviceProvider, UsbmuxdProvider};
use idevice::rsd::RsdHandshake;
use idevice::tcp::handle::{AdapterHandle, UdpSocketHandle};
use idevice::usbmuxd::{Connection, UsbmuxdAddr};
use idevice::{IdeviceError, IdeviceService, ReadWrite, RsdService};

use crate::error::HelperError;

pub const LABEL: &str = "kettu-ios-device";
const DISPLAY_SERVICE: &str = "com.apple.coredevice.displayservice";
const MIN_MAJOR_VERSION: u32 = 27;

/// What we support as the controller, as Device Hub sends it; the device's own mask makes the
/// negotiator produce an invalid video configuration.
const CLIENT_SUPPORTED_FEATURES: u64 = 140;
/// The device's RTP sender ports. The device takes them from the request; any free value works.
const AUDIO_SENDER_PORT: u16 = 50000;
const VIDEO_SENDER_PORT: u16 = 50001;
const MAIN_DISPLAY: i64 = 1;

const STEP_TIMEOUT: Duration = Duration::from_secs(15);

/// RTCP addressing for one stream, from the device's `streamConfig`, whose names are from the
/// device's side: `LocalSSRC` is the device's, `RemoteSSRC` ours.
#[derive(Debug, Clone, Copy, Default)]
pub struct StreamConfig {
    pub source_port: Option<u16>,
    pub device_ssrc: Option<u32>,
    pub our_ssrc: Option<u32>,
}

pub struct Session {
    pub provider: UsbmuxdProvider,
    pub adapter: AdapterHandle,
    pub handshake: RsdHandshake,
    pub display: DisplayServiceClient<Box<dyn ReadWrite>>,
    pub audio_udp: UdpSocketHandle,
    pub video_udp: UdpSocketHandle,
    pub audio: StreamConfig,
    pub video: StreamConfig,
}

async fn step<T>(
    future: impl Future<Output = Result<T, IdeviceError>>,
    fail: impl FnOnce(String) -> HelperError,
    what: &str,
) -> Result<T, HelperError> {
    match tokio::time::timeout(STEP_TIMEOUT, future).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(fail(format!("{what}: {error}"))),
        Err(_) => Err(fail(format!("{what}: timed out"))),
    }
}

fn major_version(version: &str) -> Option<u32> {
    version.split('.').next()?.parse().ok()
}

/// The device's usbmuxd entry, over USB when it is connected both ways.
pub async fn find_device(udid: &str) -> Result<UsbmuxdProvider, HelperError> {
    let addr = UsbmuxdAddr::from_env_var()
        .map_err(|error| HelperError::internal(format!("bad USBMUXD_SOCKET_ADDRESS: {error}")))?;
    let mut mux = step(
        addr.connect(0),
        HelperError::no_device,
        "usbmuxd is not reachable",
    )
    .await?;
    let devices = step(
        mux.get_devices(),
        HelperError::no_device,
        "listing devices failed",
    )
    .await?;
    let device = devices
        .iter()
        .filter(|device| device.udid == udid)
        .min_by_key(|device| device.connection_type != Connection::Usb)
        .ok_or_else(|| {
            HelperError::no_device(format!("no device with UDID {udid} is connected"))
        })?;
    Ok(device.to_provider(addr, LABEL))
}

/// Checks the version, pairing, Developer Mode and the developer disk image before the tunnel,
/// so a missing step is named instead of surfacing as a failed connection.
async fn preflight(provider: &UsbmuxdProvider) -> Result<(), HelperError> {
    let pairing = step(
        provider.get_pairing_file(),
        HelperError::not_paired,
        "this computer has no pairing record for the device",
    )
    .await?;
    let mut lockdown = step(
        LockdownClient::connect(provider),
        HelperError::no_device,
        "cannot reach lockdownd",
    )
    .await?;
    let version = step(
        lockdown.get_value(Some("ProductVersion"), None),
        HelperError::no_device,
        "cannot read the iOS version",
    )
    .await?;
    if let Some(version) = version.as_string() {
        eprintln!("device runs iOS {version}");
        if major_version(version).is_some_and(|major| major < MIN_MAJOR_VERSION) {
            return Err(HelperError::unsupported_ios(format!(
                "screen streaming needs iOS {MIN_MAJOR_VERSION} or later; the device runs {version}"
            )));
        }
    }
    step(
        lockdown.start_session(&pairing),
        HelperError::not_paired,
        "the device does not trust this computer",
    )
    .await?;

    match tokio::time::timeout(STEP_TIMEOUT, ImageMounter::connect(provider)).await {
        Ok(Ok(mut mounter)) => {
            if let Ok(Ok(false)) =
                tokio::time::timeout(STEP_TIMEOUT, mounter.query_developer_mode_status()).await
            {
                return Err(HelperError::developer_mode_off(
                    "Developer Mode is off on the device",
                ));
            }
            if let Ok(Ok(images)) = tokio::time::timeout(STEP_TIMEOUT, mounter.copy_devices()).await
                && images.is_empty()
            {
                return Err(HelperError::ddi_not_mounted(
                    "no developer disk image is mounted on the device",
                ));
            }
        }
        Ok(Err(IdeviceError::DeveloperModeNotEnabled)) => {
            return Err(HelperError::developer_mode_off(
                "Developer Mode is off on the device",
            ));
        }
        Ok(Err(error)) => eprintln!("skipping the disk image check: {error}"),
        Err(_) => eprintln!("skipping the disk image check: timed out"),
    }
    Ok(())
}

fn start_error(what: &str, error: IdeviceError) -> HelperError {
    let detail = format!("{error:?}");
    // CoreDevice's code when a foreground app holds the camera or microphone.
    if detail.contains("9022") {
        HelperError::camera_in_use(format!(
            "{what}: an app on the device is using the camera or microphone"
        ))
    } else {
        HelperError::stream(format!("{what}: {error} ({detail})"))
    }
}

fn read_u64(dictionary: &plist::Dictionary, key: &str) -> Option<u64> {
    let value = dictionary.get(key)?;
    value.as_unsigned_integer().or_else(|| {
        value
            .as_signed_integer()
            .and_then(|v| u64::try_from(v).ok())
    })
}

fn stream_config(answer: &plist::Value, kind: &str) -> StreamConfig {
    let config = answer
        .as_dictionary()
        .and_then(|answer| answer.get("connection"))
        .and_then(plist::Value::as_dictionary)
        .and_then(|connection| connection.get("streamConfig"))
        .and_then(plist::Value::as_dictionary);
    let Some(config) = config else {
        eprintln!("{kind} answer has no streamConfig; RTCP waits for the first packet");
        return StreamConfig::default();
    };
    let parsed = StreamConfig {
        source_port: read_u64(config, "SourcePort").and_then(|v| u16::try_from(v).ok()),
        device_ssrc: read_u64(config, "LocalSSRC").and_then(|v| u32::try_from(v).ok()),
        our_ssrc: read_u64(config, "RemoteSSRC").and_then(|v| u32::try_from(v).ok()),
    };
    eprintln!("{kind} stream: {parsed:?}");
    parsed
}

pub async fn open(provider: UsbmuxdProvider) -> Result<Session, HelperError> {
    preflight(&provider).await?;

    let proxy = match tokio::time::timeout(STEP_TIMEOUT, CoreDeviceProxy::connect(&provider)).await
    {
        Ok(Ok(proxy)) => proxy,
        Ok(Err(IdeviceError::DeveloperModeNotEnabled)) => {
            return Err(HelperError::developer_mode_off(
                "Developer Mode is off on the device",
            ));
        }
        Ok(Err(error)) => {
            return Err(HelperError::tunnel(format!(
                "cannot start the CoreDevice tunnel: {error}"
            )));
        }
        Err(_) => {
            return Err(HelperError::tunnel(
                "starting the CoreDevice tunnel timed out",
            ));
        }
    };
    let rsd_port = proxy.tunnel_info().server_rsd_port;
    let mut adapter = proxy
        .create_software_tunnel()
        .map_err(|error| HelperError::tunnel(format!("cannot create the tunnel: {error}")))?
        .to_async_handle();
    let rsd = match tokio::time::timeout(STEP_TIMEOUT, adapter.connect(rsd_port)).await {
        Ok(Ok(stream)) => stream,
        Ok(Err(error)) => return Err(HelperError::tunnel(format!("cannot reach RSD: {error}"))),
        Err(_) => return Err(HelperError::tunnel("reaching RSD timed out")),
    };
    let mut handshake = step(
        RsdHandshake::new(rsd),
        HelperError::tunnel,
        "RSD handshake failed",
    )
    .await?;
    if !handshake.services.contains_key(DISPLAY_SERVICE) {
        return Err(HelperError::unsupported_ios(format!(
            "the device offers no {DISPLAY_SERVICE}"
        )));
    }

    let mut display = step(
        DisplayServiceClient::connect_rsd(&mut adapter, &mut handshake),
        HelperError::stream,
        "cannot connect to the display service",
    )
    .await?;
    let bind = |kind: &'static str| {
        let adapter = adapter.clone();
        async move {
            adapter.bind_udp(0).await.map_err(|error| {
                HelperError::tunnel(format!("cannot bind the {kind} port: {error}"))
            })
        }
    };
    let audio_udp = bind("audio").await?;
    let video_udp = bind("video").await?;
    let receiver_ip = adapter.host_ip().to_string();
    let sender_ip = adapter.peer_ip().to_string();

    // The host endpoint as a captured Device Hub offer the device accepted describes it.
    let call_info = CallInfoBlob {
        call_id: 0,
        client_version: 1,
        device_type: "Mac17,7".into(),
        framework_version: "2205.3.1".into(),
        os_version: "25F71".into(),
        device_name: None,
        audio_device_uid: None,
    };
    // Audio and video share one session, and audio starts first: without it the device's
    // negotiator finds no screen video rules and the video stream fails.
    let session_id = uuid::Uuid::new_v4();
    let call_id = || uuid::Uuid::new_v4().to_string().to_uppercase();

    let audio_offer = build_screen_audio_offer(&call_id(), &call_info)
        .map_err(|error| HelperError::internal(format!("building the audio offer: {error}")))?;
    let audio_params = build_start_audio_parameters(
        &receiver_ip,
        audio_udp.local_port(),
        &sender_ip,
        AUDIO_SENDER_PORT,
        audio_offer,
        CLIENT_SUPPORTED_FEATURES,
        session_id,
    );
    let audio_answer =
        match tokio::time::timeout(STEP_TIMEOUT, display.start_media_stream(audio_params)).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(error)) => return Err(start_error("starting the audio stream failed", error)),
            Err(_) => return Err(HelperError::stream("starting the audio stream timed out")),
        };
    let audio = stream_config(&audio_answer, "audio");

    let offered_ssrc = uuid::Uuid::new_v4().as_u128() as u32;
    let video_offer = build_screen_video_offer(&call_id(), &call_info, offered_ssrc)
        .map_err(|error| HelperError::internal(format!("building the video offer: {error}")))?;
    let video_params = build_start_video_parameters(
        &receiver_ip,
        video_udp.local_port(),
        &sender_ip,
        VIDEO_SENDER_PORT,
        video_offer,
        CLIENT_SUPPORTED_FEATURES,
        MAIN_DISPLAY,
        session_id,
    );
    let video_answer =
        match tokio::time::timeout(STEP_TIMEOUT, display.start_media_stream(video_params)).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(error)) => {
                let _ =
                    tokio::time::timeout(Duration::from_secs(2), display.stop_media_stream()).await;
                return Err(start_error("starting the video stream failed", error));
            }
            Err(_) => {
                let _ =
                    tokio::time::timeout(Duration::from_secs(2), display.stop_media_stream()).await;
                return Err(HelperError::stream("starting the video stream timed out"));
            }
        };
    let mut video = stream_config(&video_answer, "video");
    video.our_ssrc = video.our_ssrc.or(Some(offered_ssrc));

    Ok(Session {
        provider,
        adapter,
        handshake,
        display,
        audio_udp,
        video_udp,
        audio,
        video,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_major_version() {
        assert_eq!(major_version("27.0.1"), Some(27));
        assert_eq!(major_version("26"), Some(26));
        assert_eq!(major_version("beta"), None);
    }

    #[test]
    fn reads_the_stream_config() {
        let answer = plist::Value::Dictionary(plist::Dictionary::from_iter([(
            "connection".to_string(),
            plist::Value::Dictionary(plist::Dictionary::from_iter([(
                "streamConfig".to_string(),
                plist::Value::Dictionary(plist::Dictionary::from_iter([
                    (
                        "SourcePort".to_string(),
                        plist::Value::Integer(50001.into()),
                    ),
                    (
                        "LocalSSRC".to_string(),
                        plist::Value::Integer(0xDEAD_BEEFu64.into()),
                    ),
                    ("RemoteSSRC".to_string(), plist::Value::Integer(7.into())),
                ])),
            )])),
        )]));
        let config = stream_config(&answer, "video");
        assert_eq!(config.source_port, Some(50001));
        assert_eq!(config.device_ssrc, Some(0xDEAD_BEEF));
        assert_eq!(config.our_ssrc, Some(7));
    }
}
