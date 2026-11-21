import AppKit
import SwiftUI

/// The island's window: borderless, above the menu bar, on every Space and over full-screen apps.
/// It never activates Kettu, and takes the keyboard only while the user opened it with a click.
final class IslandPanel: NSPanel {
  var keyable = false

  override var canBecomeKey: Bool { keyable }
  override var canBecomeMain: Bool { false }

  // The island sits over the menu bar, where AppKit would otherwise push a window down.
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
    frameRect
  }
}

/// Places the island on the screen with the menu bar and turns the pointer, clicks and keys into
/// what the model does. The window keeps the largest size the island can take; outside the shape
/// it lets every click through.
final class IslandController {
  private let model: IslandModel
  private let panel: IslandPanel
  /// The middle of the island's top edge, in screen coordinates.
  private var top = CGPoint.zero
  private var monitors: [Any] = []
  private var observers: [(NotificationCenter, NSObjectProtocol)] = []
  private var hoverTimer: Timer?
  private var leaveTimer: Timer?
  private var inside = false
  /// The pointer's latest place and time, and its speed in points per ms, smoothed.
  private var lastPoint: CGPoint?
  private var lastMove: TimeInterval = 0
  private var speed: Double = 0
  private var hideWork: DispatchWorkItem?
  private let floating: Bool
  private let notchScreen: Bool

  /// `floating` and `notchScreen` are development switches: draw the island as on a screen without
  /// a notch, and keep to the screen with the notch whichever display is in use.
  init(model: IslandModel, floating: Bool = false, notchScreen: Bool = false) {
    self.model = model
    self.floating = floating
    self.notchScreen = notchScreen
    panel = IslandPanel(
      contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered,
      defer: true)
    panel.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)
    panel.collectionBehavior = [
      .canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle,
    ]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.hidesOnDeactivate = false
    panel.isMovable = false
    panel.isReleasedWhenClosed = false
    panel.ignoresMouseEvents = true
    panel.acceptsMouseMovedEvents = true
    panel.becomesKeyOnlyIfNeeded = true
    panel.animationBehavior = .none
    let host = NSHostingView(rootView: IslandRoot(model: model))
    host.sizingOptions = []
    panel.contentView = host

