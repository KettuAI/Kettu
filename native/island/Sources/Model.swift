import AppKit
import SwiftUI

/// Where the island sits and how large it may grow, from the screen it is on.
struct IslandGeometry: Equatable {
  /// The notch's width, nothing on a screen without one, where the island sits in the menu bar.
  var notchWidth: CGFloat = 196
  /// The height of the island's top band: the notch's, or the menu bar's.
  var notchHeight: CGFloat = 32
  var hasNotch = true
  var maxHeight: CGFloat = 600
}

enum Mode: Equatable {
  case hidden
  case collapsed
  case grown
  case open
}

/// What opened the island, which decides what closes it: the pointer leaving one the hover
/// opened, an answer to the last request one a request opened, and a click elsewhere any.
enum Opener {
  case hover
  case click
  case request
}

struct Pop: Equatable {
  let id: Int
  let row: String?
  let kind: String
  let title: String
  let body: String
}

/// The one fact the collapsed island adds to its signal.
enum Fact: Equatable {
  /// How many sessions: of its group, or used today while nothing else is said.
  case count(Int)
  /// How long the latest session's prompt cache stays warm; amber in its last stretch.
  case cache(String, ending: Bool)
  case plan(done: Int, total: Int)
  /// The minutes stuck, or the day a used-up limit resets.
  case word(String)
}

/// What the collapsed island shows: who it is about, the marks of its most urgent group or Kettu's
/// fox when nothing needs one, that group's signal and one fact, and the title of the session it is
/// about where no notch is in the way.
struct Collapsed: Equatable {
  let agents: [IslandAgent]
  let signal: Signal?
  let fact: Fact?
  let title: String?
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
  /// While set, the panel is laid out unseen, so the island opens straight to its height.
  @Published var measuring = false
  private(set) var opener = Opener.hover
  var openedByClick: Bool { opener == .click }
  /// Whether the pointer is over the island, which the controller keeps.
  var pointerInside = false
  /// A request popped before main's view had it; the island opens to it once it has.
  private var requestPop: (pop: Pop, timer: Timer)?
  var onModeChange: ((Mode) -> Void)?
  var onAnnounce: ((String) -> Void)?

  private var pops: [Pop] = []
  private var nextPop = 1
  private var popTimer: Timer?
  private var tick: Timer?
  private var noteTimer: Timer?
  private var stuckTimer: Timer?
  private var cacheTimer: Timer?
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

  /// The sessions the list shows, in main's order; the rest fold into one line that opens Kettu.
  var listRows: [IslandRow] { Array(rows.prefix(Metrics.listRows)) }

  /// While a request waits, or the word on one just answered shows, the panel is that card alone.
  var asking: Bool { note != nil || !requests.isEmpty }


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

  /// The collapsed island's parts as last laid out, which its width follows.
  @Published private(set) var parts: [String: CGFloat] = [:]

  func setPart(_ name: String, _ width: CGFloat) {
    guard abs((parts[name] ?? -1) - width) > 0.5 else { return }
    withAnimation(animation(from: .collapsed, to: .collapsed)) { parts[name] = width }
  }

  func status(of row: IslandRow) -> String { store.status(of: row, now: now) }

  func signal(of row: IslandRow) -> Signal? {
    switch status(of: row) {
    case "waiting", "sign_in": return .waiting
    case "failed": return .failed
    case "running": return .running(TurnDots.Pattern(phase: row.phase))
    case "starting": return .running(.think)
    case "stuck": return .stuck
    case "limited": return .limited
    case "unread": return .unread
    default: return nil
    }
  }

  /// The task requests, which wait for the user like a session's.
  var taskRequests: Int { requests.filter { $0.task != nil }.count }

  var summaryText: String {
    let s = store.summary
    var parts: [String] = []
    if s.waiting > 0 { parts.append(text("summary.waiting", ["count": "\(s.waiting)"])) }
    if s.running > 0 { parts.append(text("summary.running", ["count": "\(s.running)"])) }
    if s.failed > 0 { parts.append(text("summary.failed", ["count": "\(s.failed)"])) }
    let done = rows.filter { $0.status == "unread" }.count
    if done > 0 { parts.append(text("summary.done", ["count": "\(done)"])) }
    if parts.isEmpty, let today = s.today, today > 0 {
      parts.append(text("today", ["count": "\(today)"]))
    }
    return parts.joined(separator: " · ")
  }

  // MARK: The prompt cache

