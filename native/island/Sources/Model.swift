import AppKit
import SwiftUI

/// Where the island sits and how large it may grow, from the screen it is on.
struct IslandGeometry: Equatable {
  /// The notch's width and height; on a screen without one, the floating island's gap and height.
  var notchWidth: CGFloat = 196
  var notchHeight: CGFloat = 32
  /// Attached to the top edge over a notch, or floating under the menu bar.
  var attached = true
  var maxHeight: CGFloat = 600
}

enum Mode: Equatable {
  case hidden
  case collapsed
  case grown
  case open
}

struct Pop: Equatable {
  let id: Int
  let row: String?
  let kind: String
  let title: String
  let body: String
}

/// What the collapsed island shows: the marks of its most urgent group and that group's signal.
struct Collapsed: Equatable {
  let agents: [IslandAgent]
  let signal: Signal
  let text: String?
}

/// What came of an answer the user gave on the island, shown in place of its card for a moment.
struct Note: Equatable {
  let text: String
  let ok: Bool
}

/// The island's state: the view main sent, kept in `store`, and what the user is doing with it.
/// Everything here runs on the main thread.
final class IslandModel: ObservableObject {
  let store: Store
  private let send: (HelperMessage) -> Void

  @Published private(set) var mode: Mode = .hidden
  @Published private(set) var collapsed: Collapsed?
  @Published private(set) var pop: Pop?
  @Published private(set) var queued = 0
  @Published private(set) var note: Note?
  @Published private(set) var pending: Set<String> = []
  @Published private(set) var revision = 0
  @Published private(set) var now = Date()
  @Published var geometry = IslandGeometry()
  @Published var reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
  @Published var selected: String?
  /// The expanded panel's content height, as last laid out.
  @Published var panelHeight: CGFloat = 0
  private(set) var openedByClick = false
  var onModeChange: ((Mode) -> Void)?
  var onAnnounce: ((String) -> Void)?

  private var pops: [Pop] = []
  private var nextPop = 1
  private var popTimer: Timer?
  private var tick: Timer?
  private var noteTimer: Timer?
  private var stuckTimer: Timer?
  /// Failed and finished rows the user saw on the open island, which stop marking the collapsed one.
  private var seen: Set<String> = []
  private var answers: [String: String] = [:]
  private var nextAnswer = 1

  init(store: Store, send: @escaping (HelperMessage) -> Void) {
    self.store = store
    self.send = send
  }

  // MARK: The view

  var rows: [IslandRow] { store.order.compactMap { store.rows[$0] } }

  var groups: [(group: String, rows: [IslandRow])] {
    let all = rows
    return ["needs_you", "running", "finished"].compactMap { group in
      let list = all.filter { $0.group == group }
      return list.isEmpty ? nil : (group, list)
    }
  }

  var idleCount: Int { rows.filter { $0.group == "idle" }.count }

  var requests: [IslandRequest] { store.requestOrder.compactMap { store.requests[$0] } }

  func row(_ key: String?) -> IslandRow? { key.flatMap { store.rows[$0] } }

  func text(_ key: String, _ values: [String: String] = [:]) -> String { store.text(key, values) }

  /// A counted string, with i18next's `_one` and `_other` suffixes. Chinese, Japanese and Korean
  /// have no singular, so English's `_one`, which the strings fall back to, never applies there.
  func counted(_ key: String, _ count: Int) -> String {
    let values = ["count": "\(count)"]
    let language = store.locale.split(separator: "-").first.map(String.init) ?? store.locale
    let singular = !["zh", "ja", "ko"].contains(language)
    if count == 1, singular, store.strings["\(key)_one"] != nil {
      return text("\(key)_one", values)
    }
    if store.strings["\(key)_other"] != nil { return text("\(key)_other", values) }
    return text(key, values)
  }

  func duration(since ms: Double?) -> String? {
    guard let ms else { return nil }
    let seconds = max(0, Int(now.timeIntervalSince1970 - ms / 1000))
    if seconds < 60 { return text("duration.seconds", ["s": "\(seconds)"]) }
    let minutes = seconds / 60
    if minutes < 60 { return text("duration.minutes", ["m": "\(minutes)"]) }
    if minutes < 24 * 60 {
      return text("duration.hoursMinutes", ["h": "\(minutes / 60)", "m": "\(minutes % 60)"])
    }
    return text("duration.days", ["d": "\(minutes / (24 * 60))"])
  }

  func status(of row: IslandRow) -> String { store.status(of: row, now: now) }

  func signal(of row: IslandRow) -> Signal? {
    switch status(of: row) {
    case "waiting", "sign_in": return .waiting
    case "failed": return .failed
    case "running": return .running(.chase)
    case "starting": return .running(.think)
    case "stuck": return .stuck
    case "limited": return .limited
    case "unread": return .unread
    default: return nil
    }
  }