    model.onModeChange = { [weak self] mode in self?.modeChanged(mode) }
    model.onAnnounce = { [weak self] text in self?.announce(text) }
    place()
    watch()
  }

  // MARK: Placement

  /// The screen with the menu bar; with a menu bar on every display, the one in use.
  private func screen() -> NSScreen? {
    if notchScreen, let notched = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) {
      return notched
    }
    if NSScreen.screensHaveSeparateSpaces, let main = NSScreen.main { return main }
    return NSScreen.screens.first
  }

  func place() {
    guard let screen = screen() else { return }
    let frame = screen.frame
    var g = IslandGeometry()
    if !floating, screen.safeAreaInsets.top > 0, let left = screen.auxiliaryTopLeftArea,
      let right = screen.auxiliaryTopRightArea
    {
      g.notchWidth = frame.width - left.width - right.width
      g.notchHeight = screen.safeAreaInsets.top
      g.hasNotch = true
      top = CGPoint(x: frame.minX + left.width + g.notchWidth / 2, y: frame.maxY)
    } else {
      // No notch: the island sits in the middle of the menu bar, as tall as it, and grows down
      // from the top of the screen as it would from a notch.
      let menuBar = frame.maxY - screen.visibleFrame.maxY
      g.notchWidth = 0
      g.notchHeight = menuBar > 0 ? menuBar : Metrics.bandHeight
      g.hasNotch = false
      top = CGPoint(x: frame.midX, y: frame.maxY)
    }
    g.maxHeight = (frame.height * Metrics.maxHeightShare).rounded()
    if model.geometry != g { model.geometry = g }
    let width =
      max(Metrics.openWidth, g.notchWidth + Metrics.openWings, Metrics.grownWidth) + 2 * Metrics.margin
    let height = g.maxHeight + Metrics.margin
    panel.setFrame(
      NSRect(x: (top.x - width / 2).rounded(), y: top.y - height, width: width, height: height),
      display: false)
  }

  private func watch() {
    let center = NotificationCenter.default
    let workspace = NSWorkspace.shared.notificationCenter
    observers.append(
      (
        center,
        center.addObserver(
          forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.place() }
      ))
    // With a menu bar on every display, the one in use changes with the active app and Space.
    for name in [
      NSWorkspace.activeSpaceDidChangeNotification, NSWorkspace.didActivateApplicationNotification,
    ] {
      observers.append(
        (
          workspace,
          workspace.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            guard let self, self.model.mode != .open else { return }
            self.place()
          }
        ))
    }
    observers.append(
      (
        workspace,
        workspace.addObserver(
          forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil,
          queue: .main
        ) { [weak self] _ in
          self?.model.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        }
      ))

    // Moving the pointer needs no permission to be seen; keys are only read while the island
    // holds the keyboard, through the local monitor.
    let moves: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged]
    if let m = NSEvent.addGlobalMonitorForEvents(
      matching: moves,
      handler: { [weak self] _ in
        self?.pointerMoved()
      })
    {
      monitors.append(m)
    }
    if let m = NSEvent.addLocalMonitorForEvents(
      matching: moves,
      handler: { [weak self] event in
        self?.pointerMoved()
        return event
      })
    {
      monitors.append(m)
    }
    if let m = NSEvent.addGlobalMonitorForEvents(
      matching: [.leftMouseDown, .rightMouseDown],
      handler: { [weak self] event in
        guard let self else { return }
        if self.model.mode == .open {
          self.model.collapse()
        } else if self.model.mode == .rest, self.inside, event.type == .leftMouseDown {
          // The island in the notch lets clicks through, so a click on the notch comes here.
          self.model.expand(byClick: true)
        }
      })
    {
      monitors.append(m)
    }
    if let m = NSEvent.addLocalMonitorForEvents(
      matching: .keyDown,
      handler: { [weak self] event in
        guard let self, self.panel.isKeyWindow else { return event }
        return self.key(event) ? nil : event
      })
    {
      monitors.append(m)
    }
  }

  // MARK: Pointer and keys

  private func islandRect() -> NSRect {
    let size = model.frameSize()
    return NSRect(
      x: top.x - size.width / 2, y: top.y - size.height, width: size.width, height: size.height)
  }

  private func pointerMoved() {
    let point = NSEvent.mouseLocation
    let time = ProcessInfo.processInfo.systemUptime
    if let last = lastPoint, time > lastMove {
      let now = hypot(point.x - last.x, point.y - last.y) / ((time - lastMove) * 1000)
      speed = 0.6 * now + 0.4 * speed
    }
    lastPoint = point
    lastMove = time
    // Shrunk into the notch, the island is the notch alone; with no notch nothing is left to rest on.
    let reachable = model.mode != .hidden && (model.mode != .rest || model.geometry.hasNotch)
    let over = reachable && islandRect().insetBy(dx: -1, dy: -1).contains(NSEvent.mouseLocation)
    let catches = over && model.mode != .rest
    if panel.ignoresMouseEvents == catches { panel.ignoresMouseEvents = !catches }
    model.pointerInside = over
    guard over != inside else { return }
    inside = over
    if over { entered() } else { left() }
  }

  /// The pointer rests on the island for 120 ms and moves slower than 1.2 pt per ms before it
  /// opens, so passing over it on the way to the menu bar opens nothing.
  private static let dwell: TimeInterval = 0.12
  private static let slow = 1.2
  /// How long the pointer may be off an island it opened before it closes.
  private static let grace: TimeInterval = 0.4

  private func entered() {
    leaveTimer?.invalidate()
    guard [.rest, .collapsed, .grown].contains(model.mode) else { return }
    model.holdPop(paused: true)
    // Laid out now, so the island opens straight to the panel's height.
    model.prepare()
    armHover(after: Self.dwell)
  }

  private func armHover(after seconds: TimeInterval) {
    hoverTimer?.invalidate()
    hoverTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) {
      [weak self] _ in
      guard let self, self.inside else { return }
      let still = ProcessInfo.processInfo.systemUptime - self.lastMove > 0.05
      if still || self.speed < Self.slow {
        self.model.expand(byClick: false)
      } else {
        self.armHover(after: 0.04)
      }
    }
  }

  private func left() {
    hoverTimer?.invalidate()
    if model.mode == .grown { model.holdPop() }
    if model.mode == .collapsed || model.mode == .rest { model.measuring = false }
    // An island a request opened stays until it is answered or dismissed with a click elsewhere.
    if model.mode == .open && model.opener == .hover {
      leaveTimer = Timer.scheduledTimer(withTimeInterval: Self.grace, repeats: false) {
        [weak self] _ in self?.model.collapse()
      }
    }
  }

  /// The keys of an island opened by a click: Esc closes it, the arrows move through the rows,
  /// Return opens one, and a digit answers the request on top with that option.
  private func key(_ event: NSEvent) -> Bool {
    switch event.keyCode {
    case 53:
      model.collapse()
      return true
    case 125:
      model.moveSelection(1)
      return true
    case 126:
      model.moveSelection(-1)
      return true
    case 36, 76:
      if let row = model.selected {
        model.open(row: row)
        return true
      }
      if let request = model.requests.first {
        model.open(request: request)
        return true
      }
      return false
    default:
      guard !event.modifierFlags.contains(.command),
        let digit = event.charactersIgnoringModifiers.flatMap(Int.init), (1...9).contains(digit),
        let request = model.requests.first, digit <= request.options.count
      else { return false }
      model.answer(request, option: request.options[digit - 1])
      return true
    }
  }

  // MARK: Showing

  private func modeChanged(_ mode: Mode) {
    // The words come with main's hello, after the window was made.
    panel.setAccessibilityLabel(model.text("label"))
    hideWork?.cancel()
    if mode == .hidden {
      // Out of the window list once the island has shrunk away, so nothing is drawn or composed.
      let work = DispatchWorkItem { [weak self] in
        guard let self, self.model.mode == .hidden else { return }
        self.panel.orderOut(nil)
      }
      hideWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
    } else if !panel.isVisible {
      place()
      panel.orderFrontRegardless()
    }
    if mode == .open && model.openedByClick {
      panel.keyable = true
      panel.makeKey()
    } else if mode != .open {
      panel.keyable = false
      if panel.isKeyWindow { panel.resignKey() }
    }
    pointerMoved()
  }

  private func announce(_ text: String) {
    guard !text.isEmpty else { return }
    NSAccessibility.post(
      element: panel, notification: .announcementRequested,
      userInfo: [
        .announcement: text,
        .priority: NSAccessibilityPriorityLevel.high.rawValue,
      ])
  }
}
