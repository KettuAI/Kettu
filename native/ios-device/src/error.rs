use std::fmt;

/// A failure the host can act on: `code` is one of the codes the framing defines.
#[derive(Debug)]
pub struct HelperError {
    pub code: &'static str,
    pub message: String,
}

impl HelperError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn no_device(message: impl Into<String>) -> Self {
        Self::new("no-device", message)
    }

    pub fn unsupported_ios(message: impl Into<String>) -> Self {
        Self::new("unsupported-ios", message)
    }

    pub fn developer_mode_off(message: impl Into<String>) -> Self {
        Self::new("developer-mode-off", message)
    }

    pub fn ddi_not_mounted(message: impl Into<String>) -> Self {
        Self::new("ddi-not-mounted", message)
    }

    pub fn not_paired(message: impl Into<String>) -> Self {
        Self::new("not-paired", message)
    }

    pub fn camera_in_use(message: impl Into<String>) -> Self {
        Self::new("camera-in-use", message)
    }

    pub fn tunnel(message: impl Into<String>) -> Self {
        Self::new("tunnel", message)
    }

    pub fn stream(message: impl Into<String>) -> Self {
        Self::new("stream", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("internal", message)
    }
}

impl fmt::Display for HelperError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for HelperError {}