  /// How long a cache stays warm, as the island writes it, and whether it is in its last stretch;
  /// nil once it expired. The last stretch counts seconds.
  func cacheLeft(_ cache: IslandCache?) -> (text: String, ending: Bool)? {
    guard let cache else { return nil }
    let left = cache.expiresAt - now.timeIntervalSince1970 * 1000
    guard left > 0 else { return nil }
    let ending = left <= cache.endingMs
    var time: String
    if ending {
      let seconds = Int((left / 1000).rounded(.up))
      time = String(format: "%d:%02d", seconds / 60, seconds % 60)
    } else if left >= 3_600_000 {
      time = text("duration.hours", ["h": "\(Int(left / 3_600_000))"])
    } else {
      time = text("duration.minutes", ["m": "\(max(1, Int(left / 60_000)))"])
    }
    if cache.estimate { time = text("cache.about", ["time": time]) }
    return (time, ending)
  }

  /// A cache that expired within the last half hour, whose cost the focus card says once.
  func justExpired(_ cache: IslandCache?) -> Bool {
    guard let cache else { return false }
    let past = now.timeIntervalSince1970 * 1000 - cache.expiresAt
    return past >= 0 && past < 30 * 60_000
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
    if mode == .hidden { setMode(.collapsed) }
    scheduleStuckCheck(all)
    scheduleCacheTick()
    if let waiting = requestPop, !requests.isEmpty {
      waiting.timer.invalidate()
      requestPop = nil
      expand(by: .request)
    }
    settleRequest()
  }

  /// An island a request opened closes once nothing is left to answer, unless the pointer is on
  /// it, which keeps it open as a hover would.
  private func settleRequest() {
    guard mode == .open, opener == .request, !asking else { return }
    if pointerInside {
      opener = .hover
    } else {
      collapse()
    }
  }

