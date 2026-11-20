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
  private var hideWork: DispatchWorkItem?
  private let floating: Bool
  private let notchScreen: Bool

  /// `floating` and `notchScreen` are development switches: draw the floating island over a notch,
  /// and keep to the screen with the notch whichever display is in use.
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
      g.attached = true
      top = CGPoint(x: frame.minX + left.width + g.notchWidth / 2, y: frame.maxY)
    } else {
      // No notch: a floating island just under the menu bar, clear of the apps' menus.
      let menuBar = max(frame.maxY - screen.visibleFrame.maxY, NSStatusBar.system.thickness)
      g.notchWidth = Metrics.floatingGap
      g.notchHeight = 32
      g.attached = false
      top = CGPoint(x: frame.midX, y: frame.maxY - menuBar - 6)
    }
    g.maxHeight = (frame.height * Metrics.maxHeightShare).rounded()
    if model.geometry != g { model.geometry = g }
    let width = max(Metrics.openWidth, g.notchWidth + 300) + 2 * Metrics.margin
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
      handler: { [weak self] _ in
        if self?.model.mode == .open { self?.model.collapse() }
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
    let over =
      model.mode != .hidden && islandRect().insetBy(dx: -1, dy: -1).contains(NSEvent.mouseLocation)
    if panel.ignoresMouseEvents == over { panel.ignoresMouseEvents = !over }
    guard over != inside else { return }
    inside = over
    if over { entered() } else { left() }
  }

  private func entered() {
    leaveTimer?.invalidate()
    guard model.mode == .collapsed || model.mode == .grown else { return }
    model.holdPop(paused: true)
    hoverTimer?.invalidate()
    hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: false) { [weak self] _ in
      self?.model.expand(byClick: false)
    }
  }

  private func left() {
    hoverTimer?.invalidate()
    if model.mode == .grown { model.holdPop() }
    if model.mode == .open && !model.openedByClick {
      leaveTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in
        self?.model.collapse()
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
      if let row = model.selected ?? model.requests.first?.row {
        model.open(row: row)
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
