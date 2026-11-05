import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

struct EncoderError: Error, CustomStringConvertible {
  let description: String
}

/// Encodes captured frames to H.264 for live viewing and hands them to the writer. `encode` must be
/// called on `queue`; VideoToolbox calls the output handler serially on a thread of its own.
final class H264Encoder {
  static let bitRate = 6_000_000
  static let keyframeInterval = 2.0
  static let frameRate = 60
  /// Frames handed to VideoToolbox and not yet returned. A frame beyond these is dropped, so a busy
  /// encoder never builds up a backlog.
  static let maxFramesInFlight = 2

  private let queue: DispatchQueue
  private let writer: FrameWriter
  private let onError: (String) -> Void

  private var session: VTCompressionSession?
  private var width = 0
  private var height = 0
  private var lastImage: CVImageBuffer?
  private var lastTime = CMTime.invalid
  /// The host clock's time when lastTime was handed in, to time a repeated frame on the device's clock.
  private var lastArrival = CMTime.invalid

  private let lock = NSLock()
  private var forceKeyframe = false
  private var framesInFlight = 0

  // Used only by the output handler.
  private var sentScreen: Screen?
  private var sentRecord: Data?

  private struct Screen: Equatable {
    let width: Int
    let height: Int
    let codec: String
  }

  init(queue: DispatchQueue, writer: FrameWriter, onError: @escaping (String) -> Void) {
    self.queue = queue
    self.writer = writer
    self.onError = onError
  }

