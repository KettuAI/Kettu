//! Touch, keyboard and hardware buttons through dtuhidd's HID services. The device only routes
//! these while the display stream is running, which authenticates the HID surfaces.

use std::collections::BTreeMap;
use std::time::Duration;

use idevice::core_device::hid::{
    ButtonState, IndigoHidClient, KeyboardUsage, MainKeyboardError, MainKeyboardService,
    TouchscreenContact, UniversalHidServiceClient,
};
use idevice::rsd::RsdHandshake;
use idevice::tcp::handle::AdapterHandle;
use idevice::{ReadWrite, RsdService};
use serde_json::json;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::Instant;

use crate::framing::{Button, HostInput, Key, KeyPhase, Output, Touch, TouchPhase};

const MAX_FINGERS: u8 = 5;
/// A new virtual keyboard is not attached until a moment after the device confirms it.
const KEYBOARD_SETTLE: Duration = Duration::from_millis(300);
const KEYBOARD_RETRY: Duration = Duration::from_secs(5);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(1);

/// Usage page, usage and how long the button is held: Lock sleeps the device and Siri starts
/// listening only on a press of about the length a person makes.
fn button_usage(button: Button) -> (u64, u64, Duration) {
    let ms = Duration::from_millis;
    match button {
        Button::Home => (0x0C, 0x40, ms(80)),
        Button::Lock => (0x0C, 0x30, ms(500)),
        Button::VolumeUp => (0x0C, 0xE9, ms(80)),
        Button::VolumeDown => (0x0C, 0xEA, ms(80)),
        Button::Siri => (0x0C, 0xCF, ms(1200)),
    }
}

fn to_hid(value: f64) -> u16 {
    (value.clamp(0.0, 1.0) * 65535.0).round() as u16
}

enum Keyboard {
    Absent,
    Ready(MainKeyboardService),
    Failed(Instant),
}

pub struct Input {
    touch: Option<UniversalHidServiceClient<Box<dyn ReadWrite>>>,
    buttons: Option<IndigoHidClient<Box<dyn ReadWrite>>>,
    keyboard: Keyboard,
    fingers: BTreeMap<u8, (u16, u16)>,
    releases: Vec<(Instant, Button)>,
}

impl Input {
    pub async fn connect(adapter: &mut AdapterHandle, handshake: &mut RsdHandshake) -> Input {
        let touch = match UniversalHidServiceClient::connect_rsd(adapter, handshake).await {
            Ok(client) => Some(client),
            Err(error) => {
                eprintln!("touch and keyboard are unavailable: {error}");
                None
            }
        };
        let buttons = match IndigoHidClient::connect_rsd(adapter, handshake).await {
            Ok(client) => Some(client),
            Err(error) => {
                eprintln!("hardware buttons are unavailable: {error}");
                None
            }
        };
        Input {
            touch,
            buttons,
            keyboard: Keyboard::Absent,
            fingers: BTreeMap::new(),
            releases: Vec::new(),
        }
    }

    pub fn available(&self) -> bool {
        self.touch.is_some()
    }

    /// Handles host input until the host goes away; never returns.
    pub async fn run(&mut self, messages: &mut UnboundedReceiver<HostInput>, out: &Output) {
        let mut open = true;
        loop {
            let next_release = self.releases.iter().map(|(at, _)| *at).min();
            tokio::select! {
                message = messages.recv(), if open => match message {
                    Some(message) => {
                        let was_available = self.available();
                        self.handle(message).await;
                        if was_available && !self.available() {
                            out.status(json!({ "type": "input", "available": false }));
                        }
                    }
                    None => open = false,
                },
                () = sleep_until(next_release) => self.release_due(Instant::now()).await,
            }
        }
    }

    async fn handle(&mut self, message: HostInput) {
        match message {
            HostInput::Touch(touch) => self.touch(touch).await,
            HostInput::Button(button) => self.press(button).await,
            HostInput::Key(key) => self.key(key).await,
        }
    }

    async fn send_fingers(&mut self, released: Option<(u8, (u16, u16))>) {
        let Some(client) = self.touch.as_mut() else {
            return;
        };
        let mut contacts: Vec<TouchscreenContact> = self
            .fingers
            .iter()
            .map(|(&identity, &(x, y))| TouchscreenContact {
                identity,
                touching: true,
                x,
                y,
            })
            .collect();
        if let Some((identity, (x, y))) = released {
            contacts.push(TouchscreenContact {
                identity,
                touching: false,
                x,
                y,
            });
        }
        if let Err(error) = client.send_multitouch(&contacts, None).await {
            eprintln!("touch failed, input stops: {error}");
            self.touch = None;
        }
    }