  /// A warm cache counts down with no message from main: the island looks again when the minute
  /// it shows changes, every second in its last stretch, and when it expires. With no warm cache
  /// in view, no timer runs; while the island is open its own second's tick does this.
  private func scheduleCacheTick() {
    cacheTimer?.invalidate()
    let nowMs = now.timeIntervalSince1970 * 1000
    var wait: Double?
    for cache in rows.prefix(Metrics.listRows).compactMap(\.cache) {
      let left = cache.expiresAt - nowMs
      guard left > 0 else { continue }
      let next =
        left <= cache.endingMs
        ? 1000 - left.truncatingRemainder(dividingBy: 1000)
        : min(left - cache.endingMs, left.truncatingRemainder(dividingBy: 60_000))
      wait = min(wait ?? next, max(next, 50))
    }
    guard let wait else { return }
    cacheTimer = Timer.scheduledTimer(withTimeInterval: wait / 1000 + 0.01, repeats: false) {
      [weak self] _ in self?.refresh()
    }
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
  /// done, limited, and with none of them Kettu's fox, since the island always shows while it is
  /// on. Failed and done rows mark it until the user reads them in Kettu or opens the island, so a
  /// turn that ended while a Kettu window was in front, which pops nothing, still shows. The fact
  /// beside the signal: a count past one, the running session's plan, and at rest how long the
  /// latest session's prompt cache stays warm, else how many sessions were used today.
  private static func collapse(_ rows: [IslandRow], model: IslandModel) -> Collapsed {
    func agents(_ list: [IslandRow]) -> [IslandAgent] {
      var seen = Set<String>()
      return list.map(\.agent).filter { seen.insert("\($0.harness)/\($0.color ?? "")").inserted }
    }
    func title(_ row: IslandRow?) -> String? {
      row.map { $0.title.isEmpty ? model.text("untitled") : $0.title }
    }
    func counted(_ count: Int) -> Fact? { count > 1 ? .count(count) : nil }
    let waiting = rows.filter { $0.status == "waiting" || $0.status == "sign_in" }
    if !waiting.isEmpty || model.taskRequests > 0 {
      let count = max(model.store.summary.waiting, waiting.count + model.taskRequests)
      // It names what opening it shows: the first request's session, or a task's fox and title.
      let first = model.requests.first
      let lead = first.map { model.row($0.row) } ?? waiting.first
      return Collapsed(
        agents: lead.map { [$0.agent] } ?? [], signal: .waiting, fact: counted(count),
        title: title(lead) ?? first?.task?.title)
    }
    let unseen = rows.filter { marksDone($0) && !model.seen.contains(model.seenKey($0)) }
    let failed = unseen.filter { $0.status == "failed" }
    if !failed.isEmpty {
      return Collapsed(
        agents: agents(failed), signal: .failed, fact: counted(failed.count),
        title: title(failed.first))
    }
    let running = rows.filter { $0.status == "running" || $0.status == "starting" }
    if !running.isEmpty {
      let moving = running.filter { model.status(of: $0) != "stuck" }
      if moving.isEmpty {
        let longest = running.compactMap(\.toolSince).min()
        let minutes = longest.map { max(1, Int(model.now.timeIntervalSince1970 - $0 / 1000) / 60) }
        return Collapsed(
          agents: agents(running), signal: .stuck,
          fact: minutes.map { .word(model.text("duration.minutes", ["m": "\($0)"])) },
          title: title(running.first))
      }
      let lead = moving[0]
      let signal: Signal =
        lead.status == "starting" ? .running(.think) : .running(TurnDots.Pattern(phase: lead.phase))
      let fact: Fact? =
        lead.plan.map { .plan(done: $0.done, total: $0.total) } ?? counted(moving.count)
      return Collapsed(agents: agents(moving), signal: signal, fact: fact, title: title(lead))
    }
    let done = unseen.filter { $0.status == "unread" }
    if !done.isEmpty {
      return Collapsed(
        agents: agents(done), signal: .unread, fact: counted(done.count), title: title(done.first))
    }
    let limited = rows.filter { $0.status == "limited" }
    if !limited.isEmpty {
      let reset = limited.compactMap { $0.limit?.resetsAt }.min()
      return Collapsed(
        agents: agents(limited), signal: .limited, fact: reset.map { .word(model.resetDay($0)) },
        title: title(limited.first))
    }
    // Nothing needs a mark: Kettu's fox, and the latest session's warm cache or today's count.
    let latest = rows.first
    var fact: Fact?
    if let left = model.cacheLeft(latest?.cache) {
      fact = .cache(model.text("cache.short", ["time": left.text]), ending: left.ending)
    } else if let today = model.store.summary.today, today > 0 {
      fact = .count(today)
    }
    return Collapsed(agents: [], signal: nil, fact: fact, title: title(latest))
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
    // What needs an answer opens the island at its card, without a hint to hover first, and keeps
    // an island the pointer opened open until it is answered.
    if kind == "permission" {
      if mode == .open {
        if opener == .hover { opener = .request }
      } else {
        openForRequest(item)
      }
      return
    }
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

  /// Opens at the request once main's view has it; if it never comes, as for a request it could
  /// not read, the pop grows out as any other.
  private func openForRequest(_ item: Pop) {
    if !requests.isEmpty {
      expand(by: .request)
      return
    }
    requestPop?.timer.invalidate()
    let timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
      guard let self, let waiting = self.requestPop else { return }
      self.requestPop = nil
      self.pops.append(waiting.pop)
      if self.mode != .grown && self.mode != .open { self.showNextPop() }
    }
    requestPop = (item, timer)
  }

  private func showNextPop() {
    popTimer?.invalidate()
    guard let next = pops.first else {
      pop = nil
      queued = 0
      setMode(.collapsed)
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
    // A finished turn says so and goes; an error stays longer.
    let seconds: Double = ["turn-ended", "routine-ended"].contains(pop.kind) ? 2 : 6
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
      self?.settleRequest()
    }
  }

  // MARK: What the user does

  /// Lays the panel out unseen ahead of opening, as when the pointer comes onto the island.
  func prepare() {
    if !measuring { measuring = true }
  }

  func expand(byClick: Bool) {
    expand(by: byClick ? .click : .hover)
  }

  func expand(by cause: Opener) {
    guard mode != .open else {
      if cause == .click {
        opener = .click
        onModeChange?(.open)
      }
      return
    }
    // The panel's height is measured first, so the island grows to it in one move.
    if !measuring {
      measuring = true
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { [weak self] in
        self?.expand(by: cause)
      }
      return
    }
    opener = cause
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
    opener = .hover
    selected = nil
    measuring = false
    guard mode == .open || mode == .grown else { return }
    popTimer?.invalidate()
    pops.removeAll()
    pop = nil
    setMode(.collapsed)
  }

  func open(row: String?) {
    send(.open(row: row))
    collapse()
  }

  func open(request: IslandRequest) {
    send(.openRequest(request.key))
    collapse()
  }

  func newSession() {
    send(.newSession)
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
    guard !asking else { return }
    let keys = listRows.map(\.key)
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

  /// The hi-fi's springs, critically damped so nothing overshoots, or a short fade when the
  /// system asks for less motion.
  func animation(from: Mode, to: Mode) -> Animation {
    if reduceMotion { return .easeInOut(duration: 0.2) }
    switch to {
    case .open: return .spring(response: 0.3, dampingFraction: 1)
    case .grown: return .spring(response: 0.38, dampingFraction: 1)
    case .collapsed, .hidden: return .spring(response: 0.3, dampingFraction: 1)
    }
  }
}
