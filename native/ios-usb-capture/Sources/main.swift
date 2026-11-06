import AVFoundation
import Foundation

let usage = """
  usage: kettu-ios-usb-capture list
         kettu-ios-usb-capture stream --udid <UDID>

  """

/// One `stream` run: waits for the device, then captures and encodes it until stdin closes.
final class Stream {
  private let udid: String
  private let writer = FrameWriter()
  private let queue = DispatchQueue(label: "sh.kettu.ios-usb-capture.capture", qos: .userInteractive)
  private var encoder: H264Encoder!
  private let lock = NSLock()
  /// Set once the capture runs, so a stop before then has nothing to stop.
  private var capture: ScreenCapture?
  private var exiting = false

  init(udid: String) {
    self.udid = udid
    encoder = H264Encoder(queue: queue, writer: writer) { [unowned self] message in
      fail(Failure(code: "encoder", message: message))
    }
    writer.onKeyframeNeeded = { [unowned self] in encoder.requestKeyframe() }
    writer.onStdoutClosed = { [unowned self] in finish(status: nil, exitCode: 0) }
  }

  func run() -> Never {
    writer.start()
    readHostMessages(
      onKeyframeRequest: { [unowned self] in self.encoder.requestKeyframe() },
      onEnd: { [unowned self] in stop() })
    do {
      try allowScreenCaptureDevices()
    } catch {
      fail(error)
    }

    let wanted = normalizedUDID(udid)
    var device: AVCaptureDevice?
    watchScreenCaptureDevices(for: 5) { devices in
      device = devices.first { normalizedUDID($0.uniqueID) == wanted }
      return device != nil
    }
    guard let device else {
      fail(
        Failure(
          code: "no-device",
          message: "No screen capture device for \(udid) appeared within 5 s. "
            + "It must be connected over USB, unlocked and trust this Mac."))
    }
    log("streaming \(device.localizedName) (\(device.uniqueID))")

    let encoder = encoder!
    let capture = ScreenCapture(
      device: device, queue: queue, onFrame: { encoder.encode($0, at: $1) },
      onFailure: { [unowned self] in fail($0) })
    do {
      try capture.configure()
      writer.sendStatus(["type": "ready"])
      writer.sendStatus(["type": "input", "available": false])
      try capture.start()
    } catch {
      fail(error)
    }
    lock.locked { self.capture = capture }
    while true { RunLoop.main.run() }
  }

  /// Runs on the stdin thread, so it also stops while the main thread waits in CoreMediaIO.
  private func stop() -> Never {
    log("stdin closed; stopping")
    lock.locked { capture }?.stop()
    finish(status: nil, exitCode: 0)
  }

  private func fail(_ failure: Failure) -> Never {
    log("\(failure.code): \(failure.message)")
    finish(status: ["type": "error", "code": failure.code, "message": failure.message], exitCode: 1)
  }

  /// Exits once the last messages are written. Whichever thread comes first decides the exit code.
  private func finish(status: [String: Any]?, exitCode: Int32) -> Never {
    let first = lock.locked {
      defer { exiting = true }
      return !exiting
    }
    guard first else {
      while true { sleep(60) }
    }
    writer.close(with: status)
    writer.drain(timeout: 2)
    // Skips the exit handlers, which could tear down what other threads still use mid-call. Nothing
    // is left to flush: stdout is written with write(2) and stderr is unbuffered.
    _exit(exitCode)
  }
}

func list() -> Never {
  do {
    try allowScreenCaptureDevices()
  } catch {
    log(error.message)
    exit(1)
  }
  var found: [(udid: String, name: String)] = []
  watchScreenCaptureDevices(for: 2) { devices in
    for device in devices where !found.contains(where: { $0.udid == device.uniqueID }) {
      log("found \(device.localizedName) (\(device.uniqueID), \(device.modelID))")
      found.append((device.uniqueID, device.localizedName))
    }
    return false
  }
  let entries = found.map { ["udid": $0.udid, "name": $0.name] }
  print(String(decoding: json(entries), as: UTF8.self))
  exit(0)
}

signal(SIGPIPE, SIG_IGN)
// A source of its own keeps the main run loop waiting for device notifications instead of returning.
RunLoop.main.add(NSMachPort(), forMode: .default)

let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first {
case "list" where arguments.count == 1:
  list()
case "stream" where arguments.count == 3 && arguments[1] == "--udid" && !arguments[2].isEmpty:
  Stream(udid: arguments[2]).run()
default:
  fputs(usage, stderr)
  exit(2)
}