  var summaryText: String {
    let s = store.summary
    var parts: [String] = []
    if s.waiting > 0 { parts.append(text("summary.waiting", ["count": "\(s.waiting)"])) }
    if s.running > 0 { parts.append(text("summary.running", ["count": "\(s.running)"])) }
    if s.failed > 0 { parts.append(text("summary.failed", ["count": "\(s.failed)"])) }
    return parts.joined(separator: " · ")
  }

  // MARK: Changes from main

  /// Called after every view or change main sent.
  func refresh() {
    now = Date()
    let all = rows
    let live = Set(all.filter { Self.marksDone($0) }.map(seenKey))
    seen.formIntersection(live)
    collapsed = Self.collapse(all, model: self)
    if let selected, store.rows[selected] == nil { self.selected = nil }
    revision += 1
    if mode == .hidden && collapsed != nil { setMode(.collapsed) }
    if mode == .collapsed && collapsed == nil { setMode(.hidden) }
    scheduleStuckCheck(all)
  }

  /// A call turns stuck with no message from main, so the island looks again when the next one
  /// would, and each minute after that while one is stuck. With nothing running, no timer runs.
  private func scheduleStuckCheck(_ rows: [IslandRow]) {
    stuckTimer?.invalidate()
    let nowMs = now.timeIntervalSince1970 * 1000
    var wait: Double?
    for row in rows where row.status == "running" {
      guard let since = row.toolSince else { continue }
      let due = since + store.stuckAfterMs
      let next =
        due > nowMs ? due - nowMs : 60_000 - (nowMs - due).truncatingRemainder(dividingBy: 60_000)
      wait = min(wait ?? next, next)
    }
    guard let wait else { return }
    stuckTimer = Timer.scheduledTimer(withTimeInterval: max(1, wait / 1000), repeats: false) {
      [weak self] _ in self?.refresh()
    }
  }

  private func seenKey(_ row: IslandRow) -> String { "\(row.key)@\(row.status)@\(row.since ?? 0)" }

  /// A turn that ended, failed or done, which the user has not read yet.
  private static func marksDone(_ row: IslandRow) -> Bool {
    row.status == "failed" || row.status == "unread"
  }

  /// The most urgent group decides what the collapsed island shows: waiting, failed, running,
  /// done, limited. Failed and done rows mark it until the user reads them in Kettu or opens the
  /// island, so a turn that ended while a Kettu window was in front, which pops nothing, still shows.
  private static func collapse(_ rows: [IslandRow], model: IslandModel) -> Collapsed? {
    func agents(_ list: [IslandRow]) -> [IslandAgent] {
      var seen = Set<String>()
      return list.map(\.agent).filter { seen.insert("\($0.harness)/\($0.color ?? "")").inserted }
    }
    func count(_ list: [IslandRow]) -> String? { list.count > 1 ? "\(list.count)" : nil }
    let waiting = rows.filter { $0.status == "waiting" || $0.status == "sign_in" }
    if !waiting.isEmpty {
      return Collapsed(agents: agents(waiting), signal: .waiting, text: count(waiting))
    }
    let unseen = rows.filter { marksDone($0) && !model.seen.contains(model.seenKey($0)) }
    let failed = unseen.filter { $0.status == "failed" }
    if !failed.isEmpty {
      return Collapsed(agents: agents(failed), signal: .failed, text: count(failed))
    }
    let running = rows.filter { $0.status == "running" || $0.status == "starting" }
    if !running.isEmpty {
      let moving = running.filter { model.status(of: $0) != "stuck" }
      if moving.isEmpty {
        let longest = running.compactMap(\.toolSince).min()
        let minutes = longest.map { max(1, Int(model.now.timeIntervalSince1970 - $0 / 1000) / 60) }
        return Collapsed(
          agents: agents(running), signal: .stuck,
          text: minutes.map { model.text("duration.minutes", ["m": "\($0)"]) })
      }
      let pattern: TurnDots.Pattern = moving.contains { $0.status == "running" } ? .chase : .think
      return Collapsed(agents: agents(running), signal: .running(pattern), text: count(running))
    }
    let done = unseen.filter { $0.status == "unread" }
    if !done.isEmpty {
      return Collapsed(agents: agents(done), signal: .unread, text: count(done))
    }
    let limited = rows.filter { $0.status == "limited" }
    if !limited.isEmpty {
      let reset = limited.compactMap { $0.limit?.resetsAt }.min()
      return Collapsed(
        agents: agents(limited), signal: .limited, text: reset.map { model.resetDay($0) })
    }
    return nil
  }

