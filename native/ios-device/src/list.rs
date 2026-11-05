//! `list`: the devices usbmuxd sees, best effort.

use std::time::Duration;

use idevice::IdeviceService;
use idevice::lockdown::LockdownClient;
use idevice::provider::{IdeviceProvider, UsbmuxdProvider};
use idevice::usbmuxd::{Connection, UsbmuxdAddr, UsbmuxdDevice};
use serde_json::{Value, json};

use crate::session::LABEL;

const MUX_TIMEOUT: Duration = Duration::from_secs(3);
const DEVICE_TIMEOUT: Duration = Duration::from_secs(5);

async fn read_string(lockdown: &mut LockdownClient, key: &str) -> Option<String> {
    let value = lockdown.get_value(Some(key), None).await.ok()?;
    value.as_string().map(str::to_owned)
}

/// The device's name and iOS version, starting a session only when lockdownd will not tell
/// without one.
async fn describe(provider: &UsbmuxdProvider) -> (Option<String>, Option<String>) {
    let Ok(mut lockdown) = LockdownClient::connect(provider).await else {
        return (None, None);
    };
    let mut name = read_string(&mut lockdown, "DeviceName").await;
    let mut version = read_string(&mut lockdown, "ProductVersion").await;
    if (name.is_none() || version.is_none())
        && let Ok(pairing) = provider.get_pairing_file().await
        && lockdown.start_session(&pairing).await.is_ok()
    {
        if name.is_none() {
            name = read_string(&mut lockdown, "DeviceName").await;
        }
        if version.is_none() {
            version = read_string(&mut lockdown, "ProductVersion").await;
        }
    }
    (name, version)
}

async fn devices(addr: &UsbmuxdAddr) -> Option<Vec<UsbmuxdDevice>> {
    let mut mux = tokio::time::timeout(MUX_TIMEOUT, addr.connect(0))
        .await
        .ok()?
        .ok()?;
    let mut devices = tokio::time::timeout(MUX_TIMEOUT, mux.get_devices())
        .await
        .ok()?
        .ok()?;
    // A device on USB and Wi-Fi at once is listed twice; keep its USB entry.
    devices.sort_by_key(|device| device.connection_type != Connection::Usb);
    let mut seen = std::collections::HashSet::new();
    devices.retain(|device| seen.insert(device.udid.clone()));
    Some(devices)
}

pub async fn list() -> Value {
    let Ok(addr) = UsbmuxdAddr::from_env_var() else {
        return json!([]);
    };
    let Some(devices) = devices(&addr).await else {
        return json!([]);
    };
    let mut listed = Vec::new();
    for device in devices {
        let provider = device.to_provider(addr.clone(), LABEL);
        let (name, version) = tokio::time::timeout(DEVICE_TIMEOUT, describe(&provider))
            .await
            .unwrap_or((None, None));
        listed.push(json!({
            "udid": device.udid,
            "name": name,
            "productVersion": version,
            "connection": if device.connection_type == Connection::Usb { "usb" } else { "network" },
        }));
    }
    Value::Array(listed)
}
