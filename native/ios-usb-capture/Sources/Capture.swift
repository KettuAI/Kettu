import AVFoundation
import CoreMediaIO

/// A failure reported to the host as a status message, with one of the protocol's error codes.
struct Failure: Error {
  let code: String
  let message: String
}

/// Lets this process see iOS devices connected over USB as muxed capture devices, as QuickTime does.
/// They appear a moment later, once the main run loop has run.
func allowScreenCaptureDevices() throws(Failure) {
  var address = CMIOObjectPropertyAddress(
    mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
    mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
    mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
  var allow: UInt32 = 1
  let status = CMIOObjectSetPropertyData(
    CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &allow)
  guard status == noErr else {
    throw Failure(code: "internal", message: "Enabling screen capture devices failed with \(status).")
  }
}

/// Runs the main run loop, which delivers the device notifications, until `done` returns true for the
/// screen capture devices present or the timeout passes.
func watchScreenCaptureDevices(for timeout: TimeInterval, until done: ([AVCaptureDevice]) -> Bool) {
  let types: [AVCaptureDevice.DeviceType]
  if #available(macOS 14.0, *) {
    types = [.external]
  } else {
    types = [.externalUnknown]
  }
  let discovery = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .muxed, position: .unspecified)
  let deadline = Date(timeIntervalSinceNow: timeout)
  while !done(discovery.devices) && Date() < deadline {
    RunLoop.main.run(until: min(deadline, Date(timeIntervalSinceNow: 0.1)))
  }
}

/// A capture device's uniqueID is the device's UDID, but may differ from it in case and dashes.
func normalizedUDID(_ id: String) -> String {
  String(id.lowercased().filter { $0.isLetter || $0.isNumber })
}

/// Captures the video of one screen capture device and hands each frame over on `queue`.
final class ScreenCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  private let device: AVCaptureDevice
  private let queue: DispatchQueue
  private let onFrame: (CVImageBuffer, CMTime) -> Void
  private let onFailure: (Failure) -> Void
  private let session = AVCaptureSession()
  private var observers: [NSObjectProtocol] = []

  init(
    device: AVCaptureDevice, queue: DispatchQueue, onFrame: @escaping (CVImageBuffer, CMTime) -> Void,
    onFailure: @escaping (Failure) -> Void
  ) {
    self.device = device
    self.queue = queue
    self.onFrame = onFrame
    self.onFailure = onFailure
  }

  func configure() throws(Failure) {
    // Logged because which permission a muxed screen capture device needs is not documented.
    log(
      "camera access \(Self.describe(AVCaptureDevice.authorizationStatus(for: .video))), "
        + "microphone access \(Self.describe(AVCaptureDevice.authorizationStatus(for: .audio)))")
    let input: AVCaptureDeviceInput
    do {
      input = try AVCaptureDeviceInput(device: device)
    } catch let error as AVError where error.code == .applicationIsNotAuthorizedToUseDevice {
      throw Failure(
        code: "permission",
        message: "macOS denied access to \(device.localizedName) (\(error.localizedDescription)). "
          + "Allow it under Camera and Microphone in System Settings > Privacy & Security.")
    } catch {
      throw Failure(
        code: "capture", message: "Opening \(device.localizedName) failed: \(error.localizedDescription)")
    }
    let size = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
    log("\(device.localizedName) (\(device.modelID)) offers \(size.width)x\(size.height)")

    let output = AVCaptureVideoDataOutput()
    output.alwaysDiscardsLateVideoFrames = true
    output.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    ]
    output.setSampleBufferDelegate(self, queue: queue)

    session.beginConfiguration()
    defer { session.commitConfiguration() }
    guard session.canAddInput(input) else {
      throw Failure(code: "capture", message: "The capture session does not take \(device.localizedName).")
    }
    session.addInput(input)
    guard session.canAddOutput(output) else {
      throw Failure(code: "capture", message: "The capture session does not take a video output.")
    }
    session.addOutput(output)

    observers.append(
      NotificationCenter.default.addObserver(
        forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil
      ) { [onFailure] notification in
        let error = notification.userInfo?[AVCaptureSessionErrorKey] as? NSError
        onFailure(
          Failure(
            code: "capture",
            message: "The capture session failed: \(error?.localizedDescription ?? "unknown error")."))
      })
    observers.append(
      NotificationCenter.default.addObserver(
        forName: AVCaptureDevice.wasDisconnectedNotification, object: device, queue: nil
      ) { [onFailure] _ in
        onFailure(Failure(code: "no-device", message: "The device was disconnected."))
      })
  }

  /// Blocks until the session runs.
  func start() throws(Failure) {
    session.startRunning()
    guard session.isRunning else {
      throw Failure(code: "capture", message: "The capture session did not start.")
    }
  }

  /// Leaves the observers in place, since the process exits right after.
  func stop() {
    session.stopRunning()
  }

  func captureOutput(
    _ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection
  ) {
    guard let image = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    onFrame(image, CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
  }

  private static func describe(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: "authorized"
    case .denied: "denied"
    case .restricted: "restricted"
    case .notDetermined: "not determined"
    @unknown default: "unknown"
    }
  }
}