    async fn touch(&mut self, touch: Touch) {
        if touch.id >= MAX_FINGERS {
            return;
        }
        let position = (to_hid(touch.x), to_hid(touch.y));
        match touch.phase {
            TouchPhase::Begin | TouchPhase::Move => {
                self.fingers.insert(touch.id, position);
                self.send_fingers(None).await;
            }
            TouchPhase::End => {
                if self.fingers.remove(&touch.id).is_some() {
                    self.send_fingers(Some((touch.id, position))).await;
                }
            }
        }
    }

    async fn press(&mut self, button: Button) {
        if self.releases.iter().any(|(_, held)| *held == button) {
            return;
        }
        let Some(client) = self.buttons.as_mut() else {
            return;
        };
        let (page, usage, hold) = button_usage(button);
        match client.send_button(page, usage, ButtonState::Down).await {
            Ok(()) => self.releases.push((Instant::now() + hold, button)),
            Err(error) => eprintln!("pressing {button:?} failed: {error}"),
        }
    }

    async fn release_due(&mut self, now: Instant) {
        let (due, held): (Vec<_>, Vec<_>) = self.releases.drain(..).partition(|(at, _)| *at <= now);
        self.releases = held;
        for (_, button) in due {
            let (page, usage, _) = button_usage(button);
            if let Some(client) = self.buttons.as_mut()
                && let Err(error) = client.send_button(page, usage, ButtonState::Up).await
            {
                eprintln!("releasing {button:?} failed: {error}");
            }
        }
    }

    /// The virtual keyboard is created on the first key, since an attached hardware keyboard
    /// hides the device's on-screen one.
    async fn keyboard(&mut self) -> Option<&mut MainKeyboardService> {
        let client = self.touch.as_mut()?;
        let retry = match &self.keyboard {
            Keyboard::Ready(_) => false,
            Keyboard::Absent => true,
            Keyboard::Failed(at) => at.elapsed() >= KEYBOARD_RETRY,
        };
        if retry {
            match client.create_main_keyboard().await {
                Ok(service) => {
                    tokio::time::sleep(KEYBOARD_SETTLE).await;
                    self.keyboard = Keyboard::Ready(service);
                }
                Err(error) => {
                    eprintln!("cannot create the keyboard: {error}");
                    self.keyboard = Keyboard::Failed(Instant::now());
                }
            }
        }
        match &mut self.keyboard {
            Keyboard::Ready(service) => Some(service),
            _ => None,
        }
    }

    async fn key(&mut self, key: Key) {
        let Ok(usage) = KeyboardUsage::new(key.usage) else {
            eprintln!("ignoring key usage {:#x}", key.usage);
            return;
        };
        if self.keyboard().await.is_none() {
            return;
        }
        let (Some(client), Keyboard::Ready(service)) = (self.touch.as_mut(), &mut self.keyboard)
        else {
            return;
        };
        let result = match key.phase {
            KeyPhase::Down => client.main_keyboard_key_down(service, usage).await,
            KeyPhase::Up => client.main_keyboard_key_up(service, usage).await,
        };
        match result {
            Ok(())
            | Err(MainKeyboardError::KeyAlreadyPressed | MainKeyboardError::KeyNotPressed) => {}
            Err(MainKeyboardError::Inactive) => self.keyboard = Keyboard::Absent,
            Err(error) => eprintln!("key {:#x} failed: {error}", key.usage),
        }
    }

    /// Lifts fingers, keys and buttons and removes the virtual keyboard, so nothing stays held
    /// or attached on the device after the stream.
    pub async fn cleanup(&mut self) {
        let _ = tokio::time::timeout(CLEANUP_TIMEOUT, async {
            let held: Vec<_> = self.releases.iter().map(|(at, _)| *at).collect();
            if let Some(last) = held.into_iter().max() {
                self.release_due(last).await;
            }
            let lifted: Vec<TouchscreenContact> = std::mem::take(&mut self.fingers)
                .into_iter()
                .map(|(identity, (x, y))| TouchscreenContact {
                    identity,
                    touching: false,
                    x,
                    y,
                })
                .collect();
            if let (false, Some(client)) = (lifted.is_empty(), self.touch.as_mut()) {
                let _ = client.send_multitouch(&lifted, None).await;
            }
            if let (Some(client), Keyboard::Ready(service)) =
                (self.touch.as_mut(), &mut self.keyboard)
                && let Err(error) = client.remove_main_keyboard(service).await
            {
                eprintln!("removing the keyboard failed: {error}");
            }
        })
        .await;
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_normalized_coordinates() {
        assert_eq!(to_hid(0.0), 0);
        assert_eq!(to_hid(0.5), 32768);
        assert_eq!(to_hid(1.0), 65535);
        assert_eq!(to_hid(-1.0), 0);
        assert_eq!(to_hid(2.0), 65535);
    }
}