  /// Makes the next frame a keyframe. The device may send no frames while its screen is still, so
  /// the last frame is encoded again when none arrives soon.
  func requestKeyframe() {
    lock.locked { forceKeyframe = true }
    queue.asyncAfter(deadline: .now() + .milliseconds(100)) { [weak self] in
      guard let self, self.lock.locked({ self.forceKeyframe }), let image = self.lastImage else { return }
      let elapsed = CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), self.lastArrival)
      self.encode(image, at: CMTimeAdd(self.lastTime, elapsed))
    }
  }

  func encode(_ image: CVImageBuffer, at captureTime: CMTime) {
    dispatchPrecondition(condition: .onQueue(queue))
    let imageWidth = CVPixelBufferGetWidth(image)
    let imageHeight = CVPixelBufferGetHeight(image)
    if session == nil || imageWidth != width || imageHeight != height {
      guard startSession(width: imageWidth, height: imageHeight) else { return }
    }
    guard let session else { return }
    // VideoToolbox wants increasing timestamps, which a repeated frame could otherwise break.
    let time =
      lastTime.isValid && CMTimeCompare(captureTime, lastTime) <= 0
      ? CMTimeAdd(lastTime, CMTime(value: 1, timescale: 1000)) : captureTime
    lastImage = image
    lastTime = time
    lastArrival = CMClockGetTime(CMClockGetHostTimeClock())

    let force: Bool? = lock.locked {
      guard framesInFlight < Self.maxFramesInFlight else { return nil }
      framesInFlight += 1
      defer { forceKeyframe = false }
      return forceKeyframe
    }
    guard let force else { return }
    let options = force ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary : nil
    let status = VTCompressionSessionEncodeFrame(
      session, imageBuffer: image, presentationTimeStamp: time, duration: .invalid,
      frameProperties: options, infoFlagsOut: nil
    ) { [weak self] status, flags, sample in
      self?.didEncode(status: status, flags: flags, sample: sample)
    }
    if status != noErr {
      onError("VTCompressionSessionEncodeFrame failed with \(status)")
    }
  }

  /// Starts a session for the frame size, which changes when the device rotates.
  private func startSession(width: Int, height: Int) -> Bool {
    if let old = session {
      // Lets the old session's frames out first, so they stay in order with the new description.
      VTCompressionSessionCompleteFrames(old, untilPresentationTimeStamp: .invalid)
      VTCompressionSessionInvalidate(old)
      session = nil
    }
    var created: VTCompressionSession?
    let status = VTCompressionSessionCreate(
      allocator: nil, width: Int32(width), height: Int32(height),
      codecType: kCMVideoCodecType_H264, encoderSpecification: nil, imageBufferAttributes: nil,
      compressedDataAllocator: nil, outputCallback: nil, refcon: nil,
      compressionSessionOut: &created)
    guard status == noErr, let created else {
      onError("VTCompressionSessionCreate failed with \(status) for \(width)x\(height)")
      return false
    }
    do {
      try Self.configure(created)
    } catch {
      VTCompressionSessionInvalidate(created)
      onError("\(error)")
      return false
    }
    session = created
    self.width = width
    self.height = height
    log("encoding \(width)x\(height)")
    return true
  }

  private static func configure(_ session: VTCompressionSession) throws {
    let required: [(CFString, CFTypeRef)] = [
      (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue),
      (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse),
      (kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, NSNumber(value: keyframeInterval)),
      (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitRate)),
    ]
    for (key, value) in required {
      let status = VTSessionSetProperty(session, key: key, value: value)
      guard status == noErr else { throw EncoderError(description: "setting \(key) failed with \(status)") }
    }
    if VTSessionSetProperty(
      session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
      != noErr
    {
      let status = VTSessionSetProperty(
        session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Main_AutoLevel)
      guard status == noErr else { throw EncoderError(description: "setting the profile failed with \(status)") }
    }
    let optional: [(CFString, CFTypeRef)] = [
      (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: frameRate)),
      // A hard cap over one second, on top of the soft average, so a burst of motion stays bounded.
      (kVTCompressionPropertyKey_DataRateLimits, [NSNumber(value: bitRate * 3 / 2 / 8), NSNumber(value: 1)] as CFArray),
      (kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, kCFBooleanTrue),
    ]
    for (key, value) in optional {
      let status = VTSessionSetProperty(session, key: key, value: value)
      if status != noErr { log("the encoder does not take \(key) (\(status))") }
    }
    let status = VTCompressionSessionPrepareToEncodeFrames(session)
    guard status == noErr else { throw EncoderError(description: "preparing the encoder failed with \(status)") }
  }

  private func didEncode(status: OSStatus, flags: VTEncodeInfoFlags, sample: CMSampleBuffer?) {
    lock.locked { framesInFlight -= 1 }
    guard status == noErr else {
      onError("encoding a frame failed with \(status)")
      return
    }
    guard let sample, !flags.contains(.frameDropped), let block = CMSampleBufferGetDataBuffer(sample) else {
      return
    }
    let keyframe = Self.isKeyframe(sample)
    if keyframe {
      guard let format = CMSampleBufferGetFormatDescription(sample) else {
        onError("a keyframe came without a format description")
        return
      }
      do {
        try sendFormat(format)
      } catch {
        onError("\(error)")
        return
      }
    }
    let length = CMBlockBufferGetDataLength(block)
    guard length > 0 else { return }
    var accessUnit = Data(count: length)
    let copied = accessUnit.withUnsafeMutableBytes { raw in
      CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: raw.baseAddress!)
    }
    guard copied == noErr else {
      onError("reading an encoded frame failed with \(copied)")
      return
    }
    writer.sendVideo(accessUnit, keyframe: keyframe)
  }

  private func sendFormat(_ format: CMFormatDescription) throws {
    let configuration = try AVCConfiguration(format)
    let size = CMVideoFormatDescriptionGetDimensions(format)
    let screen = Screen(width: Int(size.width), height: Int(size.height), codec: configuration.codec)
    if screen != sentScreen {
      writer.send(
        tag: Tag.screen,
        payload: json([
          "type": "screen", "width": screen.width, "height": screen.height, "codec": screen.codec,
          "orientation": screen.width > screen.height ? "landscape_left" : "portrait",
        ]))
      sentScreen = screen
    }
    if configuration.record != sentRecord {
      writer.send(tag: Tag.description, payload: configuration.record)
      sentRecord = configuration.record
    }
  }

  private static func isKeyframe(_ sample: CMSampleBuffer) -> Bool {
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
    let notSync = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false
    return !notSync
  }
}

/// The AVCDecoderConfigurationRecord (avcC, ISO/IEC 14496-15) and the WebCodecs codec string of an
/// H.264 format description.
struct AVCConfiguration {
  let record: Data
  let codec: String