  /// When a limit resets, as short as the collapsed island needs: a time today, else a weekday.
  func resetDay(_ ms: Double) -> String {
    let date = Date(timeIntervalSince1970: ms / 1000)
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: store.locale)
    let soon = date.timeIntervalSince(now) < 20 * 3600
    formatter.setLocalizedDateFormatFromTemplate(soon ? "jmm" : "EEE")
    return formatter.string(from: date)
  }

  func pop(_ message: MainMessage) {
    guard let kind = message.kind else { return }
    let item = Pop(
      id: nextPop, row: message.row, kind: kind, title: message.title ?? "",
      body: message.body ?? "")
    nextPop += 1
    onAnnounce?([item.title, item.body].filter { !$0.isEmpty }.joined(separator: ", "))
    if mode == .open { return }
    // A newer pop of the same session replaces the one waiting in line.
    pops.removeAll { $0.row != nil && $0.row == item.row && $0.id != pop?.id }
    pops.append(item)
    let rank = [
      "permission": 0, "error": 1, "routine-paused": 2, "turn-ended": 3, "routine-ended": 4,
    ]
    let showing = pops.first { $0.id == pop?.id }
    let rest = pops.filter { $0.id != pop?.id }.sorted {
      (rank[$0.kind] ?? 5) < (rank[$1.kind] ?? 5)
    }
    pops = (showing.map { [$0] } ?? []) + rest
    queued = max(0, pops.count - 1)
    if mode != .grown { showNextPop() }
  }

  private func showNextPop() {
    popTimer?.invalidate()
    guard let next = pops.first else {
      pop = nil
      queued = 0
      setMode(collapsed == nil ? .hidden : .collapsed)
      return
    }
    pop = next
    queued = pops.count - 1
    setMode(.grown)
    holdPop()
  }

  /// Starts the shown pop's time; the pointer resting on the island stops it.
  func holdPop(paused: Bool = false) {
    popTimer?.invalidate()
    guard mode == .grown, let pop, !paused else { return }
    let seconds: Double = ["turn-ended", "routine-ended"].contains(pop.kind) ? 4 : 6
    popTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
      guard let self else { return }
      self.pops.removeFirst()
      self.showNextPop()
    }
  }

  func answered(_ message: MainMessage) {
    guard let id = message.id, let key = answers.removeValue(forKey: id) else { return }
    pending.remove(key)
    switch message.result {
    case "answered":
      show(Note(text: text("answered"), ok: true))
    case "elsewhere":
      show(Note(text: text("answeredElsewhere"), ok: true))
    default:
      show(Note(text: text("answerFailed", ["message": message.message ?? ""]), ok: false))
    }
  }

  private func show(_ next: Note) {
    note = next
    noteTimer?.invalidate()
    noteTimer = Timer.scheduledTimer(withTimeInterval: 1.2, repeats: false) { [weak self] _ in
      self?.note = nil
    }
  }

  // MARK: What the user does

  func expand(byClick: Bool) {
    guard mode != .open else {
      if byClick {
        openedByClick = true
        onModeChange?(.open)
      }
      return
    }
    openedByClick = byClick
    popTimer?.invalidate()
    pops.removeAll()
    pop = nil
    queued = 0
    // Opening shows every ended turn, so the collapsed island stops pointing at them.
    for row in rows where Self.marksDone(row) { seen.insert(seenKey(row)) }
    collapsed = Self.collapse(rows, model: self)
    now = Date()
    tick?.invalidate()
    tick = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      self?.now = Date()
    }
    setMode(.open)
    send(.expanded)
  }

  func collapse() {
    tick?.invalidate()
    tick = nil
    openedByClick = false
    selected = nil
    guard mode == .open || mode == .grown else { return }
    popTimer?.invalidate()
    pops.removeAll()
    pop = nil
    setMode(collapsed == nil ? .hidden : .collapsed)
  }

  func open(row: String?) {
    send(.open(row: row))
    collapse()
  }

  func answer(_ request: IslandRequest, option: IslandOption) {
    guard !pending.contains(request.key) else { return }
    let id = "a\(nextAnswer)"
    nextAnswer += 1
    answers[id] = request.key
    pending.insert(request.key)
    send(.answer(id: id, request: request.key, option: option.id))
  }

  func setPanelHeight(_ height: CGFloat) {
    guard abs(height - panelHeight) > 0.5 else { return }
    withAnimation(animation(from: .open, to: .open)) { panelHeight = height }
  }

  /// Moves the keyboard's row up or down through the rows the panel lists.
  func moveSelection(_ step: Int) {
    let keys = groups.flatMap { $0.rows.map(\.key) }
    guard !keys.isEmpty else { return }
    let index = selected.flatMap { keys.firstIndex(of: $0) } ?? (step > 0 ? -1 : keys.count)
    selected = keys[max(0, min(keys.count - 1, index + step))]
  }

  private func setMode(_ next: Mode) {
    guard next != mode else { return }
    let previous = mode
    withAnimation(animation(from: previous, to: next)) { mode = next }
    onModeChange?(next)
  }

  /// The springs of the hi-fi, or a short fade when the system asks for less motion.
  func animation(from: Mode, to: Mode) -> Animation {
    if reduceMotion { return .easeInOut(duration: 0.2) }
    switch to {
    case .open: return .spring(response: 0.45, dampingFraction: 0.82)
    case .grown: return .spring(response: 0.42, dampingFraction: 0.8)
    case .collapsed:
      return from == .hidden
        ? .spring(response: 0.35, dampingFraction: 0.9)
        : .spring(response: 0.36, dampingFraction: 0.95)
    case .hidden: return .spring(response: 0.35, dampingFraction: 0.95)
    }
  }
}