  init(_ format: CMFormatDescription) throws {
    var count = 0
    var nalLengthSize: Int32 = 0
    var status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
      format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil,
      parameterSetCountOut: &count, nalUnitHeaderLengthOut: &nalLengthSize)
    guard status == noErr else { throw EncoderError(description: "reading the parameter sets failed with \(status)") }
    guard nalLengthSize == 4 else {
      throw EncoderError(description: "the encoder uses \(nalLengthSize)-byte NAL lengths instead of 4")
    }
    var sequenceSets: [Data] = []
    var pictureSets: [Data] = []
    for index in 0..<count {
      var pointer: UnsafePointer<UInt8>?
      var size = 0
      status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size,
        parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
      guard status == noErr, let pointer, size > 0, size <= 0xFFFF else {
        throw EncoderError(description: "reading parameter set \(index) failed with \(status)")
      }
      let set = Data(bytes: pointer, count: size)
      switch set[0] & 0x1F {
      case 7: sequenceSets.append(set)
      case 8: pictureSets.append(set)
      default: break
      }
    }
    guard let sps = sequenceSets.first, sps.count >= 4, !pictureSets.isEmpty,
      sequenceSets.count < 32, pictureSets.count < 256
    else {
      throw EncoderError(description: "the encoder gave \(sequenceSets.count) SPS and \(pictureSets.count) PPS")
    }
    let profile = sps[1]
    let compatibility = sps[2]
    let level = sps[3]

    var record = Data([1, profile, compatibility, level, 0xFC | 3, 0xE0 | UInt8(sequenceSets.count)])
    for set in sequenceSets { record.appendWithLength(set) }
    record.append(UInt8(pictureSets.count))
    for set in pictureSets { record.appendWithLength(set) }
    if [100, 110, 122, 144].contains(profile) {
      guard let fields = Self.chromaFields(sps) else {
        throw EncoderError(description: "the SPS could not be read")
      }
      record.append(contentsOf: [
        0xFC | fields.chromaFormat, 0xF8 | fields.lumaDepthMinus8, 0xF8 | fields.chromaDepthMinus8, 0,
      ])
    }
    self.record = record
    self.codec = String(format: "avc1.%02X%02X%02X", profile, compatibility, level)
  }

  /// chroma_format_idc and the bit depths, which the avcC of a High profile stream repeats.
  private static func chromaFields(_ sps: Data) -> (
    chromaFormat: UInt8, lumaDepthMinus8: UInt8, chromaDepthMinus8: UInt8
  )? {
    // Drops the emulation prevention bytes after the NAL header.
    var payload: [UInt8] = []
    var zeros = 0
    for byte in sps.dropFirst() {
      if zeros == 2 && byte == 3 {
        zeros = 0
        continue
      }
      payload.append(byte)
      zeros = byte == 0 ? min(zeros + 1, 2) : 0
    }
    var reader = BitReader(payload)
    reader.skip(24)  // profile_idc, the constraint flags and level_idc
    guard reader.expGolomb() != nil, let chromaFormat = reader.expGolomb(), chromaFormat <= 3 else { return nil }
    if chromaFormat == 3 { guard reader.bit() != nil else { return nil } }
    guard let luma = reader.expGolomb(), luma <= 7, let chroma = reader.expGolomb(), chroma <= 7 else { return nil }
    return (UInt8(chromaFormat), UInt8(luma), UInt8(chroma))
  }
}

private struct BitReader {
  private let bytes: [UInt8]
  private var position = 0

  init(_ bytes: [UInt8]) {
    self.bytes = bytes
  }

  mutating func skip(_ count: Int) {
    position += count
  }

  mutating func bit() -> UInt32? {
    guard position < bytes.count * 8 else { return nil }
    let value = bytes[position >> 3] >> (7 - (position & 7)) & 1
    position += 1
    return UInt32(value)
  }

  /// An unsigned Exp-Golomb field, ue(v).
  mutating func expGolomb() -> UInt32? {
    var zeros = 0
    while true {
      guard let bit = bit() else { return nil }
      if bit == 1 { break }
      zeros += 1
      if zeros > 31 { return nil }
    }
    var value: UInt32 = 0
    for _ in 0..<zeros {
      guard let bit = bit() else { return nil }
      value = value << 1 | bit
    }
    return (UInt32(1) << zeros) - 1 + value
  }
}

extension Data {
  fileprivate mutating func appendWithLength(_ set: Data) {
    append(contentsOf: [UInt8(set.count >> 8), UInt8(set.count & 0xFF)])
    append(set)
  }
}
